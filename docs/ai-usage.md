# AI-native engineering notes

This project was built AI-natively with Claude Code. Notes for the walkthrough:

- **Spec-first, validated against the real data.** Quantitative claims about the
  dataset (counts, which fields are null, multi-`$` counter-offer bodies, garbled
  spoken MC numbers, carriers appearing in both channels) were checked against the
  files before building, not assumed.
- **AI in the product, kept out of decisions that must be deterministic.**
  - *In the product:* the free-query agent (`gpt-4o`) reasons over tool results;
    offline call extraction and the on-demand draft reply (`gpt-4o-mini`) handle
    the language-shaped work; transcription uses `gpt-4o-transcribe-diarize`.
  - *Deterministic & unit-tested:* carrier/load resolution, fuzzy matching, MC
    digit-normalization, load-match confidence scoring, cross-reference
    validation, and the whole intake pipeline (incl. the recommendation) are pure
    functions. The LLM extracts and drafts; it never invents ids/rates, decides
    the recommendation, or authors a raw query.
- **Diarization was a deliberate call** (ADR 0002): rate negotiations exchange
  many numbers, and attributing each to the correct speaker is what makes the
  "best quote" answer correct.
- **Messy-data handling is the core of the build** (ADR 0004): layered identifier
  resolution, structured load search when no id is given, confidence scores, and
  a human-in-the-loop handoff when confidence is low. Rationale for each major
  choice lives in `docs/adr/`.
- **AI tooling used:** Claude Code for implementation, refactoring, test
  authoring, and the audit/cleanup pass that produced the current flat-file
  architecture. The transcription/extraction scripts and eval harness were
  written and run with AI assistance, then verified by reading the outputs
  (e.g. confirming call_013 extracts the carrier's $480 ask, not the dispatcher's
  $440 post).
- **Built and verified in increments:** typecheck + lint + unit tests (`vitest`)
  + two deterministic eval tiers + `next build` gate every change.

## How the pieces map to the brief

| Requirement | Where |
|---|---|
| Multi-modal ingestion | `scripts/transcribe.ts`, `scripts/extract-calls.ts`, `lib/data/loaders.ts` |
| Structured extraction (both sources) | emails: dataset fields; calls: `lib/extraction/` → `data/transcripts.json` |
| Retrieval + ≥1 tool call | `lib/agent/tools.ts` (6 tools), `lib/ingestion/context.ts` |
| Draft a response email | `lib/intake/draft.ts` + `draft_email` tool |
| Eval + score | `scripts/eval-intake.ts` (9/9), `scripts/eval-extraction.ts` (96%) |
| Quality checks | `.github/workflows/ci.yml`, `vitest`, ESLint, `tsc`, `next build` |
