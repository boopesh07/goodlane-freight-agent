import { generateObject } from "ai";
import { z } from "zod";
import { models } from "@/lib/model";
import { CallExtraction } from "./schemas";
import { normalizeSpokenMc, parseDollarAmounts } from "./parsers";

type ExtractResult<T> = { data: T | null; warnings: string[] };

async function generateWithRetry<T>(schema: z.ZodSchema<T>, prompt: string): Promise<T | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const { object } = await generateObject({
        model: models.extraction(),
        schema,
        prompt,
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
 * Extract structured fields from a diarized broker–carrier call. Deterministic
 * parsers ground the prompt (detected $ amounts + a best-guess MC) so the model
 * has anchors for the messy bits, but the model makes the final call so it can
 * attribute the rate to the correct speaker.
 */
export async function extractCall(transcript: string): Promise<ExtractResult<CallExtraction>> {
  const warnings: string[] = [];
  const amounts = parseDollarAmounts(transcript);
  const mc = normalizeSpokenMc(transcript);
  if (amounts.length > 1) warnings.push("multiple_rates");
  if (mc.corrected) warnings.push("mc_corrected_or_ambiguous");

  const prompt = [
    "You extract structured fields from a DIARIZED broker–carrier phone call.",
    "Each line is prefixed with a speaker label like '[A]' or '[B]'. One speaker is the Goodlane dispatcher (broker); the other is the carrier.",
    "The transcript may contain filler words, cross-talk, and a spoken MC number that is garbled or corrected mid-sentence.",
    "Steps:",
    "1. Identify which speaker is the CARRIER (they state their MC/company and are being quoted a load). Put that label in carrier_speaker.",
    "2. mc_number: digits only, taken from the carrier's speech. If they self-correct ('five five... no, eight seven six...'), use the LAST stated value.",
    "3. carrier_rate_usd: a dollar amount the CARRIER offers/counters (spoken by carrier_speaker only). Do NOT use the dispatcher's posted/anchor rate. null if the carrier never states their own number.",
    "4. dispatcher_rate_usd: the rate the dispatcher posts/anchors, if any (context only).",
    "5. load_reference: digits only if a load id is mentioned.",
    "Never invent a value. Attribute numbers by speaker.",
    "",
    `Dollar amounts detected in the text (for reference): ${JSON.stringify(amounts.map((a) => a.value))}`,
    `Best-guess MC from a deterministic parser (verify against speech): ${mc.mc ?? "none"}`,
    "",
    "TRANSCRIPT:",
    transcript,
  ].join("\n");

  const data = await generateWithRetry(CallExtraction, prompt);
  if (!data) warnings.push("extraction_failed");
  return { data, warnings };
}
