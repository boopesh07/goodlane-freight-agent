# ADR 0006 — Deterministic intake pipeline; LLM only extracts and drafts

**Status:** Accepted (supersedes the LLM-agent ingestion path)

## Context
The first cut processed an inbound email/call by handing a large pre-fetched
context block to an LLM agent and letting it reason out the timeline, best rate,
and recommendation. Two problems:

1. **Context pollution.** History was scoped with "same load OR same carrier",
   which for a carrier active on many loads dragged their entire cross-load
   history into the prompt (e.g. CE0063 pulled 18 emails across 9 loads when only
   4 were about the inquiry's load).
2. **The LLM was reasoning over facts** — computing "best rate", deciding the
   recommendation — which is exactly where hallucination risk lives.

## Decision
Make intake a **deterministic pipeline** (`lib/intake/pipeline.ts`). The LLM is
restricted to the two language-shaped tasks:

- **Extraction** — call audio → structured fields (offline, ADR 0002). Emails
  already arrive structured in the dataset.
- **Drafting** — the reply email's prose, generated strictly from the facts the
  pipeline already retrieved (`lib/intake/draft.ts`), with explicit instructions
  not to invent any rate/load/carrier.

Stages 2–4 are plain code over the typed tools:

1. **Extract** structured fields from the inbound record.
2. **Enrich** — resolve carrier (MC → email → fuzzy name) and load (exact id →
   fuzzy id → structured lane/equipment search), each with a confidence.
3. **Validate** — cross-reference MC vs email vs name and load ↔ carrier; flag
   low-confidence matches for human confirmation.
4. **Answer** — assemble a load-scoped timeline, the best offer (rate math),
   compliance flags, and a rule-based recommendation.

**Tight scoping (the CE0063 fix):** when a load is resolved, prior activity is
the **load thread only** (every carrier's emails/calls on that load); the
carrier's unrelated cross-load history is excluded. Only with no load do we fall
back to carrier-scoped history. Offers and the timeline use the same rule, so a
carrier's other-load offers never leak into this load's "best rate".

## Consequences
- **No hallucinated facts** — every number/id/carrier in the answer came from a
  deterministic lookup; the LLM only phrases the reply.
- **Testable** — the pipeline is pure and unit-tested (incl. the CE0063 scoping
  regression and the call_013 structured-match-needs-confirmation case).
- **Auditable** — the UI shows resolution method + confidence, cross-reference
  flags, and the exact scoped records behind the recommendation.
- **One code path.** `/api/intake` runs this pipeline directly (no LLM, no API
  key — it just streams the retrieval steps for the UI); `/api/draft` runs the
  same pipeline and then adds the single drafting LLM call. The Tier 1 eval and
  unit tests exercise this exact path, so what's tested is what ships.
- A free-query agent (`/api/chat`) is kept for ad-hoc questions and satisfies the
  "AI agent with tool calls" requirement; it uses the same typed tools and is
  instructed to answer only from tool results.
- Trade-off: rule-based recommendations are less flexible than free LLM
  reasoning, but for a broker's owned relationships, predictable + auditable beats
  clever. New intents are added as new rules.
