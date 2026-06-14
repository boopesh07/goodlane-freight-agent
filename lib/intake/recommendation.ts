import { generateObject } from "ai";
import { z } from "zod";
import { models } from "@/lib/model";
import type { IntakeResult } from "./pipeline";

const RecommendationSchema = z.object({
  recommendation: z
    .string()
    .describe("One clear paragraph telling the broker what to do next. Use only facts provided."),
});

/** Generate the broker recommendation from retrieved facts (runs at process time). */
export async function generateRecommendation(
  result: Omit<IntakeResult, "recommendation" | "summary">,
): Promise<string> {
  const facts = [
    `intent: ${result.intent}`,
    `carrier: ${result.carrier.profile?.company_name ?? result.extraction.company_name ?? "unresolved"} (matched by ${result.carrier.matchedBy})`,
    result.load.load
      ? `load: ${result.load.load.load_id} ${result.load.load.origin_state}→${result.load.load.destination_state} · ${result.load.load.status} · posted $${result.load.load.offered_rate_usd} · match confidence ${Math.round(result.load.confidence * 100)}%`
      : "load: not resolved",
    result.load.needsHumanVerification ? "needs_human_verification: true" : "needs_human_verification: false",
    result.bestOffer
      ? `best_offer: $${result.bestOffer.rate_usd} from ${result.bestOffer.carrier_name ?? "carrier"}`
      : "best_offer: none",
    result.rateContext.market_total_usd != null
      ? `market_estimate_usd: ${result.rateContext.market_total_usd}`
      : "market_estimate_usd: unknown",
    result.compliance.length
      ? `compliance_flags: ${result.compliance.map((c) => c.message).join("; ")}`
      : "compliance_flags: none",
    result.validation.length
      ? `validation: ${result.validation.map((v) => v.message).join("; ")}`
      : "validation: ok",
  ].join("\n");

  const { object } = await generateObject({
    model: models.extraction(),
    schema: RecommendationSchema,
    system:
      "You are a freight broker assistant. Write a single recommended next action for the broker based ONLY on the facts below. " +
      "Do not invent rates, loads, or carriers. If load match needs human verification, say to confirm before quoting. " +
      "If compliance blocks booking, say so clearly. Be concise (2-4 sentences).",
    prompt: facts,
    temperature: 0.2,
  });

  return object.recommendation;
}
