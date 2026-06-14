import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { generateText } from "ai";
import { SYSTEM_PROMPT } from "../lib/agent/prompt";
import { agentTools } from "../lib/agent/tools";
import { assertDataFilesExist } from "../lib/data/loaders";
import { getAgentModel } from "../lib/model";

type GoldenCase = {
  id: string;
  question: string;
  as_of?: string;
  expect: {
    must_mention: string[];
    tools_used: string[];
  };
};

type GoldenFile = {
  description: string;
  cases: GoldenCase[];
};

async function runCase(testCase: GoldenCase) {
  const contextNote = testCase.as_of
    ? `\n\nThe broker is asking as of ${testCase.as_of}. Use this as before_timestamp when calling get_email_history, get_rate_history, and get_transcript unless the question specifies otherwise.`
    : "";

  const toolsCalled = new Set<string>();

  const result = await generateText({
    model: getAgentModel(),
    system: SYSTEM_PROMPT + contextNote,
    prompt: testCase.question,
    tools: agentTools,
    maxSteps: 12,
    onStepFinish: (step) => {
      for (const call of step.toolCalls) {
        toolsCalled.add(call.toolName);
      }
    },
  });

  const text = result.text.toLowerCase();
  const missingMentions = testCase.expect.must_mention.filter(
    (token) => !text.includes(token.toLowerCase()),
  );
  const missingTools = testCase.expect.tools_used.filter((tool) => !toolsCalled.has(tool));

  const pass = missingMentions.length === 0 && missingTools.length === 0;

  return {
    id: testCase.id,
    pass,
    missingMentions,
    missingTools,
    toolsCalled: [...toolsCalled],
    responsePreview: result.text.slice(0, 400),
  };
}

async function main() {
  if (!process.env.OPENAI_API_KEY) {
    console.error("OPENAI_API_KEY is required to run eval.");
    process.exit(1);
  }

  assertDataFilesExist();

  const goldenPath = path.join(process.cwd(), "eval", "golden.json");
  const golden = JSON.parse(fs.readFileSync(goldenPath, "utf8")) as GoldenFile;

  console.log(golden.description);
  console.log("—".repeat(60));

  const results = [];
  for (const testCase of golden.cases) {
    const result = await runCase(testCase);
    results.push(result);
    console.log(`${result.pass ? "PASS" : "FAIL"}  ${result.id}`);
    if (!result.pass) {
      if (result.missingMentions.length) {
        console.log("  missing mentions:", result.missingMentions.join(", "));
      }
      if (result.missingTools.length) {
        console.log("  missing tools:", result.missingTools.join(", "));
      }
    }
    console.log("  tools called:", result.toolsCalled.join(", ") || "(none)");
    console.log("  preview:", result.responsePreview.replace(/\n/g, " "));
    console.log();
  }

  const passed = results.filter((r) => r.pass).length;
  const score = passed / results.length;
  console.log("—".repeat(60));
  console.log(`Score: ${passed}/${results.length} (${(score * 100).toFixed(0)}%)`);

  if (score < 1) {
    console.log("\nImprovements: tighten prompt tool ordering, add deterministic unit tests for loaders, expand golden set.");
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
