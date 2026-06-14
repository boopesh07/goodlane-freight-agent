import { describe, expect, it } from "vitest";
import { runCallIntake, runEmailIntake } from "./pipeline";

describe("email intake — scoping (CE0063 regression)", () => {
  const result = runEmailIntake("CE0063");

  it("resolves the load and carrier", () => {
    expect(result.load.load?.load_id).toBe("29372475");
    expect(result.carrier.profile?.company_name).toBe("DEMIX TRANSPORT");
    expect(result.carrier.matchedBy).toBe("mc");
  });

  it("scopes email history to the LOAD THREAD only — no cross-load carrier noise", () => {
    expect(result.scope).toBe("load");
    const loadRefs = new Set(result.emailHistory.map((e) => e.load_reference));
    expect([...loadRefs]).toEqual(["29372475"]);
  });

  it("never includes the inbound email itself", () => {
    expect(result.emailHistory.some((e) => e.email_id === "CE0063")).toBe(false);
  });

  it("only counts offers tied to this load", () => {
    // Offers must come from this load's thread/calls, not the carrier's other loads.
    for (const o of result.offers) {
      const fromLoadThread = result.emailHistory.some((e) => e.email_id === o.source_id);
      const fromLoadCall = result.callHistory.some((c) => c.call_id === o.source_id);
      expect(fromLoadThread || fromLoadCall).toBe(true);
    }
  });

  it("produces a deterministic 4-line summary and a recommendation", () => {
    expect(result.summary).toHaveLength(4);
    expect(result.recommendation).toContain("29372475");
  });
});

describe("call intake — structured load resolution with confidence", () => {
  const result = runCallIntake("call_013");

  it("resolves the carrier by MC from call-side extraction", () => {
    expect(result.carrier.profile?.company_name).toBe("CROSSROADS TRANSPORT INC");
    expect(result.carrier.matchedBy).toBe("mc");
  });

  it("falls back to a structured (lane/equipment) load match flagged for human review", () => {
    expect(result.load.matchedBy).toBe("structured_search");
    expect(result.load.needsHumanVerification).toBe(true);
    expect(result.recommendation.toLowerCase()).toContain("confirm");
  });
});
