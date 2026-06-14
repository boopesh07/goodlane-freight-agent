import { createOpenAI } from "@ai-sdk/openai";

/**
 * Thin, swappable provider adapter. Everything model-related funnels through
 * here so a different provider can be dropped in by changing one file.
 */
const openai = createOpenAI({ apiKey: process.env.OPENAI_API_KEY });

export function getAgentModel() {
  return openai(process.env.OPENAI_AGENT_MODEL ?? "gpt-4o");
}

export const models = {
  agent: () => openai(process.env.OPENAI_AGENT_MODEL ?? "gpt-4o"),
  /** Cheaper model for offline structured extraction. */
  extraction: () => openai(process.env.OPENAI_EXTRACTION_MODEL ?? "gpt-4o-mini"),
};

export const modelNames = {
  agent: process.env.OPENAI_AGENT_MODEL ?? "gpt-4o",
  extraction: process.env.OPENAI_EXTRACTION_MODEL ?? "gpt-4o-mini",
  transcribe: process.env.OPENAI_TRANSCRIBE_MODEL ?? "gpt-4o-transcribe-diarize",
};
