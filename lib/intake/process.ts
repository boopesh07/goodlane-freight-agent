import { runCallIntake, runEmailIntake, type IntakeResult } from "./pipeline";

export type IntakeEvent =
  | { type: "step"; step: string; status: "running" | "done"; summary?: string; data?: unknown }
  | { type: "complete"; result: IntakeResult }
  | { type: "error"; message: string };

type Emit = (event: IntakeEvent) => void;

/** Small reveal delay so the retrieval trace streams visibly in the UI. */
const STEP_DELAY_MS = 60;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Intake is fully deterministic: it runs the same pipeline the tests and evals
 * cover (emails use their dataset fields, calls use the committed offline
 * extraction, the recommendation is computed in code). No LLM and no API key —
 * the LLM is reserved for the on-demand draft reply and the free-query chat
 * agent. Here we just run the pipeline and stream its retrieval steps so the UI
 * can show what was looked up, step by step.
 */
export async function processIntake(
  kind: "email" | "call",
  id: string,
  emit: Emit,
): Promise<IntakeResult> {
  const result = kind === "email" ? runEmailIntake(id) : runCallIntake(id);

  for (const step of result.retrievals) {
    emit({ type: "step", step: step.tool, status: "running", data: { args: step.args } });
    await sleep(STEP_DELAY_MS);
    emit({ type: "step", step: step.tool, status: "done", summary: step.summary, data: step.data });
  }

  emit({ type: "complete", result });
  return result;
}
