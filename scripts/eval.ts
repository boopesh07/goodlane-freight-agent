import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { generateObject, generateText } from "ai";
import { z } from "zod";
import { SYSTEM_PROMPT } from "../lib/agent/prompt";
import { agentTools } from "../lib/agent/tools";
import { assertDataFilesExist } from "../lib/data/loaders";
import { getAgentModel, models } from "../lib/model";
import { type Check, printCase, printScore, rule } from "../eval/report";

/**
 * Tier 3 — end-to-end agent eval.
 *
 * Runs the real free-query agent (generateText + live tools) and grades each
 * case on three axes:
 *   1. text assertions  — must_match regexes AND must_not_match (anti-hallucination)
 *   2. tool assertions  — tools_used were called, tools_not_used were not
 *   3. LLM judge         — semantic faithfulness to retrieved facts vs a rubric
 *
 * Unlike the deterministic Tiers 1–2, this needs OPENAI_API_KEY and is
 * non-deterministic, so it runs locally / on demand rather than in PR CI.
 */

type GoldCase = {
  id: string;
  question: string;
  as_of?: string;
  expect: {
    must_match?: string[];
    must_not_match?: string[];
    tools_used?: string[];
    tools_not_used?: string[];
  };
  judge?: { rubric: string };
};

type GoldenFile = {
  description: string;
  judge?: { enabled: boolean; min_score: number };
  cases: GoldCase[];
};

const JudgeSchema = z.object({
  score: z.number().min(0).max(1).describe("0 = fails the rubric, 1 = fully satisfies it."),
  faithful: z.boolean().describe("True only if every claim is grounded in the retrieved tool results."),
  reasoning: z.string().describe("One or two sentences explaining the score."),
});

type ToolEvent = { name: string; args: unknown; result: unknown };

async function runAgent(testCase: GoldCase) {
  const contextNote = testCase.as_of
    ? `\n\nThe broker is asking as of ${testCase.as_of}. Use this as before_timestamp when calling get_email_history, get_rate_history, and get_transcript unless the question specifies otherwise.`
    : "";

  const events: ToolEvent[] = [];
  const result = await generateText({
    model: getAgentModel(),
    system: SYSTEM_PROMPT + contextNote,
    prompt: testCase.question,
    tools: agentTools,
    maxSteps: 12,
    onStepFinish: (step) => {
      step.toolCalls.forEach((call, i) => {
        events.push({ name: call.toolName, args: call.args, result: step.toolResults[i]?.result });
      });
    },
  });

  return { text: result.text, events };
}

async function judge(rubric: string, question: string, answer: string, events: ToolEvent[]) {
  const toolDigest = events
    .map((e) => `- ${e.name}(${JSON.stringify(e.args)}) -> ${JSON.stringify(e.result).slice(0, 500)}`)
    .join("\n");

  const { object } = await generateObject({
    model: models.extraction(),
    schema: JudgeSchema,
    system:
      "You are a strict evaluator for a freight-broker AI assistant. Grade the assistant's ANSWER against the RUBRIC and, crucially, for FAITHFULNESS: every fact (rate, carrier, load, compliance) must be supported by the TOOL RESULTS. Penalize any invented fact heavily.",
    prompt: [
      `RUBRIC:\n${rubric}`,
      `\nQUESTION:\n${question}`,
      `\nTOOL CALLS + RESULTS:\n${toolDigest || "(none)"}`,
      `\nASSISTANT ANSWER:\n${answer}`,
    ].join("\n"),
    temperature: 0,
  });
  return object;
}

async function evaluateCase(c: GoldCase, judgeCfg: GoldenFile["judge"]): Promise<{ checks: Check[]; preview: string }> {
  const { text, events } = await runAgent(c);
  const toolsCalled = new Set(events.map((e) => e.name));
  const checks: Check[] = [];

  for (const pattern of c.expect.must_match ?? []) {
    const re = new RegExp(pattern);
    checks.push({ label: `matches /${pattern}/`, pass: re.test(text), detail: "pattern absent from answer" });
  }
  for (const pattern of c.expect.must_not_match ?? []) {
    const re = new RegExp(pattern);
    checks.push({ label: `does NOT match /${pattern}/`, pass: !re.test(text), detail: "forbidden pattern present (possible hallucination)" });
  }
  for (const tool of c.expect.tools_used ?? []) {
    checks.push({ label: `called ${tool}`, pass: toolsCalled.has(tool), detail: `tools: ${[...toolsCalled].join(", ") || "none"}` });
  }
  for (const tool of c.expect.tools_not_used ?? []) {
    checks.push({ label: `did NOT call ${tool}`, pass: !toolsCalled.has(tool) });
  }

  if (judgeCfg?.enabled && c.judge) {
    const verdict = await judge(c.judge.rubric, c.question, text, events);
    checks.push({
      label: `judge ≥ ${judgeCfg.min_score} (got ${verdict.score.toFixed(2)}${verdict.faithful ? "" : ", UNFAITHFUL"})`,
      pass: verdict.score >= judgeCfg.min_score && verdict.faithful,
      detail: verdict.reasoning,
    });
  }

  return { checks, preview: text.slice(0, 220).replace(/\n/g, " ") };
}

async function main() {
  if (!process.env.OPENAI_API_KEY) {
    console.error("OPENAI_API_KEY is required to run the Tier 3 agent eval.");
    process.exit(1);
  }
  assertDataFilesExist();

  const goldenPath = path.join(process.cwd(), "eval", "golden.json");
  const golden = JSON.parse(fs.readFileSync(goldenPath, "utf8")) as GoldenFile;

  console.log(`\nTier 3 — end-to-end agent eval${golden.judge?.enabled ? " (with LLM judge)" : ""}`);
  console.log(golden.description);
  console.log();

  let passed = 0;
  for (const c of golden.cases) {
    let checks: Check[];
    let preview = "";
    try {
      const out = await evaluateCase(c, golden.judge);
      checks = out.checks;
      preview = out.preview;
    } catch (err) {
      checks = [{ label: "ran without error", pass: false, detail: (err as Error).message }];
    }
    if (printCase(c.id, checks)) passed++;
    if (preview) console.log(`      ${rule(50)}\n      preview: ${preview}\n`);
  }

  const score = printScore("Tier 3 score", passed, golden.cases.length);
  if (score < 1) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
