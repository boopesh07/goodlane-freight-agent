import fs from "node:fs";
import path from "node:path";
import { parse } from "csv-parse/sync";
import { paths } from "./paths";
import type {
  CallTranscript,
  CarrierEmail,
  CarrierProfile,
  Load,
  RateHistoryRow,
} from "./types";

function readJson<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
}

function parseCallNumber(callId: string): number {
  const match = callId.match(/(\d+)/);
  return match ? Number.parseInt(match[1], 10) : 0;
}

/** Spread call timestamps across the dataset window for timeline ordering. */
function syntheticRecordedAt(callId: string): string {
  const n = parseCallNumber(callId);
  const base = Date.parse("2026-05-10T08:00:00Z");
  const ms = base + n * 2 * 60 * 60 * 1000;
  return new Date(ms).toISOString();
}

function enrichTranscript(raw: Omit<CallTranscript, "recorded_at">): CallTranscript {
  return { ...raw, recorded_at: syntheticRecordedAt(raw.call_id) };
}

let carrierProfilesCache: CarrierProfile[] | null = null;
let carrierEmailsCache: CarrierEmail[] | null = null;
let loadsCache: Load[] | null = null;
let rateHistoryCache: RateHistoryRow[] | null = null;
let transcriptsCache: CallTranscript[] | null = null;

export function loadCarrierProfiles(): CarrierProfile[] {
  if (!carrierProfilesCache) {
    carrierProfilesCache = readJson<CarrierProfile[]>(paths.carrierProfiles);
  }
  return carrierProfilesCache;
}

export function loadCarrierEmails(): CarrierEmail[] {
  if (!carrierEmailsCache) {
    carrierEmailsCache = readJson<CarrierEmail[]>(paths.carrierEmails);
  }
  return carrierEmailsCache;
}

export function loadLoads(): Load[] {
  if (!loadsCache) {
    const csv = fs.readFileSync(paths.loads, "utf8");
    const rows = parse(csv, { columns: true, skip_empty_lines: true }) as Record<string, string>[];
    loadsCache = rows.map((row) => ({
      load_id: row.load_id,
      origin_city: row.origin_city,
      origin_state: row.origin_state,
      origin_zip: row.origin_zip,
      destination_city: row.destination_city,
      destination_state: row.destination_state,
      destination_zip: row.destination_zip,
      distance_miles: Number(row.distance_miles),
      equipment_type: row.equipment_type,
      weight_lbs: row.weight_lbs ? Number(row.weight_lbs) : null,
      pickup_date: row.pickup_date,
      pickup_window: row.pickup_window || null,
      delivery_date: row.delivery_date,
      offered_rate_usd: Number(row.offered_rate_usd),
      status: row.status as Load["status"],
      shipper_name: row.shipper_name || null,
      internal_notes: row.internal_notes || null,
    }));
  }
  return loadsCache;
}

export function loadRateHistory(): RateHistoryRow[] {
  if (!rateHistoryCache) {
    const csv = fs.readFileSync(paths.rateHistory, "utf8");
    const rows = parse(csv, { columns: true, skip_empty_lines: true }) as Record<string, string>[];
    rateHistoryCache = rows.map((row) => ({
      week_start: row.week_start,
      origin_state: row.origin_state,
      destination_state: row.destination_state,
      equipment_type: row.equipment_type,
      avg_rate_per_mile: Number(row.avg_rate_per_mile),
      min_rate_per_mile: Number(row.min_rate_per_mile),
      max_rate_per_mile: Number(row.max_rate_per_mile),
      load_volume: Number(row.load_volume),
    }));
  }
  return rateHistoryCache;
}

export function loadTranscripts(): CallTranscript[] {
  if (!transcriptsCache) {
    const raw = readJson<Omit<CallTranscript, "recorded_at">[]>(paths.transcripts);
    transcriptsCache = raw.map(enrichTranscript).sort(
      (a, b) => Date.parse(a.recorded_at) - Date.parse(b.recorded_at),
    );
  }
  return transcriptsCache;
}

export function parseTimestamp(value: string): number {
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) {
    throw new Error(`Invalid timestamp: ${value}`);
  }
  return ms;
}

export function isBefore(value: string, beforeTimestamp: string): boolean {
  return parseTimestamp(value) < parseTimestamp(beforeTimestamp);
}

export function normalizeMc(mc: string): string {
  return mc.replace(/\D/g, "");
}

