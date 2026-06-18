import { z } from "zod";
import type { CallExtraction, CallExtractionScores, IntentClassification } from "@/lib/data/types";
import { NORMALIZED_INTENTS } from "@/lib/ingestion/intent";

/** Per-field extraction with model-reported confidence and supporting evidence. */
type ScoredField<T> = {
  value: T;
  confidence: number;
  evidence: string;
};

type ExtractionFlag =
  | "multiple_rates"
  | "mc_corrected_or_ambiguous"
  | "speaker_unclear"
  | "load_id_uncertain"
  | "cross_talk";

const LOW_CONFIDENCE_THRESHOLD = 0.6;

const EXTRACTION_FLAGS = [
  "multiple_rates",
  "mc_corrected_or_ambiguous",
  "speaker_unclear",
  "load_id_uncertain",
  "cross_talk",
] as const satisfies readonly ExtractionFlag[];

function scoredField<T extends z.ZodTypeAny>(valueSchema: T) {
  return z.object({
    value: valueSchema,
    confidence: z.number().min(0).max(1),
    evidence: z.string(),
  });
}

/**
 * Full LLM extraction output — every field carries value, confidence, and evidence.
 */
export const ScoredCallExtractionSchema = z.object({
  carrier_speaker: scoredField(z.string().nullable()),
  mc_number: scoredField(z.string().nullable()),
  company_name: scoredField(z.string().nullable()),
  load_reference: scoredField(z.string().nullable()),
  origin_state: scoredField(z.string().nullable()),
  destination_state: scoredField(z.string().nullable()),
  carrier_rate_usd: scoredField(z.number().nullable()),
  dispatcher_rate_usd: scoredField(z.number().nullable()),
  equipment: scoredField(z.string().nullable()),
  available_location: scoredField(z.string().nullable()),
  available_date: scoredField(z.string().nullable()),
  questions: scoredField(z.array(z.string())),
  intent: scoredField(z.enum(NORMALIZED_INTENTS)),
  extraction_flags: z.array(z.enum(EXTRACTION_FLAGS)),
});

export type ScoredCallExtraction = z.infer<typeof ScoredCallExtractionSchema>;

export function flattenCallExtraction(scored: ScoredCallExtraction): CallExtraction {
  return {
    carrier_speaker: scored.carrier_speaker.value,
    mc_number: scored.mc_number.value,
    company_name: scored.company_name.value,
    load_reference: scored.load_reference.value,
    origin_state: scored.origin_state.value,
    destination_state: scored.destination_state.value,
    carrier_rate_usd: scored.carrier_rate_usd.value,
    dispatcher_rate_usd: scored.dispatcher_rate_usd.value,
    equipment: scored.equipment.value,
    available_location: scored.available_location.value,
    available_date: scored.available_date.value,
    questions: scored.questions.value,
  };
}

/** Pull the normalized intent (value + confidence + evidence) out of the extraction. */
export function intentFromExtraction(scored: ScoredCallExtraction): IntentClassification {
  return {
    value: scored.intent.value,
    confidence: scored.intent.confidence,
    evidence: scored.intent.evidence,
  };
}

export function scoresFromExtraction(scored: ScoredCallExtraction): CallExtractionScores {
  const keys = [
    "carrier_speaker",
    "mc_number",
    "company_name",
    "load_reference",
    "origin_state",
    "destination_state",
    "carrier_rate_usd",
    "dispatcher_rate_usd",
    "equipment",
    "available_location",
    "available_date",
    "questions",
  ] as const satisfies readonly (keyof CallExtraction)[];

  const out = {} as CallExtractionScores;
  for (const key of keys) {
    const field = scored[key];
    out[key] = { confidence: field.confidence, evidence: field.evidence };
  }
  return out;
}

/** Merge model-reported flags with confidence-derived warnings. */
export function deriveExtractionWarnings(scored: ScoredCallExtraction): string[] {
  const warnings = new Set<string>(scored.extraction_flags);

  const check = (key: keyof CallExtraction, label: string) => {
    const field = scored[key];
    if (field.value != null && field.confidence < LOW_CONFIDENCE_THRESHOLD) {
      warnings.add(`${label}_low_confidence`);
    }
    if (field.value == null && field.confidence > 0.3 && field.confidence < LOW_CONFIDENCE_THRESHOLD) {
      warnings.add(`${label}_uncertain`);
    }
  };

  check("mc_number", "mc");
  check("carrier_rate_usd", "carrier_rate");
  check("load_reference", "load_reference");
  check("carrier_speaker", "speaker");
  check("company_name", "company_name");

  return [...warnings];
}
