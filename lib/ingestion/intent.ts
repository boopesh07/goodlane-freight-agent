import type { NormalizedIntent } from "@/lib/data/types";

/**
 * The normalized intent vocabulary, as a runtime tuple (for Zod enums and
 * iteration). Kept in lockstep with the `NormalizedIntent` type in types.ts via
 * the `satisfies` check below.
 */
export const NORMALIZED_INTENTS = [
  "rate_negotiation",
  "availability_check",
  "compliance_check",
  "load_details",
  "booking_confirmation",
  "general_inquiry",
  "voicemail",
] as const satisfies readonly NormalizedIntent[];

const NORMALIZED_SET = new Set<string>(NORMALIZED_INTENTS);

/**
 * Map the legacy per-channel labels onto the normalized taxonomy.
 * Emails ship {info, counter, inquiry, terse, confirm}; calls ship
 * {rate_negotiation, availability_check, compliance_check, load_details,
 * voicemail}. "terse" is a style, not an intent, so it has no mapping and falls
 * through to the keyword classifier / enrichment.
 */
const LEGACY_INTENT_MAP: Record<string, NormalizedIntent> = {
  // legacy email vocabulary
  counter: "rate_negotiation",
  confirm: "booking_confirmation",
  info: "general_inquiry",
  inquiry: "general_inquiry",
  // legacy call vocabulary (already close to normalized)
  rate_negotiation: "rate_negotiation",
  availability_check: "availability_check",
  compliance_check: "compliance_check",
  load_details: "load_details",
  voicemail: "voicemail",
  // keyword-classifier / agent-prompt synonyms
  booking_confirmation: "booking_confirmation",
  general_inquiry: "general_inquiry",
};

/**
 * Normalize a raw legacy label to the shared taxonomy. Returns null when the
 * label carries no usable intent signal (e.g. "terse", "unknown", "") so the
 * caller can fall back to the keyword classifier.
 */
export function normalizeLegacyIntent(raw: string | null | undefined): NormalizedIntent | null {
  if (!raw) return null;
  const key = raw.trim().toLowerCase();
  if (!key || key === "unknown") return null;
  if (NORMALIZED_SET.has(key)) return key as NormalizedIntent;
  return LEGACY_INTENT_MAP[key] ?? null;
}

/**
 * Deterministic keyword classifier — the fallback of last resort when neither
 * an enriched classification nor a mappable legacy label is available. Returns a
 * value in the normalized taxonomy. Brittle by nature (paraphrase, multi-intent,
 * order-dependent), which is exactly why it sits last in the precedence chain.
 */
export function keywordIntent(text: string): NormalizedIntent {
  const t = text.toLowerCase();
  if (/\b(insurance|authority|compliance|coi|certificate|safety rating)\b/.test(t)) return "compliance_check";
  if (/\b(available|availability|can take|got a truck|empty|free on)\b/.test(t)) return "availability_check";
  if (/\b(rate|price|\$|per mile|negotiate|counter|how much)\b/.test(t)) return "rate_negotiation";
  if (/\b(confirm|booked|book it|accept|take it)\b/.test(t)) return "booking_confirmation";
  if (/\b(weight|dimensions|pickup|delivery|details|when|where)\b/.test(t)) return "load_details";
  return "general_inquiry";
}
