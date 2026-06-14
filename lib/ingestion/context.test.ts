import { describe, expect, it } from "vitest";
import { findCarrierProfile, normalizeMc } from "@/lib/data/loaders";
import {
  buildEmailIngestionContext,
  buildTranscriptIngestionContext,
  crossReferenceIngestion,
  type ExtractedIdentifiers,
} from "@/lib/ingestion/context";

describe("ingestion context", () => {
  it("collects email and rate history before ingested email timestamp", () => {
    const ctx = buildEmailIngestionContext("CE0042");
    const ts = Date.parse(ctx.ingestionTimestamp);

    expect(ctx.kind).toBe("email");
    expect(ctx.emailHistory.every((e) => Date.parse(e.timestamp) < ts)).toBe(true);
    expect(ctx.rateHistory.every((r) => Date.parse(r.week_start) < ts)).toBe(true);
  });

  it("collects history before ingested call timestamp", () => {
    const ctx = buildTranscriptIngestionContext("call_001");
    const ts = Date.parse(ctx.ingestionTimestamp);

    expect(ctx.kind).toBe("transcript");
    expect(ctx.emailHistory.every((e) => Date.parse(e.timestamp) < ts)).toBe(true);
    expect(ctx.rateHistory.every((r) => Date.parse(r.week_start) < ts)).toBe(true);
  });

  it("classifies intent and extracts identifiers for an email", () => {
    const ctx = buildEmailIngestionContext("CE0074");
    expect(ctx.intent).toBeTruthy();
    expect(ctx.identifiers.loadRefs).toContain("29372515");
    expect(ctx.identifiers.mcNumbers).toContain("876543");
    expect(ctx.carrier).not.toBeNull();
  });

  it("resolves a call's carrier from the pre-extracted MC", () => {
    const ctx = buildTranscriptIngestionContext("call_001");
    expect(ctx.carrier?.company_name).toBe("SMR TRUCKING INC");
    // Call-side extraction supplies the MC, so we resolve by id (not fuzzy name).
    expect(ctx.carrierResolution.matchedBy).toBe("mc");
    expect(ctx.identifiers.mcNumbers).toContain("776491");
  });

  it("scopes email history strictly to the ingested load/carrier (no pollution)", () => {
    const ctx = buildEmailIngestionContext("CE0074");
    const loadRefs = new Set(ctx.identifiers.loadRefs);
    const mcs = new Set(ctx.identifiers.mcNumbers);
    if (ctx.carrier?.mc_number) mcs.add(normalizeMc(ctx.carrier.mc_number));
    const emails = new Set(
      [ctx.identifiers.fromEmail, ctx.carrier?.email].filter(Boolean).map((e) => e!.toLowerCase()),
    );

    // Every retained email must match the load, the carrier MC, or the carrier email.
    for (const e of ctx.emailHistory) {
      const ok =
        (e.load_reference && loadRefs.has(e.load_reference)) ||
        (e.mc_number && mcs.has(normalizeMc(e.mc_number))) ||
        (e.from_email && emails.has(e.from_email.toLowerCase()));
      expect(ok).toBeTruthy();
    }
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
