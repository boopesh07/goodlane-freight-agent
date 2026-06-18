# ADR 0007 — Normalized intent as an offline enrichment layer

**Status:** Accepted

## Context
Intent is classified by `classifyIntent` (`lib/ingestion/context.ts`). Two
problems surfaced on inspection of the real data:

1. **The keyword classifier was effectively dead code.** It only ran when an
   email's `intent` was null or a call's `type` was `unknown` — but **all 274
   emails carry a non-null `intent`** and **all 55 calls carry a real `type`**,
   so the brittle keyword regex never actually executed.
2. **The two channels use different, inconsistent vocabularies.** Emails ship
   `{info, counter, inquiry, terse, confirm}` (and `terse` is a *writing style*,
   not an intent); calls ship `{rate_negotiation, availability_check,
   compliance_check, load_details, voicemail}`. A cross-channel question like
   "which carriers are negotiating rate on load X?" can't be answered
   consistently when an email counter is `counter` and a call is
   `rate_negotiation`.

The real win, therefore, is **normalization**, not "replace the regex."

## Decision
- **One normalized taxonomy** (`lib/ingestion/intent.ts`): `rate_negotiation`,
  `availability_check`, `compliance_check`, `load_details`,
  `booking_confirmation`, `general_inquiry`, `voicemail`.
- **Intent is computed offline, like transcription/extraction (ADR 0002),** and
  committed:
  - **Calls** — add an `intent` field (value + confidence + evidence) to the
    existing call extractor (`lib/extraction/`), persisted on each record in
    `data/transcripts.json` via `npm run extract:calls`.
  - **Emails** — a new `npm run enrich:emails` classifies each email and writes a
    **separate** `data/email_enrichment.json` keyed by `email_id`. The provided
    `goodlane-interview-dataset/carrier_emails.json` is **not mutated** — derived
    data stays out of the source of truth (ADR 0001). The loaders merge it on read.
- **`classifyIntent` precedence:** enriched classification → normalized legacy
  label → **keyword classifier** (now a genuine, deterministic fallback rather
  than dead code).
- **Eval:** Tier 3 (`eval/intent.golden.json`, `scripts/eval-intent.ts`) grades
  `classifyIntent` against hand-labeled normalized intents — deterministic, no
  key, CI-gated like the other tiers (ADR 0005).

## Consequences
- **Runtime stays deterministic and key-free.** The LLM runs offline; the app
  reads committed fields, and the keyword fallback keeps everything working (and
  the eval green) even before the enrichment files are generated.
- **Cross-channel intent is now consistent and answerable.**
- **The provided dataset stays pristine**; enrichment is a reviewable, versioned
  artifact in `data/`.
- Trade-off: a generated enrichment can drift from the source if emails change —
  `enrich:emails` is idempotent and re-runnable (`--force`) to re-sync.
