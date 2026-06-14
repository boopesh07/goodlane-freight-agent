# ADR 0004 — Messy-data resolution, confidence scoring, human-in-the-loop

**Status:** Accepted

## Context
The dataset is intentionally messy: garbled/spoken MC numbers, misspelled or
spoken-out carrier names ("s m r" → SMR), mistyped load numbers, carriers who
quote the wrong load, and the same carrier appearing in both channels. A
confident wrong answer on a broker's owned relationship is worse than a handoff.

## Decision
- **Layered identifier resolution** (`lib/data/loaders.ts`, `lib/ingestion/context.ts`):
  - Carrier: MC (exact) → email (exact) → company name (exact → substring →
    **fuzzy**). Fuzzy matching tolerates legal suffixes, word order, spoken-out
    initials, and misspellings.
  - Load: exact id → **fuzzy id** recovery (digit edit-distance) for mistyped
    numbers → **structured search** by lane/equipment/rate/status when no id is
    given at all (common on calls).
- **Confidence + relaxation.** Structured load search scores each candidate
  (0–1) against the full criteria and progressively relaxes the softest filters
  (rate → status → pickup) when nothing matches. Below a threshold (0.85) it
  flags `needs_human_verification`.
- **Cross-reference validation.** Before answering, the pipeline reconciles MC vs
  email vs name and load vs carrier (lane/equipment) and surfaces every
  conflict.
- **Human-in-the-loop.** On a low-confidence match the pipeline surfaces the
  candidate *with its confidence*, flags `needs_human_verification`, and the
  recommendation asks the broker to confirm rather than quoting a rate or
  drafting a firm reply.
- **Context hygiene.** On ingestion, prior email history is scoped strictly to
  the same load or carrier — it never falls back to "all emails", keeping
  unrelated carriers out of the model's context.

## Consequences
- The messy-data handling is deterministic where it can be (matching, scoring)
  and unit-tested, feeding clean, scoped inputs to any downstream LLM step (the
  draft reply and the free-query chat agent).
- Ambiguity becomes an explicit, auditable handoff instead of a confident guess.
