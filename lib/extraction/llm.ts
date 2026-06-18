import { generateObject } from "ai";
import { models } from "@/lib/model";
import { EXTRACTION_SYSTEM_PROMPT } from "./prompt";
import type { CallExtraction, CallExtractionScores, IntentClassification } from "@/lib/data/types";
import {
  type ScoredCallExtraction,
  ScoredCallExtractionSchema,
  deriveExtractionWarnings,
  flattenCallExtraction,
  intentFromExtraction,
  scoresFromExtraction,
} from "./schemas";

type ExtractResult = {
  data: CallExtraction | null;
  scores: CallExtractionScores | null;
  intent: IntentClassification | null;
  warnings: string[];
};

async function generateWithRetry(transcript: string): Promise<ScoredCallExtraction | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const { object } = await generateObject({
        model: models.extraction(),
        schema: ScoredCallExtractionSchema,
        system: EXTRACTION_SYSTEM_PROMPT,
        prompt: `Extract structured fields from this call transcript:\n\n${transcript}`,
        temperature: 0,
      });
      return object;
    } catch (err) {
      if (attempt === 1) {
        console.warn("extraction failed after retry:", (err as Error).message);
        return null;
      }
    }
  }
  return null;
}

/**
 * Extract structured fields from a diarized broker–carrier call using the LLM
 * only. Each field includes a confidence score and evidence quote; no regex or
 * rule-based parsers ground the extraction.
 */
export async function extractCall(transcript: string): Promise<ExtractResult> {
  const scored = await generateWithRetry(transcript);
  if (!scored) {
    return { data: null, scores: null, intent: null, warnings: ["extraction_failed"] };
  }

  return {
    data: flattenCallExtraction(scored),
    scores: scoresFromExtraction(scored),
    intent: intentFromExtraction(scored),
    warnings: deriveExtractionWarnings(scored),
  };
}
