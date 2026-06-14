import { describe, it, expect } from "vitest";
import { parseDollarAmounts, normalizeSpokenMc } from "./parsers";

describe("parseDollarAmounts", () => {
  it("returns empty for text without amounts", () => {
    expect(parseDollarAmounts("Can you confirm weight?")).toEqual([]);
  });

  it("parses a single amount", () => {
    const r = parseDollarAmounts("Can you do $290 for this run?");
    expect(r.map((x) => x.value)).toEqual([290]);
  });

  it("parses multiple amounts in order (counter-offer case)", () => {
    const r = parseDollarAmounts("not at $240. Our floor on this lane is $280.");
    expect(r.map((x) => x.value)).toEqual([240, 280]);
  });

  it("handles thousands separators and decimals", () => {
    const r = parseDollarAmounts("Linehaul $1,250.50 plus fuel");
    expect(r[0].value).toBe(1250.5);
  });
});

describe("normalizeSpokenMc", () => {
  it("reads a plain numeric MC", () => {
    expect(normalizeSpokenMc("MC 876543, Capital City Transport").mc).toBe("876543");
  });

  it("reads a dashed MC", () => {
    expect(normalizeSpokenMc("our authority is MC 876-543").mc).toBe("876543");
  });

  it("reads digit-by-digit spelled MC", () => {
    const r = normalizeSpokenMc("my m c is eight seven six five four three");
    expect(r.mc).toBe("876543");
  });

  it("honors mid-sentence correction (last run wins) and flags corrected", () => {
    const r = normalizeSpokenMc("MC five five five five five, no wait, eight seven six five four three");
    expect(r.mc).toBe("876543");
    expect(r.corrected).toBe(true);
  });

  it("returns null when no MC present", () => {
    expect(normalizeSpokenMc("just calling about a load").mc).toBeNull();
  });
});
