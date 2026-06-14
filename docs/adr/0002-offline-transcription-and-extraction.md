# ADR 0002 — Offline diarized transcription + call-side extraction

**Status:** Accepted

## Context
Carriers reach us by email and by recorded call. Emails arrive already
structured in `carrier_emails.json`. Calls are raw `.wav` audio, so we must
(1) transcribe them and (2) extract structured fields (carrier identity, rate,
equipment, load reference). None of this should happen in the user's request
path.

Rate-negotiation calls in particular exchange **many** dollar figures between the
Goodlane dispatcher and the carrier ("we posted $X" … "I can't do less than $Y").
Picking the *carrier's own* offer — and therefore the correct best quote —
requires knowing **who said which number**.

## Decision
- **Transcription is offline and one-time** (`scripts/transcribe.ts`), using
  OpenAI `gpt-4o-transcribe-diarize` with `response_format: "diarized_json"` and
  `chunking_strategy: "auto"`. We persist speaker-tagged transcripts (`[A] … /
  [B] …`) plus the raw segment array to `data/transcripts.json`. The deployed app
  and CI never touch the `.wav` files.
- **Call-side extraction is a separate offline step** (`scripts/extract-calls.ts`
  → `lib/extraction/`). It runs an LLM (`gpt-4o-mini`, Zod-validated, retry-once)
  over each diarized transcript and writes an `extracted` block onto each record:
  `mc_number`, `company_name`, `load_reference`, `carrier_rate_usd` vs
  `dispatcher_rate_usd`, `equipment`, availability, and open `questions`.
- **Deterministic parsers ground the extraction** (`lib/extraction/parsers.ts`):
  `$`-amount detection and spoken-MC normalization (digit-by-digit spelling,
  dashes, mid-sentence corrections) are pure, unit-tested functions that feed the
  prompt as anchors and flag `multiple_rates` / `mc_corrected_or_ambiguous`.
- **Speaker attribution drives rate extraction.** The extractor identifies which
  speaker label is the carrier and takes `carrier_rate_usd` only from their
  speech; the dispatcher's posted rate is captured separately as context.

## Why diarization
The accuracy win is on *rate attribution*: with multiple numbers per call,
mis-attributing the dispatcher's anchor to the carrier corrupts the "best rate"
answer. Diarization stays single-vendor (still just OpenAI), adds no second API
key, so the win is essentially free.

## Consequences
- No per-request audio cost; transcripts and extracted fields are reviewable in
  version control and consumed by the agent via `get_transcript`.
- Extraction quality is fixed at ingestion time and therefore inspectable and
  testable, rather than varying per query.
