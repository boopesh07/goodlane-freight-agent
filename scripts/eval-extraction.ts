import fs from "node:fs";
import path from "node:path";
import {
  assertDataFilesExist,
  companyNameSimilarity,
  findTranscriptById,
  loadTranscripts,
  normalizeMc,
} from "../lib/data/loaders";
import { extractCall } from "../lib/extraction/llm";
import type { CallExtraction } from "../lib/data/types";
import { pct, rule } from "../eval/report";

/**
 * Tier 2 — call-extraction field accuracy.
 *
 * Grades the structured fields the extractor pulls from each diarized call
 * against a hand-labeled golden set. By default it grades the COMMITTED
 * extractions in data/transcripts.json (deterministic, no API key — CI safe);
 * pass `--live` to re-run the LLM extractor and grade fresh output.
 *
 * This is deliberately distinct from the agent eval: it isolates extraction
 * quality (the messy-data problem) from retrieval/reasoning, and it surfaces a
 * real weakness — spoken multi-digit load numbers are frequently garbled.
 */

const COMPANY_SIMILARITY_THRESHOLD = 0.8;

type Gold = Partial<Record<keyof CallExtraction, string | number | null>>;
type GoldCase = { call_id: string; note?: string; gold: Gold };
type GoldenFile = {
  description: string;
  thresholds: { overall: number; fields?: Record<string, number> };
  cases: GoldCase[];
};

const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

function norm(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** Field-aware correctness. Returns true if the extracted value matches gold. */
function fieldCorrect(field: keyof CallExtraction, gold: string | number | null, got: unknown): boolean {
  if (gold === null) return got === null || got === undefined;
  if (got === null || got === undefined) return false;

  switch (field) {
    case "mc_number":
      return normalizeMc(String(got)) === normalizeMc(String(gold));
    case "carrier_rate_usd":
    case "dispatcher_rate_usd":
      return Number(got) === Number(gold);
    case "load_reference":
      return String(got).trim() === String(gold).trim();
    case "company_name":
      return companyNameSimilarity(String(gold), String(got)) >= COMPANY_SIMILARITY_THRESHOLD;
    case "equipment": {
      const a = norm(String(gold));
      const b = norm(String(got));
      return a === b || a.includes(b) || b.includes(a);
    }
    case "origin_state":
    case "destination_state":
      return String(got).toUpperCase() === String(gold).toUpperCase();
    default:
      return String(got) === String(gold);
  }
}

async function extractionFor(callId: string, live: boolean): Promise<CallExtraction | null> {
  const call = findTranscriptById(callId);
  if (!call) return null;
  if (live) {
    const { data } = await extractCall(call.transcript);
    return data;
  }
  return call.extracted ?? null;
}

async function main() {
  assertDataFilesExist();
  const live = process.argv.includes("--live");
  if (live && !process.env.OPENAI_API_KEY) {
    console.error("--live requires OPENAI_API_KEY.");
    process.exit(1);
  }
  // Touch the store so a missing file fails fast with a clear message.
  loadTranscripts();

  const goldenPath = path.join(process.cwd(), "eval", "extraction.golden.json");
  const golden = JSON.parse(fs.readFileSync(goldenPath, "utf8")) as GoldenFile;

  console.log(`\nTier 2 — call extraction field accuracy ${live ? "(LIVE re-extraction)" : "(stored extractions)"}`);
  console.log(golden.description);
  console.log();

  const fieldTally: Record<string, { correct: number; total: number }> = {};
  let totalCorrect = 0;
  let totalLabeled = 0;

  for (const c of golden.cases) {
    const extracted = await extractionFor(c.call_id, live);
    const fields = Object.keys(c.gold) as (keyof CallExtraction)[];
    const parts: string[] = [];
    for (const field of fields) {
      const correct = extracted ? fieldCorrect(field, c.gold[field] as never, extracted[field]) : false;
      fieldTally[field] ??= { correct: 0, total: 0 };
      fieldTally[field].total++;
      totalLabeled++;
      if (correct) {
        fieldTally[field].correct++;
        totalCorrect++;
        parts.push(`${GREEN}${field}✓${RESET}`);
      } else {
        const got = extracted ? JSON.stringify(extracted[field]) : "(no extraction)";
        parts.push(`${RED}${field}✗${RESET}${DIM}(want ${JSON.stringify(c.gold[field])}, got ${got})${RESET}`);
      }
    }
    console.log(`  ${c.call_id}  ${parts.join("  ")}`);
  }

  console.log(`\n${rule()}\nPer-field accuracy`);
  let fieldGateFailed = false;
  const fieldThresholds = golden.thresholds.fields ?? {};
  for (const [field, t] of Object.entries(fieldTally).sort()) {
    const acc = t.correct / t.total;
    const min = fieldThresholds[field];
    const gated = min !== undefined && acc < min;
    if (gated) fieldGateFailed = true;
    const color = acc === 1 ? GREEN : acc >= 0.8 ? "" : RED;
    const minNote = min !== undefined ? `${DIM} (gate ${pct(min)})${RESET}` : "";
    console.log(`  ${field.padEnd(20)} ${color}${pct(acc)}${RESET} (${t.correct}/${t.total})${minNote}`);
  }

  const overall = totalCorrect / totalLabeled;
  const overallPass = overall >= golden.thresholds.overall && !fieldGateFailed;
  console.log(rule());
  const color = overallPass ? GREEN : RED;
  const verdict = overallPass ? `${GREEN}PASS${RESET}` : `${RED}FAIL${RESET}`;
  console.log(
    `Tier 2 overall accuracy: ${color}${totalCorrect}/${totalLabeled} (${pct(overall)})${RESET}` +
      `  ${DIM}gate ≥ ${pct(golden.thresholds.overall)}${RESET}  ${verdict}`,
  );

  if (!overallPass) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
