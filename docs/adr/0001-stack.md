# ADR 0001 — Stack: Next.js + Vercel + OpenAI, flat-file data store

**Status:** Accepted

## Context
We need a deployed, production-grade MVP web app with an AI agent over a small,
intentionally-messy freight dataset (274 emails, 48 carriers, 50 loads, 720 rate
rows, 55 calls). Time budget is a few hours; the brief explicitly does not want
polished UI or scaling infrastructure.

## Decision
- **Next.js 14 (App Router) + TypeScript on Vercel.** One repo holds the UI and
  the agent API route; one deploy target; one language across app + scripts.
- **Flat-file data store** read directly from disk and cached in memory
  (`lib/data/loaders.ts`). The provided dataset *is* the source of truth; we read
  the JSON/CSV files the brief shipped, plus `data/transcripts.json` produced by
  the offline transcription/extraction pipeline.
- **OpenAI** for the agent (`gpt-4o`), extraction (`gpt-4o-mini`), and
  transcription (`gpt-4o-transcribe-diarize`), isolated behind `lib/model.ts` so
  the provider is swappable.

## Why flat files over a database
- **Deterministic:** the eval and unit tests read the *same* files the agent
  uses — no seed/migrate drift between what's tested and what's served.
- **Simpler & faster to ship:** no Supabase project, schema, migrations, or seed
  step for ~1k records that fit comfortably in memory.
- **Safer:** the agent reaches data only through typed tools (ADR 0003); there is
  no SQL surface to inject against.
- **Deploy-portable:** `lib/data/paths.ts` resolves `DATA_DIR` /
  `TRANSCRIPTS_PATH` from env with sane defaults, so the same code runs locally
  and on Vercel by bundling the data files.

## Consequences
- Everything is TypeScript; no Python/GPU/DB to operate.
- This does not scale to large/relational datasets — that would warrant Postgres
  (or a vector store for semantic retrieval), a clean, isolated upgrade if needed.
- Vendor lock to OpenAI is mitigated by the `lib/model.ts` adapter.