/** Suffixes/qualifiers that carry no identifying signal for a carrier name. */
const COMPANY_STOPWORDS = new Set([
  "INC", "LLC", "LTD", "CORP", "CORPORATION", "CO", "COMPANY", "THE",
  "TRUCKING", "TRANSPORT", "TRANSPORTATION", "TRANS", "LOGISTICS",
  "CARRIERS", "CARRIER", "EXPRESS", "FREIGHT", "GROUP", "ENTERPRISES",
  "ENTERPRISE", "SERVICES", "SERVICE", "SHIPPING", "HAULING", "DELIVERY",
]);

/** Uppercase, strip punctuation, collapse whitespace. */
export function normalizeCompanyName(name: string): string {
  return name
    .toUpperCase()
    .replace(/[^A-Z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function companyTokens(name: string): string[] {
  return normalizeCompanyName(name).split(" ").filter(Boolean);
}

/** Tokens minus generic suffixes; falls back to all tokens if nothing is left. */
function significantTokens(name: string): string[] {
  const filtered = companyTokens(name).filter((t) => !COMPANY_STOPWORDS.has(t));
  return filtered.length > 0 ? filtered : companyTokens(name);
}

/** All alphanumerics, no spaces — collapses spoken-out names like "s m r" → "SMR". */
function compactName(name: string): string {
  return normalizeCompanyName(name).replace(/\s+/g, "");
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  let curr = new Array<number>(b.length + 1);
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[b.length];
}

function ratio(a: string, b: string): number {
  if (!a.length && !b.length) return 1;
  if (!a.length || !b.length) return 0;
  return 1 - levenshtein(a, b) / Math.max(a.length, b.length);
}

/**
 * Similarity in [0,1] between two carrier names, robust to legal suffixes,
 * word reordering, spoken-out initials ("s m r"), and minor misspellings.
 */
export function companyNameSimilarity(a: string, b: string): number {
  const ca = compactName(a);
  const cb = compactName(b);
  if (!ca || !cb) return 0;
  if (ca === cb) return 1;

  let best = ratio(ca, cb);

  // Compare the "significant" core (suffixes dropped), compacted.
  const sa = significantTokens(a).join("");
  const sb = significantTokens(b).join("");
  if (sa && sb) {
    best = Math.max(best, ratio(sa, sb));
    // Strong containment of a distinctive core counts as a near-match.
    if (sa.length >= 3 && (sb.includes(sa) || sa.includes(sb))) best = Math.max(best, 0.9);
  }

  // Token-set overlap (handles reordering / extra words).
  const ta = new Set(significantTokens(a));
  const tb = new Set(significantTokens(b));
  const union = new Set([...ta, ...tb]).size;
  if (union > 0) {
    const inter = [...ta].filter((t) => tb.has(t)).length;
    best = Math.max(best, inter / union);
  }

  return best;
}

/** Best fuzzy carrier match by company name, or null below the threshold. */
export function fuzzyFindCarrierProfile(
  name: string,
  threshold = 0.72,
): { profile: CarrierProfile; score: number } | null {
  if (!name.trim()) return null;
  let best: CarrierProfile | null = null;
  let bestScore = 0;
  for (const p of loadCarrierProfiles()) {
    if (!p.company_name) continue;
    const score = companyNameSimilarity(name, p.company_name);
    if (score > bestScore) {
      bestScore = score;
      best = p;
    }
  }
  return best && bestScore >= threshold ? { profile: best, score: bestScore } : null;
}

export function findCarrierProfile(args: {
  mc_number?: string;
  company_name?: string;
  email?: string;
}): CarrierProfile | null {
  const profiles = loadCarrierProfiles();
  if (args.mc_number) {
    const mc = normalizeMc(args.mc_number);
    if (mc) {
      const hit = profiles.find((p) => p.mc_number && normalizeMc(p.mc_number) === mc);
      if (hit) return hit;
    }
  }
  if (args.email) {
    const email = args.email.toLowerCase();
    const hit = profiles.find((p) => p.email?.toLowerCase() === email);
    if (hit) return hit;
  }
  if (args.company_name) {
    // Exact normalized match first, then substring, then fuzzy fallback.
    const target = normalizeCompanyName(args.company_name);
    const exact = profiles.find((p) => p.company_name && normalizeCompanyName(p.company_name) === target);
    if (exact) return exact;

    const needle = args.company_name.toLowerCase();
    const substr = profiles.find(
      (p) => p.company_name && p.company_name.toLowerCase().includes(needle),
    );
    if (substr) return substr;

    const fuzzy = fuzzyFindCarrierProfile(args.company_name);
    if (fuzzy) return fuzzy.profile;
  }
  return null;
}

export function findLoad(loadId: string): Load | null {
  return loadLoads().find((l) => l.load_id === loadId) ?? null;
}

/**
 * Recover the intended load when a reference doesn't match exactly — carriers
 * frequently misspeak/mistype load numbers. Returns the nearest valid load ids
 * by digit edit distance (closest first), empty if nothing is within range.
 */
export function findLoadFuzzy(loadId: string, maxDistance = 2): Load[] {
  const exact = findLoad(loadId);
  if (exact) return [exact];
  const digits = loadId.replace(/\D/g, "");
  if (!digits) return [];
  return loadLoads()
    .map((l) => ({ load: l, dist: levenshtein(digits, l.load_id.replace(/\D/g, "")) }))
    .filter((x) => x.dist > 0 && x.dist <= maxDistance)
    .sort((a, b) => a.dist - b.dist)
    .slice(0, 3)
    .map((x) => x.load);
}

export type LoadSearchCriteria = {
  originState?: string;
  destinationState?: string;
  equipmentType?: string;
  status?: string;
  offeredRate?: number;
  /** Max $ distance from offeredRate to still count as a match (default 50). */
  rateTolerance?: number;
  pickupDate?: string;
  limit?: number;
};

export type LoadMatch = {
  load: Load;
  /** 0..1 — how well this load satisfies the criteria the carrier gave. */
  confidence: number;
  matched: string[];
  missed: string[];
};

export type LoadSearchResult = {
  matches: LoadMatch[];
  /** Filters that had to be dropped to find any candidate. */
  relaxed: string[];
  /** Confidence of the best candidate (0 if none). */
  topConfidence: number;
  /** True when the best match is too weak to adopt without a human OK. */
  needsHumanVerification: boolean;
};

/** Below this, surface to the broker for confirmation before adopting. */
export const LOAD_MATCH_VERIFY_THRESHOLD = 0.85;

// Relative importance of each structured signal when scoring a candidate.
const CRITERION_WEIGHTS: Record<string, number> = {
  originState: 1,
  destinationState: 1,
  equipmentType: 1.5,
  status: 1.5,
  offeredRate: 1.5,
  pickupDate: 1,
};

function scoreLoad(load: Load, c: LoadSearchCriteria): Omit<LoadMatch, "load"> {
  let totalWeight = 0;
  let earned = 0;
  const matched: string[] = [];
  const missed: string[] = [];

  const consider = (field: keyof typeof CRITERION_WEIGHTS, satisfied: number) => {
    const w = CRITERION_WEIGHTS[field];
    totalWeight += w;
    earned += w * satisfied;
    if (satisfied >= 0.999) matched.push(field);
    else missed.push(field);
  };

  if (c.originState != null)
    consider("originState", c.originState.toUpperCase() === load.origin_state.toUpperCase() ? 1 : 0);
  if (c.destinationState != null)
    consider(
      "destinationState",
      c.destinationState.toUpperCase() === load.destination_state.toUpperCase() ? 1 : 0,
    );
  if (c.equipmentType != null)
    consider(
      "equipmentType",
      load.equipment_type.toLowerCase().includes(c.equipmentType.toLowerCase()) ? 1 : 0,
    );
  if (c.status != null) consider("status", load.status === c.status ? 1 : 0);
  if (c.pickupDate != null) consider("pickupDate", load.pickup_date === c.pickupDate ? 1 : 0);
  if (c.offeredRate != null) {
    const tol = c.rateTolerance ?? 50;
    const dist = Math.abs(load.offered_rate_usd - c.offeredRate);
    // Full credit within tolerance, decaying to 0 at 4× tolerance.
    const partial = dist <= tol ? 1 : Math.max(0, 1 - (dist - tol) / (tol * 3));
    consider("offeredRate", partial);
  }

  const confidence = totalWeight === 0 ? 0 : Math.round((earned / totalWeight) * 100) / 100;
  return { confidence, matched, missed };
}

/**
 * Find loads by structured attributes when no (valid) load id is available —
 * e.g. a carrier calls about "the PA→MD box truck posted at $440" without the
 * number. Lane + equipment anchor the search; rate/status/pickup refine it.
 * If the full criteria match nothing, the least-reliable filters (rate, then
 * status, then pickup) are relaxed in turn so the broker still gets candidates.
 * Every candidate carries a confidence score; when the best one is weak, the
 * result is flagged for human verification rather than adopted silently.
 */
export function searchLoads(criteria: LoadSearchCriteria): LoadSearchResult {
  const eq = (a: string | undefined, b: string) => !a || a.toUpperCase() === b.toUpperCase();

  const hardMatches = (c: LoadSearchCriteria) =>
    loadLoads().filter((l) => {
      if (!eq(c.originState, l.origin_state)) return false;
      if (!eq(c.destinationState, l.destination_state)) return false;
      if (c.equipmentType && !l.equipment_type.toLowerCase().includes(c.equipmentType.toLowerCase()))
        return false;
      if (c.status && l.status !== c.status) return false;
      if (c.pickupDate && l.pickup_date !== c.pickupDate) return false;
      if (c.offeredRate != null) {
        const tol = c.rateTolerance ?? 50;
        if (Math.abs(l.offered_rate_usd - c.offeredRate) > tol) return false;
      }
      return true;
    });

  // Progressively drop the softest filters until we find something.
  const relaxOrder: (keyof LoadSearchCriteria)[] = ["offeredRate", "status", "pickupDate"];
  let active: LoadSearchCriteria = { ...criteria };
  const relaxed: string[] = [];
  let hits = hardMatches(active);
  for (const field of relaxOrder) {
    if (hits.length > 0) break;
    if (active[field] == null) continue;
    active = { ...active, [field]: undefined };
    relaxed.push(field);
    hits = hardMatches(active);
  }

  // Always score against the FULL original criteria so confidence reflects the
  // relaxed filters the candidate may no longer satisfy.
  const scored: LoadMatch[] = hits
    .map((load) => ({ load, ...scoreLoad(load, criteria) }))
    .sort((a, b) => {
      if (b.confidence !== a.confidence) return b.confidence - a.confidence;
      if (a.load.status === "open" && b.load.status !== "open") return -1;
      if (b.load.status === "open" && a.load.status !== "open") return 1;
      return Date.parse(a.load.pickup_date) - Date.parse(b.load.pickup_date);
    })
    .slice(0, criteria.limit ?? 5);

  const topConfidence = scored[0]?.confidence ?? 0;
  return {
    matches: scored,
    relaxed,
    topConfidence,
    needsHumanVerification: scored.length > 0 && topConfidence < LOAD_MATCH_VERIFY_THRESHOLD,
  };
}

export function findEmailById(emailId: string): CarrierEmail | null {
  return loadCarrierEmails().find((e) => e.email_id === emailId) ?? null;
}

export function findTranscriptById(callId: string): CallTranscript | null {
  return loadTranscripts().find((t) => t.call_id === callId) ?? null;
}

export function getEmailHistoryBefore(args: {
  beforeTimestamp: string;
  mc_number?: string;
  load_reference?: string;
  from_email?: string;
}): CarrierEmail[] {
  let emails = loadCarrierEmails().filter((e) => isBefore(e.timestamp, args.beforeTimestamp));
  if (args.mc_number) {
    const mc = normalizeMc(args.mc_number);
    emails = emails.filter((e) => e.mc_number && normalizeMc(e.mc_number) === mc);
  }
  if (args.load_reference) {
    emails = emails.filter((e) => e.load_reference === args.load_reference);
  }
  if (args.from_email) {
    const addr = args.from_email.toLowerCase();
    emails = emails.filter((e) => e.from_email.toLowerCase() === addr);
  }
  return emails.sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
}

export function getRateHistoryBefore(args: {
  beforeTimestamp: string;
  originState?: string;
  destinationState?: string;
  equipmentType?: string;
}): RateHistoryRow[] {
  let rows = loadRateHistory().filter((row) => isBefore(row.week_start, args.beforeTimestamp));
  if (args.originState) rows = rows.filter((r) => r.origin_state === args.originState);
  if (args.destinationState) rows = rows.filter((r) => r.destination_state === args.destinationState);
  if (args.equipmentType) rows = rows.filter((r) => r.equipment_type === args.equipmentType);
  return rows.sort((a, b) => Date.parse(a.week_start) - Date.parse(b.week_start));
}

export function clearDataCache(): void {
  carrierProfilesCache = null;
  carrierEmailsCache = null;
  loadsCache = null;
  rateHistoryCache = null;
  transcriptsCache = null;
}

export function assertDataFilesExist(): void {
  for (const file of Object.values(paths)) {
    if (!fs.existsSync(file)) {
      throw new Error(`Missing data file: ${file}`);
    }
  }
}

export function dataRoot(): string {
  return path.dirname(paths.carrierProfiles);
}
