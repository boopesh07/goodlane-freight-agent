# Goodlane Freight Agent

AI intake assistant for freight brokers. It processes inbound carrier activity
from **two channels — email and recorded calls** — resolves the carrier and load
against the data, reconstructs a timeline, and recommends the broker's next step.

> **Live demo:** https://goodlane-freight-agent.vercel.app

## Design principle — the LLM extracts and drafts; code decides

The intake workflow is a **deterministic pipeline**. The LLM is used for exactly
two things, both where natural language is the hard part:

1. **Extraction** — turning messy call audio into structured fields (offline).
2. **Drafting** — writing the reply email's prose from already-retrieved facts.

Everything else — retrieval, carrier/load resolution, cross-reference
validation, rate math, the timeline, and the recommendation — is **plain code
over typed data tools**. So the system answers only from retrieved facts and
never hallucinates a rate, load, or carrier. (See [ADR 0006](docs/adr/0006-deterministic-intake-pipeline.md).)

```
inbound email / call
   │
   ▼  1. EXTRACT   email fields (dataset) · call fields (LLM, offline)
   ▼  2. ENRICH    resolve carrier (MC→email→fuzzy name) + load (id→fuzzy→structured search)   [tools]
   ▼  3. VALIDATE  cross-reference MC vs email vs name, load↔carrier, confidence + flags        [code]
   ▼  4. ANSWER    load-scoped timeline, best offer, compliance, recommendation                 [code]
   ▼  5. DRAFT     reply email grounded strictly in the facts above            (LLM, on demand)
```

## Architecture

```
goodlane-interview-dataset/   ← emails, profiles, loads, rate history (source of truth)
data/transcripts.json         ← diarized call transcripts + extracted structured fields
scripts/transcribe.ts         ← OFFLINE: WAV → diarized transcript (gpt-4o-transcribe-diarize)
scripts/extract-calls.ts      ← OFFLINE: transcript → structured fields (gpt-4o-mini)
lib/extraction/               ← deterministic parsers + LLM call extractor (+ tests)
lib/data/loaders.ts           ← parse JSON/CSV on demand (cached); fuzzy match + load search
lib/ingestion/context.ts      ← identifier extraction, resolution, cross-reference (shared, deterministic)
lib/intake/pipeline.ts        ← the deterministic intake pipeline (extract→enrich→validate→answer)
lib/intake/draft.ts           ← LLM reply draft, grounded in pipeline facts
lib/agent/tools.ts            ← six typed tools (also used by the free-query agent)
app/api/intake/route.ts       ← deterministic intake (no LLM)
app/api/draft/route.ts        ← LLM reply draft
app/api/chat/route.ts         ← free-query agent (Vercel AI SDK) for ad-hoc questions
app/page.tsx                  ← UI: email/call intake views + free-query agent
```

Architecture decisions are recorded in [`docs/adr/`](docs/adr); AI-tool usage in
[`docs/ai-usage.md`](docs/ai-usage.md).

### Multi-modal ingestion

- **Emails** arrive structured in `carrier_emails.json` (MC, rate, equipment,
  load reference, intent) and are parsed/normalized by `lib/data/loaders.ts`.
- **Calls** are raw audio. Two offline steps turn them into structured data the
  agent can reason over:
  1. `npm run transcribe` — diarized speech-to-text (speaker-tagged). Diarization
     lets us attribute each spoken dollar amount to the carrier vs. the dispatcher
     (see [ADR 0002](docs/adr/0002-offline-transcription-and-extraction.md)).
  2. `npm run extract:calls` — LLM extraction of `mc_number`, `company_name`,
     `load_reference`, `carrier_rate_usd` vs `dispatcher_rate_usd`, `equipment`,
     availability, and open `questions`, grounded by deterministic parsers
     (`$`-amount detection, spoken-MC normalization with correction handling).

Both outputs land in `data/transcripts.json`, committed so the deployed app and
CI never touch audio.

### Why file-backed tools?

- **Deterministic** — eval and tests read the same files the agent uses.
- **Simple** — no DB seed/migrate cycle for ~1k records (see [ADR 0001](docs/adr/0001-stack.md)).
- **Safe** — the model never authors a query; it only calls typed tools.

### Retrieval tools

The pipeline and the free-query agent share the same typed data tools:

