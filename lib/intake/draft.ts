import { generateObject } from "ai";
import { z } from "zod";
import { models } from "@/lib/model";
import type { IntakeResult } from "./pipeline";

/**
 * The ONLY generative step in the intake workflow (besides offline extraction).
 * The LLM writes the reply email's prose — but strictly from the deterministic
 * facts the pipeline already retrieved. We hand it a closed set of facts and
 * forbid inventing rates/loads/carriers, so the draft can't hallucinate.
 */

const DraftSchema = z.object({
  subject: z.string(),
  body: z.string(),
});

export type EmailDraft = z.infer<typeof DraftSchema> & {
  to: string | null;
  status: string;
};

/** Build the closed fact sheet the model is allowed to use. */
function factSheet(result: IntakeResult): string {
  const c = result.carrier.profile;
  const l = result.load.load;
  const facts: string[] = [];
  facts.push(`carrier_name: ${c?.company_name ?? result.extraction.company_name ?? "unknown"}`);
  facts.push(`contact_name: ${c?.primary_contact ?? "unknown"}`);
  if (l) {
    facts.push(`load_id: ${l.load_id}`);
    facts.push(`lane: ${l.origin_city}, ${l.origin_state} -> ${l.destination_city}, ${l.destination_state}`);
    facts.push(`equipment: ${l.equipment_type}`);
    facts.push(`load_status: ${l.status}`);
    facts.push(`posted_rate_usd: ${l.offered_rate_usd}`);
    facts.push(`pickup_date: ${l.pickup_date}`);
  } else {
    facts.push("load_id: NOT RESOLVED");
  }
  if (result.bestOffer) facts.push(`best_offer_usd: ${result.bestOffer.rate_usd} (from ${result.bestOffer.carrier_name ?? "carrier"})`);
  if (result.rateContext.market_total_usd != null) facts.push(`market_estimate_usd: ${result.rateContext.market_total_usd}`);
  if (result.compliance.length) facts.push(`compliance_flags: ${result.compliance.map((f) => f.message).join("; ")}`);
  if (result.extraction.questions.length) facts.push(`carrier_questions: ${result.extraction.questions.join(" | ")}`);
  facts.push(`needs_human_verification: ${result.load.needsHumanVerification}`);
  facts.push(`broker_recommendation: ${result.recommendation}`);
  return facts.join("\n");
}

export async function draftReply(result: IntakeResult): Promise<EmailDraft> {
  const mustConfirm = result.load.needsHumanVerification || !result.load.load;

  const prompt = [
    "You are a freight broker's assistant writing a SHORT reply email to a carrier.",
    "Use ONLY the facts below. Do NOT invent or change any rate, load id, lane, or carrier name.",
    "If a fact is missing, omit it — never guess.",
    mustConfirm
      ? "The load match is NOT confirmed: do NOT quote a firm rate. Ask the carrier to confirm which load they mean."
      : "You may reference the posted rate / best offer from the facts. Do not commit to a number not in the facts.",
    "Keep it 3-6 sentences, professional, sign off as 'Goodlane Dispatch'. Answer any carrier_questions if the facts support it.",
    "",
    "FACTS:",
    factSheet(result),
  ].join("\n");

  const { object } = await generateObject({
    model: models.extraction(),
    schema: DraftSchema,
    prompt,
    temperature: 0.3,
  });

  return {
    ...object,
    to: result.carrier.profile?.email ?? null,
    status: "draft (not sent — broker must review and send)",
  };
}
