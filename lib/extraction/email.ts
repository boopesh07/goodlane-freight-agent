import { generateObject } from "ai";
import { z } from "zod";
import { models } from "@/lib/model";
import type { CallExtraction, CallExtractionScores, CarrierEmail } from "@/lib/data/types";
import { EMAIL_EXTRACTION_SYSTEM_PROMPT } from "./email-prompt";

const EXTRACTION_FLAGS = [
  "multiple_rates",
  "mc_corrected_or_ambiguous",
  "speaker_unclear",
  "load_id_uncertain",
  "cross_talk",
] as const;

function scoredField<T extends z.ZodTypeAny>(valueSchema: T) {
  return z.object({
    value: valueSchema,
    confidence: z.number().min(0).max(1),
    evidence: z.string(),
  });
}

const ScoredEmailExtractionSchema = z.object({
  mc_number: scoredField(z.string().nullable()),
  company_name: scoredField(z.string().nullable()),
  load_reference: scoredField(z.string().nullable()),
  origin_state: scoredField(z.string().nullable()),
  destination_state: scoredField(z.string().nullable()),
  carrier_rate_usd: scoredField(z.number().nullable()),
  equipment: scoredField(z.string().nullable()),
  questions: scoredField(z.array(z.string())),
  extraction_flags: z.array(z.enum(EXTRACTION_FLAGS)),
});

type ScoredEmailExtraction = z.infer<typeof ScoredEmailExtractionSchema>;

type EmailExtractResult = {
  data: CallExtraction | null;
  scores: CallExtractionScores | null;
  warnings: string[];
};

function toCallExtraction(scored: ScoredEmailExtraction): CallExtraction {
  return {
    carrier_speaker: null,
    mc_number: scored.mc_number.value,
    company_name: scored.company_name.value,
    load_reference: scored.load_reference.value,
    origin_state: scored.origin_state.value,
    destination_state: scored.destination_state.value,
    carrier_rate_usd: scored.carrier_rate_usd.value,
    dispatcher_rate_usd: null,
    equipment: scored.equipment.value,
    available_location: null,
    available_date: null,
    questions: scored.questions.value,
  };
}

function scoresFromEmail(scored: ScoredEmailExtraction): CallExtractionScores {
  const flat = toCallExtraction(scored);
  const keys = Object.keys(flat) as (keyof CallExtraction)[];
  const out = {} as CallExtractionScores;
  for (const key of keys) {
    const field = scored[key as keyof ScoredEmailExtraction];
    if (field && typeof field === "object" && "confidence" in field) {
      out[key] = { confidence: field.confidence, evidence: field.evidence };
    }
  }
  return out;
}

function emailWarnings(scored: ScoredEmailExtraction): string[] {
  const warnings = new Set<string>(scored.extraction_flags);
  const check = (field: { confidence: number; value: unknown }, label: string) => {
    if (field.value != null && field.confidence < 0.6) warnings.add(`${label}_low_confidence`);
  };
  check(scored.mc_number, "mc");
  check(scored.carrier_rate_usd, "carrier_rate");
  check(scored.load_reference, "load_reference");
  return [...warnings];
}

/** Extract structured fields from an inbound carrier email at processing time. */
export async function extractEmail(email: CarrierEmail): Promise<EmailExtractResult> {
  const prompt = [
    `From: ${email.from_name} <${email.from_email}>`,
    `Subject: ${email.subject}`,
    "",
    email.body,
  ].join("\n");

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const { object } = await generateObject({
        model: models.extraction(),
        schema: ScoredEmailExtractionSchema,
        system: EMAIL_EXTRACTION_SYSTEM_PROMPT,
        prompt,
        temperature: 0,
      });
      const data = toCallExtraction(object);
      return {
        data,
        scores: scoresFromEmail(object),
        warnings: emailWarnings(object),
      };
    } catch (err) {
      if (attempt === 1) {
        console.warn("email extraction failed:", (err as Error).message);
        return { data: null, scores: null, warnings: ["extraction_failed"] };
      }
    }
  }
  return { data: null, scores: null, warnings: ["extraction_failed"] };
}