| Tool | Source | Behavior |
|------|--------|----------|
| `get_load` | `loads.csv` | Exact id → fuzzy id (misspellings) → **structured search** by lane/equipment/rate when no id, with a **confidence score** + human-verification flag |
| `get_carrier_profile` | `carrier_profiles.json` | MC → email → company name (exact → substring → **fuzzy**) |
| `get_rate_history` | `rate_history.csv` | Rows with `week_start` **before** `before_timestamp` |
| `get_email_history` | `carrier_emails.json` | Emails **before** `before_timestamp`, filterable by MC/load/sender |
| `get_transcript` | `data/transcripts.json` | Diarized text **plus pre-extracted structured fields** |
| `draft_email` | — | Compose a reply (quote a rate / confirm next steps). Returns a **draft only — never sent** |

### Context scoping (no unwanted emails)

When the load is resolved, prior activity is scoped to the **load thread** —
every carrier's emails/calls on *that* load (relevant for best-rate), never the
carrier's unrelated cross-load history. Only when no load can be resolved does it
fall back to the carrier's own history. This keeps the timeline focused on the
inquiry at hand.

### Handling the intentional messiness

Garbled/spoken MC numbers, misspelled or spoken-out carrier names, mistyped load
numbers, carriers quoting the wrong load, and carriers in both channels are
handled by layered fuzzy resolution, structured load search with confidence
scoring, MC-vs-email-vs-name cross-referencing, and a human-in-the-loop handoff
when confidence is low (see [ADR 0004](docs/adr/0004-messy-data-and-human-in-the-loop.md)).

## Setup

```bash
npm install
cp .env.example .env.local   # add OPENAI_API_KEY
npm run dev                  # http://localhost:3000
```

The repo already ships `data/transcripts.json`, so intake runs without an API
key. The key is only needed for the **draft reply**, the **free-query agent**,
and re-running the **offline** transcription/extraction pipeline.

### UI modes

1. **Email ingestion** — pick an email, click **Process inbound email**. Renders
   the deterministic result: resolved carrier + load (with confidence),
   compliance, cross-reference checks, a load-scoped timeline, best offer, and a
   recommendation. **Draft reply email** generates a grounded draft on demand.
2. **Call ingestion** — same, for a call transcript.
3. **Free query** — ad-hoc questions answered by the tool-using agent (with a
   collapsible **tool-call trace** showing exactly what data it retrieved).

The dataset timeline chart shows all emails, calls, and rate-history weeks; a red
cutoff line marks the selected record's timestamp.

## Scripts

```bash
npm run test           # unit tests (loaders, intake pipeline, extraction schemas, tools)
npm run typecheck
npm run lint
npm run build

# evals (see below) — both deterministic, no API key, gated in CI
npm run eval             # both tiers (intake pipeline + extraction accuracy)
npm run eval:intake      # Tier 1 — deterministic intake pipeline
npm run eval:extraction  # Tier 2 — extraction field accuracy (--live to re-extract via LLM)

# offline pipeline (needs OPENAI_API_KEY; outputs committed to data/transcripts.json)
npm run transcribe     # WAV → diarized transcripts
npm run extract:calls  # transcripts → structured fields  (--force to re-extract)
```

## Eval

Two deterministic tiers, each isolating a different failure mode (see
[ADR 0005](docs/adr/0005-eval.md)):

| Tier | What it grades | Determinism | Current score |
|------|----------------|-------------|---------------|
| **1 — intake pipeline** (`eval/intake.golden.json`) | The **real production pipeline** over labeled email/call records: carrier+load resolution, confidence/human-verification, compliance, validation, best offer, recommendation | Deterministic · **CI-gated** · no key | **9/9** |
| **2 — extraction** (`eval/extraction.golden.json`) | Per-field accuracy of call extraction vs hand-labeled truth (normalization-aware) | Deterministic · **CI-gated** · no key (`--live` re-runs the LLM) | **96%** overall; `load_reference` **60%** (honest weakness) |

Because intake is now fully deterministic, **Tier 1 grades exactly the code path
the app runs** — the same `runEmailIntake`/`runCallIntake` behind `/api/intake`.
The 9 cases cover the happy path **and** the messy/negative paths the brief cares
about: low-confidence matches, fuzzy-id recovery, compliance blocks, name-only
resolution, and best-rate retrieval. Tier 2 deliberately surfaces a real
weakness — the extractor garbles spoken multi-digit load numbers
(`load_reference` 60%); the pipeline recovers via fuzzy-id matching (proven by
Tier 1). See ADR 0005 for what I'd improve next.

## Deploy

Deployed on Vercel. Set `OPENAI_API_KEY` (and optionally the model/`DATA_DIR`/
`TRANSCRIPTS_PATH` overrides). `goodlane-interview-dataset/` and
`data/transcripts.json` are committed, so they ship with the build.
