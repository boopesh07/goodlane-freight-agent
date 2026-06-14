import { describe, expect, it } from "vitest";
import {
  companyNameSimilarity,
  findCarrierProfile,
  findEmailById,
  findLoad,
  findLoadFuzzy,
  fuzzyFindCarrierProfile,
  getEmailHistoryBefore,
  isBefore,
  LOAD_MATCH_VERIFY_THRESHOLD,
  loadRateHistory,
  loadTranscripts,
  searchLoads,
} from "@/lib/data/loaders";

describe("data loaders", () => {
  it("finds load by id", () => {
    const load = findLoad("29372343");
    expect(load).not.toBeNull();
    expect(load?.origin_state).toBe("PA");
    expect(load?.destination_state).toBe("NJ");
  });

  it("finds carrier by mc number", () => {
    const carrier = findCarrierProfile({ mc_number: "776491" });
    expect(carrier?.company_name).toContain("SMR");
  });

  it("filters rate history before timestamp", () => {
    const before = "2026-05-01";
    const rows = loadRateHistory().filter((r) => isBefore(r.week_start, before));
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.week_start < before)).toBe(true);
  });

  it("filters emails before timestamp via helper", () => {
    const before = "2026-05-20T00:00:00Z";
    const emails = getEmailHistoryBefore({ beforeTimestamp: before });
    expect(emails.length).toBeGreaterThan(0);
    expect(emails.every((e) => Date.parse(e.timestamp) < Date.parse(before))).toBe(true);
  });

  it("finds email by id", () => {
    const email = findEmailById("CE0074");
    expect(email?.from_name).toBeTruthy();
  });

  it("loads transcripts with synthetic recorded_at", () => {
    const transcripts = loadTranscripts();
    expect(transcripts.length).toBe(55);
    expect(transcripts[0].recorded_at).toBeTruthy();
  });
});

describe("fuzzy carrier matching", () => {
  it("matches spoken-out initials (s m r -> SMR)", () => {
    const hit = fuzzyFindCarrierProfile("s m r Trucking Inc");
    expect(hit?.profile.company_name).toBe("SMR TRUCKING INC");
    expect(hit?.score).toBeGreaterThanOrEqual(0.9);
  });

  it("tolerates misspellings (Capitol -> Capital)", () => {
    const hit = fuzzyFindCarrierProfile("Capitol City Transport");
    expect(hit?.profile.company_name).toBe("Capital City Transport");
  });

  it("ignores legal suffix and word order", () => {
    expect(companyNameSimilarity("G2 Logistics", "G2 LOGISTICS INC")).toBeGreaterThanOrEqual(0.9);
  });

  it("rejects unrelated names", () => {
    expect(fuzzyFindCarrierProfile("Totally Unrelated Widgets")).toBeNull();
  });

  it("falls back to carrier name when MC lookup misses", () => {
    const carrier = findCarrierProfile({ mc_number: "000000", company_name: "s m r trucking" });
    expect(carrier?.company_name).toBe("SMR TRUCKING INC");
  });
});

describe("fuzzy load recovery", () => {
  it("returns the exact load when it exists", () => {
    const hits = findLoadFuzzy("29372343");
    expect(hits[0]?.load_id).toBe("29372343");
  });

  it("recovers a load from an off-by-one-digit typo", () => {
    const typo = "29372344"; // 29372343 with last digit changed
    const hits = findLoadFuzzy(typo);
    expect(hits.map((l) => l.load_id)).toContain("29372343");
  });

  it("returns nothing for a wildly wrong number", () => {
    expect(findLoadFuzzy("10000000")).toHaveLength(0);
  });
});

describe("structured load search (no load id)", () => {
  it("finds a load by lane + equipment", () => {
    const { matches } = searchLoads({ originState: "PA", destinationState: "MD", equipmentType: "Box Truck" });
    expect(matches.length).toBeGreaterThan(0);
    expect(matches.every((m) => m.load.origin_state === "PA" && m.load.destination_state === "MD")).toBe(true);
  });

  it("relaxes the softest filters when nothing matches them all (call_013 scenario)", () => {
    // PA→MD box truck posted at $440 open — no exact match exists in the data.
    const { matches, relaxed } = searchLoads({
      originState: "PA",
      destinationState: "MD",
      equipmentType: "Box Truck",
      offeredRate: 440,
      status: "open",
    });
    expect(matches.length).toBeGreaterThan(0);
    expect(relaxed).toContain("offeredRate");
  });

  it("respects rate tolerance when a close match exists", () => {
    const { matches, relaxed } = searchLoads({
      equipmentType: "Box Truck",
      status: "open",
      offeredRate: 420,
      rateTolerance: 30,
    });
    expect(relaxed).toHaveLength(0);
    expect(matches.every((m) => Math.abs(m.load.offered_rate_usd - 420) <= 30)).toBe(true);
  });

  it("ranks higher-confidence matches first", () => {
    const { matches } = searchLoads({ equipmentType: "Box Truck", limit: 50 });
    for (let i = 1; i < matches.length; i++) {
      expect(matches[i - 1].confidence).toBeGreaterThanOrEqual(matches[i].confidence);
    }
  });

  it("flags low-confidence relaxed matches for human verification", () => {
    // call_013: only a delivered $575 PA→MD box truck exists vs. an open $440 ask.
    const res = searchLoads({
      originState: "PA",
      destinationState: "MD",
      equipmentType: "Box Truck",
      offeredRate: 440,
      status: "open",
    });
    expect(res.relaxed.length).toBeGreaterThan(0);
    expect(res.topConfidence).toBeLessThan(LOAD_MATCH_VERIFY_THRESHOLD);
    expect(res.needsHumanVerification).toBe(true);
    // The relaxed criteria should show up as "missed" on the candidate.
    expect(res.matches[0].missed).toContain("status");
  });

  it("does not require verification for a strong full-criteria match", () => {
    // Pick a real open box-truck load and search by its own attributes.
    const seed = searchLoads({ equipmentType: "Box Truck", status: "open", limit: 1 }).matches[0].load;
    const res = searchLoads({
      originState: seed.origin_state,
      destinationState: seed.destination_state,
      equipmentType: seed.equipment_type,
      status: "open",
      offeredRate: seed.offered_rate_usd,
    });
    expect(res.relaxed).toHaveLength(0);
    expect(res.topConfidence).toBe(1);
    expect(res.needsHumanVerification).toBe(false);
  });
});
