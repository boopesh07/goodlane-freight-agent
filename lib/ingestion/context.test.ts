import { describe, expect, it } from "vitest";
import { findCarrierProfile } from "@/lib/data/loaders";
import {
  classifyIntent,
  crossReferenceIngestion,
  extractIdentifiers,
  type ExtractedIdentifiers,
} from "@/lib/ingestion/context";
import { findEmailById } from "@/lib/data/loaders";

describe("identifier extraction & intent", () => {
  it("extracts load ref and MC from an email and classifies intent", () => {
    const email = findEmailById("CE0074")!;
    const ids = extractIdentifiers(email);
    expect(ids.loadRefs).toContain("29372515");
    expect(ids.mcNumbers).toContain("876543");
    expect(classifyIntent(email)).toBeTruthy();
  });

  it("does not mistake a 7-digit MC for a load reference", () => {
    const email = findEmailById("CE0063")!; // body: "... MC 1480355."
    const ids = extractIdentifiers(email);
    expect(ids.loadRefCandidates).not.toContain("1480355");
    expect(ids.mcNumbers).toContain("1480355");
  });
});

describe("cross-reference validation", () => {
  const baseIds = (over: Partial<ExtractedIdentifiers>): ExtractedIdentifiers => ({
    loadRefs: [],
    loadRefCandidates: [],
    mcNumbers: [],
    carrierNames: [],
    fromEmail: null,
    ...over,
  });

  it("flags a misspelled load number and offers candidates", () => {
    const ids = baseIds({ loadRefCandidates: ["29372344"] }); // typo of 29372343
    const { findings, loadCandidates } = crossReferenceIngestion(
      ids,
      { carrier: null, matchedBy: "none" },
      null,
    );
    const loadErr = findings.find((f) => f.field === "load_reference");
    expect(loadErr?.severity).toBe("error");
    expect(loadCandidates.map((l) => l.load_id)).toContain("29372343");
  });

  it("flags carrier identity conflict between MC and sender email", () => {
    const smr = findCarrierProfile({ mc_number: "776491" })!;
    const other = findCarrierProfile({ mc_number: "538772" })!;
    const ids = baseIds({ mcNumbers: ["776491"], fromEmail: other.email });
    // Sender email belongs to a different carrier than the quoted MC.
    const { findings } = crossReferenceIngestion(
      ids,
      { carrier: smr, matchedBy: "mc" },
      null,
    );
    expect(findings.some((f) => f.field === "carrier_identity" && f.severity === "warning")).toBe(true);
  });

  it("warns when carrier is resolved only by fuzzy name", () => {
    const smr = findCarrierProfile({ mc_number: "776491" })!;
    const ids = baseIds({ carrierNames: ["s m r trucking"] });
    const { findings } = crossReferenceIngestion(
      ids,
      { carrier: smr, matchedBy: "name", score: 1 },
      null,
    );
    expect(findings.some((f) => f.field === "carrier" && f.severity === "warning")).toBe(true);
  });
});
