# Goodlane Freight Agent

AI intake assistant for freight brokers. It ingests inbound carrier activity from
**two channels — email and recorded calls** — reconstructs a timeline, and
recommends the broker's next step. The agent reads the provided dataset directly
from disk and uses curated, typed tools to retrieve context, reconcile messy
identifiers, and draft replies.

> **Live demo:** https://goodlane-freight-agent.vercel.app

## Architecture

```
goodlane-interview-dataset/   ← emails, profiles, loads, rate history (source of truth)
data/transcripts.json         ← diarized call transcripts + extracted structured fields
scripts/transcribe.ts         ← OFFLINE: WAV → diarized transcript (gpt-4o-transcribe-diarize)
scripts/extract-calls.ts      ← OFFLINE: transcript → structured fields (gpt-4o-mini)
lib/extraction/               ← deterministic parsers + LLM call extractor (+ tests)
lib/data/loaders.ts           ← parse JSON/CSV on demand (cached); fuzzy match + load search
lib/ingestion/context.ts      ← intent classify, identifier extract, cross-reference, scoping
lib/agent/tools.ts            ← six agent tools
lib/agent/prompt.ts           ← system prompt (classify → extract → resolve → validate)
app/api/chat/route.ts         ← streaming agent (Vercel AI SDK)
app/page.tsx                  ← minimal chat UI (3 modes + tool-call trace)
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

### Agent tools

| Tool | Source | Behavior |
|------|--------|----------|
| `get_load` | `loads.csv` | Exact id → fuzzy id (misspellings) → **structured search** by lane/equipment/rate when no id, with a **confidence score** + human-verification flag |
| `get_carrier_profile` | `carrier_profiles.json` | MC → email → company name (exact → substring → **fuzzy**) |
| `get_rate_history` | `rate_history.csv` | Rows with `week_start` **before** `before_timestamp` |
| `get_email_history` | `carrier_emails.json` | Emails **before** `before_timestamp`, filterable by MC/load/sender |
| `get_transcript` | `data/transcripts.json` | Diarized text **plus pre-extracted structured fields** |
| `draft_email` | — | Compose a reply (quote a rate / confirm next steps). Returns a **draft only — never sent** |

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

The repo already ships `data/transcripts.json`, so the app runs without an API
key for the data; the key is needed for the agent, eval, and re-running the
offline pipeline.

### UI modes

1. **Email ingestion** — pick an email, click **Process inbound email**. History
   is scoped to that load/carrier and collected strictly **before** its timestamp.
2. **Call ingestion** — pick a transcript, click **Process inbound call**.
3. **Free query** — ask anything with an optional as-of timestamp.

The dataset timeline chart shows all emails, calls, and rate-history weeks; during
ingestion a red cutoff line marks the ingested record's timestamp. Each agent
answer includes a collapsible **tool-call trace** showing the data it retrieved.

## Scripts

```bash
npm run test           # unit tests (loaders, ingestion, extraction parsers, tools)
npm run typecheck
npm run lint
npm run build
npm run eval           # LLM eval against eval/golden.json (needs OPENAI_API_KEY)

# offline pipeline (needs OPENAI_API_KEY; outputs committed to data/transcripts.json)
npm run transcribe     # WAV → diarized transcripts
npm run extract:calls  # transcripts → structured fields  (--force to re-extract)
```

## Eval

`eval/golden.json` holds three core workflows — timeline reconstruction,
best-rate retrieval, and drafting a reply — run by `scripts/eval.ts` against the
live agent. Each case asserts the answer mentions key facts **and** that the
expected tools were called. Current score: **3/3 (100%)**. See
[ADR 0005](docs/adr/0005-eval.md) for what I'd improve next (compliance/low-
confidence cases, an extraction-level eval, LLM-judge grading).

## Deploy

Deployed on Vercel. Set `OPENAI_API_KEY` (and optionally the model/`DATA_DIR`/
`TRANSCRIPTS_PATH` overrides). `goodlane-interview-dataset/` and
`data/transcripts.json` are committed, so they ship with the build.
