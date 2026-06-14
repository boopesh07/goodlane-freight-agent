import fs from "node:fs";
import path from "node:path";
import { assertDataFilesExist } from "../lib/data/loaders";
import { runCallIntake, runEmailIntake, type IntakeResult } from "../lib/intake/pipeline";
import { type Check, eq, printCase, printScore } from "../eval/report";

/**
 * Tier 1 — deterministic intake-pipeline eval.
 *
 * Runs the REAL pipeline (the same code the /api/intake route assembles) over a
 * labeled golden set and asserts the structured outputs the broker depends on.
 * It uses the synchronous entry points that read the committed dataset +
 * transcripts, so it needs NO LLM and NO API key and is fully reproducible —
 * which is exactly why it's the eval we gate CI on.
 */

type IntakeExpect = {
  intent?: string;
  carrier_company?: string | null;
  carrier_matched_by?: string;
  load_id?: string | null;
  load_matched_by?: string;
  load_status?: string;
  needs_human_verification?: boolean;
  min_confidence?: number;
  best_offer_usd?: number | null;
  best_offer_carrier_includes?: string;
  compliance_severities?: string[];
  compliance_includes?: string[];
  validation_includes?: string[];
  recommendation_includes?: string[];
  recommendation_excludes?: string[];
  scope?: IntakeResult["scope"];
  min_timeline?: number;
};

type IntakeCase = {
  id: string;
  kind: "email" | "call";
  record_id: string;
  description?: string;
  expect: IntakeExpect;
};

type GoldenFile = { description: string; cases: IntakeCase[] };

function includesCI(haystack: string, needle: string): boolean {
  return haystack.toLowerCase().includes(needle.toLowerCase());
}

function checkCase(c: IntakeCase): Check[] {
  const r = c.kind === "email" ? runEmailIntake(c.record_id) : runCallIntake(c.record_id);
  const e = c.expect;
  const checks: Check[] = [];

  if (e.intent !== undefined) checks.push(eq("intent", r.intent, e.intent));
  if (e.carrier_company !== undefined)
    checks.push(eq("carrier.company", r.carrier.profile?.company_name ?? null, e.carrier_company));
  if (e.carrier_matched_by !== undefined)
    checks.push(eq("carrier.matchedBy", r.carrier.matchedBy, e.carrier_matched_by));
  if (e.load_id !== undefined) checks.push(eq("load.id", r.load.load?.load_id ?? null, e.load_id));
  if (e.load_matched_by !== undefined) checks.push(eq("load.matchedBy", r.load.matchedBy, e.load_matched_by));
  if (e.load_status !== undefined) checks.push(eq("load.status", r.load.load?.status ?? null, e.load_status));
  if (e.needs_human_verification !== undefined)
    checks.push(eq("load.needsHumanVerification", r.load.needsHumanVerification, e.needs_human_verification));
  if (e.scope !== undefined) checks.push(eq("scope", r.scope, e.scope));

  if (e.min_confidence !== undefined)
    checks.push({
      label: `load.confidence ≥ ${e.min_confidence}`,
      pass: r.load.confidence >= e.min_confidence,
      detail: `got ${r.load.confidence}`,
    });

  if (e.best_offer_usd !== undefined)
    checks.push(eq("bestOffer.rate_usd", r.bestOffer?.rate_usd ?? null, e.best_offer_usd));
  if (e.best_offer_carrier_includes !== undefined) {
    const name = r.bestOffer?.carrier_name ?? "";
    checks.push({
      label: `bestOffer.carrier ~ "${e.best_offer_carrier_includes}"`,
      pass: includesCI(name, e.best_offer_carrier_includes),
      detail: `got ${JSON.stringify(name)}`,
    });
  }

  if (e.compliance_severities !== undefined) {
    const have = new Set(r.compliance.map((f) => f.severity));
    for (const sev of e.compliance_severities)
      checks.push({ label: `compliance has ${sev}`, pass: have.has(sev as never) });
    if (e.compliance_severities.length === 0)
      checks.push({ label: "no compliance flags", pass: r.compliance.length === 0, detail: `got ${r.compliance.length}` });
  }
  if (e.compliance_includes) {
    const blob = r.compliance.map((f) => f.message).join(" || ");
    for (const sub of e.compliance_includes)
      checks.push({ label: `compliance ~ "${sub}"`, pass: includesCI(blob, sub), detail: `in ${JSON.stringify(blob)}` });
  }
  if (e.validation_includes) {
    const blob = r.validation.map((v) => v.message).join(" || ");
    for (const sub of e.validation_includes)
      checks.push({ label: `validation ~ "${sub}"`, pass: includesCI(blob, sub), detail: `in ${JSON.stringify(blob)}` });
  }
  if (e.recommendation_includes) {
    for (const sub of e.recommendation_includes)
      checks.push({
        label: `recommendation ~ "${sub}"`,
        pass: includesCI(r.recommendation, sub),
        detail: `in ${JSON.stringify(r.recommendation)}`,
      });
  }
  if (e.recommendation_excludes) {
    for (const sub of e.recommendation_excludes)
      checks.push({
        label: `recommendation !~ "${sub}"`,
        pass: !includesCI(r.recommendation, sub),
        detail: `found in ${JSON.stringify(r.recommendation)}`,
      });
  }
  if (e.min_timeline !== undefined)
    checks.push({
      label: `timeline length ≥ ${e.min_timeline}`,
      pass: r.timeline.length >= e.min_timeline,
      detail: `got ${r.timeline.length}`,
    });

  return checks;
}

function main() {
  assertDataFilesExist();
  const goldenPath = path.join(process.cwd(), "eval", "intake.golden.json");
  const golden = JSON.parse(fs.readFileSync(goldenPath, "utf8")) as GoldenFile;

  console.log(`\nTier 1 — deterministic intake pipeline eval`);
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

  const score = printScore("Tier 1 score", passed, golden.cases.length);
  if (score < 1) process.exitCode = 1;
}

main();
