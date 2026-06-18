import { describe, expect, it } from "vitest";
import { classifyIntent } from "@/lib/ingestion/context";
import { keywordIntent, NORMALIZED_INTENTS, normalizeLegacyIntent } from "@/lib/ingestion/intent";
import type { CallTranscript, CarrierEmail } from "@/lib/data/types";

const baseEmail = (over: Partial<CarrierEmail>): CarrierEmail => ({
  email_id: "CE9999",
  timestamp: "2026-05-01T00:00:00Z",
  from_name: "Test Carrier",
  from_email: "test@example.com",
  to_email: "dispatch@goodlanelogistics.com",
  subject: "",
  body: "",
  mc_number: null,
  load_reference: null,
  equipment_mentioned: null,
  rate_quoted_usd: null,
  intent: null,
  ...over,
});

const baseCall = (over: Partial<CallTranscript>): CallTranscript => ({
  call_id: "call_999",
  type: "unknown",
  file: "call_999.wav",
  transcript: "",
  segments: [],
  speakers: [],
  recorded_at: "2026-05-01T00:00:00Z",
  ...over,
});

describe("normalizeLegacyIntent", () => {
  it("maps legacy email labels onto the normalized taxonomy", () => {
    expect(normalizeLegacyIntent("counter")).toBe("rate_negotiation");
    expect(normalizeLegacyIntent("confirm")).toBe("booking_confirmation");
    expect(normalizeLegacyIntent("info")).toBe("general_inquiry");
    expect(normalizeLegacyIntent("inquiry")).toBe("general_inquiry");
  });

  it("passes through already-normalized call types", () => {
    for (const v of NORMALIZED_INTENTS) expect(normalizeLegacyIntent(v)).toBe(v);
  });

  it("returns null for style-only or unknown labels so the caller can fall back", () => {
    expect(normalizeLegacyIntent("terse")).toBeNull();
    expect(normalizeLegacyIntent("unknown")).toBeNull();
    expect(normalizeLegacyIntent("")).toBeNull();
    expect(normalizeLegacyIntent(null)).toBeNull();
  });
});

describe("keywordIntent", () => {
  it("returns values within the normalized taxonomy", () => {
    expect(keywordIntent("need a COI and authority check")).toBe("compliance_check");
    expect(keywordIntent("got a truck empty Friday")).toBe("availability_check");
    expect(keywordIntent("can you do better on the rate per mile?")).toBe("rate_negotiation");
    expect(keywordIntent("book it, we'll take it")).toBe("booking_confirmation");
    expect(keywordIntent("what's the weight and pickup window?")).toBe("load_details");
    expect(keywordIntent("just following up")).toBe("general_inquiry");
  });
});

describe("classifyIntent precedence", () => {
  it("prefers the enriched classification when present", () => {
    const email = baseEmail({
      intent: "counter", // legacy would say rate_negotiation
      classified_intent: { value: "compliance_check", confidence: 0.9, evidence: "..." },
    });
    expect(classifyIntent(email)).toBe("compliance_check");
  });

  it("falls back to the normalized legacy email label", () => {
    expect(classifyIntent(baseEmail({ intent: "counter" }))).toBe("rate_negotiation");
  });

  it("falls back to the keyword classifier when the legacy label is style-only", () => {
    const email = baseEmail({ intent: "terse", subject: "Refrigerated available", body: "ready to go" });
    expect(classifyIntent(email)).toBe("availability_check");
  });

  it("uses the normalized call type for calls", () => {
    expect(classifyIntent(baseCall({ type: "rate_negotiation" }))).toBe("rate_negotiation");
  });

  it("falls back to the keyword classifier for unknown call types", () => {
    const call = baseCall({ type: "unknown", transcript: "what's the all-in rate per mile?" });
    expect(classifyIntent(call)).toBe("rate_negotiation");
  });
});
