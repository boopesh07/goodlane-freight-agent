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
  /** Cheaper model for structured extraction and recommendations. */
  extraction: () => openai(process.env.OPENAI_EXTRACTION_MODEL ?? "gpt-4o-mini"),
};

export const modelNames = {
  transcribe: process.env.OPENAI_TRANSCRIBE_MODEL ?? "gpt-4o-transcribe-diarize",
};
