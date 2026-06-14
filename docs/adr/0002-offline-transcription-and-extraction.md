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
  → `lib/extraction/`). An LLM (`gpt-4o-mini`, Zod-validated via
  `ScoredCallExtractionSchema`, retry-once) reads each diarized transcript and
  writes an `extracted` block onto each record: `mc_number`, `company_name`,
  `load_reference`, `carrier_rate_usd` vs `dispatcher_rate_usd`, `equipment`,
  availability, and open `questions`.
- **Every field carries a confidence (0–1) and an evidence quote.** The model
  emits `extraction_flags` (`multiple_rates`, `mc_corrected_or_ambiguous`,
  `speaker_unclear`, `load_id_uncertain`, `cross_talk`) when a call is messy, and
  we derive `extraction_warnings` from low-confidence fields so downstream code
  knows when to distrust a value. Extraction is LLM-only; the prompt
  (`lib/extraction/prompt.ts`) carries the handling for spoken formats —
  digit-by-digit MC numbers, mid-sentence self-corrections (use the last stated
  value), and spoken state abbreviations.
- **Speaker attribution drives rate extraction.** The prompt has the model
  identify which diarized speaker is the carrier and take `carrier_rate_usd` only
  from their speech; the dispatcher's posted/anchor rate is captured separately as
  context.

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
