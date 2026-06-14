# ADR 0003 — Curated typed tools, no raw query surface, no vector store in v1

**Status:** Accepted

## Context
The agent reasons over **untrusted carrier text** (emails and transcripts). It
needs to retrieve relevant context and support tool calls. We also considered a
vector store for semantic retrieval.

## Decision
- **Every tool is a typed function (Zod params) over the in-memory loaders.** The
  model is never given a generic `query`/`execute` tool or raw file/DB access.
  This keeps retrieval testable and makes the "cite a real id" guardrail
  enforceable. Six tools: `get_load`, `get_carrier_profile`, `get_rate_history`,
  `get_email_history`, `get_transcript`, `draft_email`.
- **`draft_email` never sends.** It returns a structured draft (subject + body +
  `status: "draft (not sent)"`). A human always reviews and sends.
- **No vector store in v1.** Every core question (best rate, availability,
  timeline, compliance) is a structured lookup by id/lane/timestamp. Open-ended
  semantic search is a clean, isolated upgrade (add an embeddings index + a
  `semantic_search` tool) but is not load-bearing for the brief.

## Consequences
- Retrieval surface is small, typed, and unit-testable.
- Semantic search over paraphrased queries is weaker than embeddings would be;
  the upgrade path is isolated.
