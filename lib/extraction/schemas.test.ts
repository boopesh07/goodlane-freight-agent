import { describe, expect, it } from "vitest";
import {
  deriveExtractionWarnings,
  flattenCallExtraction,
  scoresFromExtraction,
  type ScoredCallExtraction,
} from "./schemas";

function field<T>(value: T, confidence = 0.95, evidence = "quoted from transcript") {
  return { value, confidence, evidence };
}

function sampleScored(overrides: Partial<ScoredCallExtraction> = {}): ScoredCallExtraction {
  const base: ScoredCallExtraction = {
    carrier_speaker: field("B"),
    mc_number: field("876543"),
    company_name: field("Capital City Transport"),
    load_reference: field(null),
    origin_state: field("PA"),
    destination_state: field("MD"),
    carrier_rate_usd: field(480),
    dispatcher_rate_usd: field(440),
    equipment: field("Box Truck"),
    available_location: field(null),
    available_date: field(null),
    questions: field([]),
    extraction_flags: [],
  };
  return { ...base, ...overrides };
}

describe("flattenCallExtraction", () => {
  it("pulls flat values from scored fields", () => {
    const flat = flattenCallExtraction(sampleScored());
    expect(flat.mc_number).toBe("876543");
    expect(flat.carrier_rate_usd).toBe(480);
    expect(flat.questions).toEqual([]);
  });
});

describe("scoresFromExtraction", () => {
  it("preserves confidence and evidence per field", () => {
    const scored = sampleScored({
      mc_number: field("776491", 0.85, "[B] MC seven seven six four nine one"),
    });
    const scores = scoresFromExtraction(scored);
    expect(scores.mc_number.confidence).toBe(0.85);
    expect(scores.mc_number.evidence).toContain("[B]");
  });
});

describe("deriveExtractionWarnings", () => {
  it("includes model-reported extraction_flags", () => {
    const warnings = deriveExtractionWarnings(
      sampleScored({ extraction_flags: ["multiple_rates", "mc_corrected_or_ambiguous"] }),
    );
    expect(warnings).toContain("multiple_rates");
    expect(warnings).toContain("mc_corrected_or_ambiguous");
  });

  it("flags low-confidence fields", () => {
    const warnings = deriveExtractionWarnings(
      sampleScored({
        mc_number: field("876543", 0.45, "barely audible"),
        carrier_rate_usd: field(290, 0.5, "inferred"),
      }),
    );
    expect(warnings).toContain("mc_low_confidence");
    expect(warnings).toContain("carrier_rate_low_confidence");
  });
});
