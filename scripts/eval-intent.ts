import fs from "node:fs";
import path from "node:path";
import { assertDataFilesExist, findEmailById, findTranscriptById } from "../lib/data/loaders";
import { classifyIntent } from "../lib/ingestion/context";
import { type Check, eq, printCase, printScore } from "../eval/report";

/**
 * Tier 3 — normalized intent classification eval.
 *
 * Grades the deterministic classifyIntent output (enrichment → normalized legacy
 * label → keyword fallback) against hand-labeled normalized intents. It reads
 * the committed dataset + any committed enrichment, so it needs NO LLM and NO
 * API key and is fully reproducible — it gates CI like the other tiers.
 */

type IntentCase = {
  id: string;
  kind: "email" | "call";
  record_id: string;
  description?: string;
  expected_intent: string;
};

type GoldenFile = { description: string; cases: IntentCase[] };

function checkCase(c: IntentCase): Check[] {
  const record =
    c.kind === "email" ? findEmailById(c.record_id) : findTranscriptById(c.record_id);
  if (!record) {
    return [{ label: "record found", pass: false, detail: `missing ${c.kind} ${c.record_id}` }];
  }
  return [eq(`intent(${c.record_id})`, classifyIntent(record), c.expected_intent)];
}

function main() {
  assertDataFilesExist();
  const goldenPath = path.join(process.cwd(), "eval", "intent.golden.json");
  const golden = JSON.parse(fs.readFileSync(goldenPath, "utf8")) as GoldenFile;

  console.log(`\nTier 3 — normalized intent classification eval`);
  console.log(golden.description);
  console.log();

  let passed = 0;
  for (const c of golden.cases) {
    let checks: Check[];
    try {
      checks = checkCase(c);
    } catch (err) {
      checks = [{ label: "ran without error", pass: false, detail: (err as Error).message }];
    }
    if (printCase(c.id, checks, c.description)) passed++;
  }

  const score = printScore("Tier 3 score", passed, golden.cases.length);
  if (score < 1) process.exitCode = 1;
}

main();
