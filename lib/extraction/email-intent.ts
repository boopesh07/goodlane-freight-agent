import { generateObject } from "ai";
import { z } from "zod";
import { models } from "@/lib/model";
import type { IntentClassification } from "@/lib/data/types";
import { NORMALIZED_INTENTS } from "@/lib/ingestion/intent";

/**
 * Offline email intent classifier. Mirrors the call extractor: a single
 * structured call per email returning a normalized intent with confidence and a
 * short evidence quote. Used by scripts/enrich-emails.ts to build the committed
 * data/email_enrichment.json — it is never called at request time.
 */

const EmailIntentSchema = z.object({
  intent: z.enum(NORMALIZED_INTENTS),
  confidence: z.number().min(0).max(1),
  evidence: z.string(),
});

export const EMAIL_INTENT_SYSTEM_PROMPT = `You classify the PRIMARY intent of an inbound email from a motor carrier to a freight broker.

Output exactly one intent value, a confidence (0.0–1.0), and a short evidence quote from the email.

Intent values:
- rate_negotiation — countering/negotiating price, stating a floor or counteroffer, discussing $/rate
- availability_check — offering a truck or stating availability / empty location / date
- compliance_check — asking about or providing insurance, authority, COI, safety rating
- load_details — asking about weight, dimensions, pickup/delivery windows, or lane specifics
- booking_confirmation — confirming/accepting/booking a load ("we'll take it", "confirmed")
- general_inquiry — a general question or follow-up that fits none of the above
- voicemail — not applicable to email; do not use

Rules:
1. Choose the SINGLE dominant intent. If the email both negotiates a rate and asks a detail, prefer rate_negotiation.
2. A bare "what does it pay?" / "what's the all-in?" with no counter is general_inquiry, not rate_negotiation.
3. evidence must be a short quote from the email, not a restatement.
4. Reflect genuine uncertainty in confidence (terse one-liners are often lower confidence).`;

export async function classifyEmailIntent(
  subject: string,
  body: string,
): Promise<IntentClassification | null> {
  try {
    const { object } = await generateObject({
      model: models.extraction(),
      schema: EmailIntentSchema,
      system: EMAIL_INTENT_SYSTEM_PROMPT,
      prompt: `Subject: ${subject}\n\nBody:\n${body}`,
      temperature: 0,
    });
    return { value: object.intent, confidence: object.confidence, evidence: object.evidence };
  } catch (err) {
    console.warn("email intent classification failed:", (err as Error).message);
    return null;
  }
}
