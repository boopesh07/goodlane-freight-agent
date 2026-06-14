import {
  findCarrierProfile,
  findLoad,
  findLoadFuzzy,
  fuzzyFindCarrierProfile,
  loadCarrierEmails,
  loadRateHistory,
  loadTranscripts,
  normalizeMc,
} from "@/lib/data/loaders";
import type { CallTranscript, CarrierEmail, CarrierProfile, Load } from "@/lib/data/types";

/**
 * Shared building blocks for the intake pipeline (lib/intake/pipeline.ts):
 * identifier extraction, intent classification, carrier/load resolution, and
 * cross-reference validation. All deterministic.
 */

/** Identifiers extracted from an inbound record, used to scope retrieval. */
export type ExtractedIdentifiers = {
  /** Load references that resolved to a real load (used for scoping). */
  loadRefs: string[];
  /** Every load-id-shaped token seen, resolved or not (used for validation). */
  loadRefCandidates: string[];
  mcNumbers: string[];
  carrierNames: string[];
  fromEmail: string | null;
};

/** A cross-reference / consistency check finding. */
export type ValidationFinding = {
  severity: "ok" | "warning" | "error";
  field: string;
  message: string;
};

export type CarrierResolution = {
  carrier: CarrierProfile | null;
  /** How the carrier was matched: mc | email | name (fuzzy) | none. */
  matchedBy: "mc" | "email" | "name" | "none";
  /** Fuzzy similarity score when matchedBy === "name". */
  score?: number;
};

// Load ids in this dataset are exactly 8 digits (e.g. 29372515); MC numbers are
// 5-7 digits. Matching exactly 8 avoids mistaking an MC for a load reference.
const LOAD_ID_RE = /\b(\d{8})\b/g;
const MC_RE = /\bMC[#:\s-]*([0-9][0-9\s-]{3,8}[0-9])\b/gi;
const SPOKEN_MC_RE = /\b(\d[\d\s-]{3,8}\d)\b/g;
const CARRIER_NAME_RE =
  /\b(?:from|this is|with|for)\s+([A-Z0-9][A-Za-z0-9'&.\- ]*?(?:Trucking|Transport|Transportation|Logistics|Carriers?|Express|Freight|Trans|LLC|Inc)\b\.?)/gi;

type ExtractionSets = {
  loadRefs: Set<string>;
  loadRefCandidates: Set<string>;
  mcNumbers: Set<string>;
  carrierNames: Set<string>;
};

/** Pull every load/MC/carrier-name signal out of an inbound email or call. */
export function extractIdentifiers(record: CarrierEmail | CallTranscript): ExtractedIdentifiers {
  const sets: ExtractionSets = {
    loadRefs: new Set(),
    loadRefCandidates: new Set(),
    mcNumbers: new Set(),
    carrierNames: new Set(),
  };
  let fromEmail: string | null = null;

  if ("email_id" in record) {
    fromEmail = record.from_email ?? null;
    if (record.load_reference) {
      sets.loadRefCandidates.add(record.load_reference);
      if (findLoad(record.load_reference)) sets.loadRefs.add(record.load_reference);
    }
    if (record.mc_number) sets.mcNumbers.add(normalizeMc(record.mc_number));
    if (record.from_name) sets.carrierNames.add(record.from_name);
    // Mine the body for additional references the structured fields missed.
    mineText(`${record.subject}\n${record.body}`, sets);
  } else {
    // Call identifiers come from LLM extraction (with per-field confidence).
    const ex = record.extracted;
    if (ex?.mc_number) sets.mcNumbers.add(normalizeMc(ex.mc_number));
    if (ex?.company_name) sets.carrierNames.add(ex.company_name);
    if (ex?.load_reference) {
      sets.loadRefCandidates.add(ex.load_reference);
      if (findLoad(ex.load_reference)) sets.loadRefs.add(ex.load_reference);
    }
  }

  return {
    loadRefs: [...sets.loadRefs],
    loadRefCandidates: [...sets.loadRefCandidates],
    mcNumbers: [...sets.mcNumbers].filter(Boolean),
    carrierNames: [...sets.carrierNames].map((n) => n.trim()).filter(Boolean),
    fromEmail,
  };
}

function mineText(text: string, sets: ExtractionSets): void {
  if (!text) return;

  for (const m of text.matchAll(LOAD_ID_RE)) {
    sets.loadRefCandidates.add(m[1]);
    if (findLoad(m[1])) sets.loadRefs.add(m[1]);
  }
  for (const m of text.matchAll(MC_RE)) {
    const mc = normalizeMc(m[1]);
    if (mc.length >= 5 && mc.length <= 6) sets.mcNumbers.add(mc);
  }
  // Bare 5-6 digit runs (spoken "776 491"): only keep if they don't look like a load id.
  for (const m of text.matchAll(SPOKEN_MC_RE)) {
    const mc = normalizeMc(m[1]);
    if (mc.length >= 5 && mc.length <= 6 && !findLoad(mc)) sets.mcNumbers.add(mc);
  }
  for (const m of text.matchAll(CARRIER_NAME_RE)) {
    sets.carrierNames.add(m[1].replace(/\s+/g, " ").trim());
  }
}

/**
 * Cross-reference the extracted identifiers against master data and flag
 * inconsistencies — carriers routinely send the wrong MC/email or misspell load
 * numbers. Also attempts to recover the intended load when a reference misses.
 */
export function crossReferenceIngestion(
  ids: ExtractedIdentifiers,
  carrierResolution: CarrierResolution,
  load: Load | null,
): { findings: ValidationFinding[]; loadCandidates: Load[] } {
  const findings: ValidationFinding[] = [];
  const loadCandidates: Load[] = [];

  // 1. Carrier identity must agree across MC, email, and name.
  const byMc = ids.mcNumbers.map((mc) => findCarrierProfile({ mc_number: mc })).find(Boolean) ?? null;
  const byEmail = ids.fromEmail ? findCarrierProfile({ email: ids.fromEmail }) : null;
  if (byMc && byEmail && byMc.mc_number !== byEmail.mc_number) {
    findings.push({
      severity: "warning",
      field: "carrier_identity",
      message: `MC ${byMc.mc_number} maps to "${byMc.company_name}" but the sender email maps to "${byEmail.company_name}". The carrier may have quoted the wrong MC or written from a different address — verify identity before replying.`,
    });
  }
  for (const mc of ids.mcNumbers) {
    if (!findCarrierProfile({ mc_number: mc })) {
      findings.push({
        severity: "warning",
        field: "mc_number",
        message: `MC ${mc} is not in carrier_profiles — possibly misspoken/mistyped, or a carrier we have not onboarded. Confirm via name/email.`,
      });
    }
  }
  if (!carrierResolution.carrier) {
    findings.push({
      severity: "error",
      field: "carrier",
      message: `Could not resolve a carrier profile from MC, email, or name. Ask the carrier to confirm their company name and MC.`,
    });
  } else if (carrierResolution.matchedBy === "name") {
    findings.push({
      severity: "warning",
      field: "carrier",
      message: `Carrier resolved only by fuzzy name match (score ${carrierResolution.score?.toFixed(2)}) → "${carrierResolution.carrier.company_name}". Confirm this is the right carrier.`,
    });
  }

  // 2. Recover misspelled / unresolved load numbers.
  for (const ref of ids.loadRefCandidates) {
    if (findLoad(ref)) continue;
    const near = findLoadFuzzy(ref);
    for (const l of near) if (!loadCandidates.some((c) => c.load_id === l.load_id)) loadCandidates.push(l);
    findings.push({
      severity: "error",
      field: "load_reference",
      message: near.length
        ? `Load "${ref}" does not exist. Closest valid load id(s): ${near.map((l) => `${l.load_id} (${l.origin_state}→${l.destination_state} ${l.equipment_type})`).join("; ")}. Likely a misspelled load number — confirm which load the carrier means.`
        : `Load "${ref}" does not exist and has no close match. Ask the carrier to confirm the load number.`,
    });
  }

  // 3. Load ↔ carrier consistency (equipment + lane).
  if (load && carrierResolution.carrier) {
    const c = carrierResolution.carrier;
    const lane = `${load.origin_state}-${load.destination_state}`;
    if (c.equipment_types?.length && !c.equipment_types.includes(load.equipment_type)) {
      findings.push({
        severity: "warning",
        field: "equipment",
        message: `Load ${load.load_id} needs ${load.equipment_type}, but ${c.company_name} lists equipment [${c.equipment_types.join(", ")}]. Confirm they can cover it.`,
      });
    }
    if (c.preferred_lanes?.length && !c.preferred_lanes.includes(lane)) {
      findings.push({
        severity: "warning",
        field: "lane",
        message: `Load lane ${lane} is outside ${c.company_name}'s preferred lanes [${c.preferred_lanes.join(", ")}] — not disqualifying, but worth noting.`,
      });
    }
  }

  if (findings.length === 0 && load && carrierResolution.carrier) {
    findings.push({
      severity: "ok",
      field: "all",
      message: `Carrier (${carrierResolution.carrier.company_name}) and load ${load.load_id} cross-checked and consistent.`,
    });
  }

  return { findings, loadCandidates };
}

/** Classify the inbound record's intent (structured field first, keyword fallback). */
export function classifyIntent(record: CarrierEmail | CallTranscript): string {
  if ("email_id" in record) {
    if (record.intent) return record.intent;
    return keywordIntent(`${record.subject} ${record.body}`);
  }
  if (record.type && record.type !== "unknown") return record.type;
  return keywordIntent(record.transcript);
}

function keywordIntent(text: string): string {
  const t = text.toLowerCase();
  if (/\b(insurance|authority|compliance|coi|certificate|safety rating)\b/.test(t)) return "compliance_check";
  if (/\b(available|availability|can take|got a truck|empty|free on)\b/.test(t)) return "availability_check";
  if (/\b(rate|price|\$|per mile|negotiate|counter|how much)\b/.test(t)) return "rate_negotiation";
  if (/\b(confirm|booked|book it|accept|take it)\b/.test(t)) return "confirm";
  if (/\b(weight|dimensions|pickup|delivery|details|when|where)\b/.test(t)) return "load_details";
  return "inquiry";
}

/** Resolve the carrier: MC → email → fuzzy carrier name. Carrier should (almost) always be found. */
export function resolveCarrier(ids: ExtractedIdentifiers): CarrierResolution {
  for (const mc of ids.mcNumbers) {
    const carrier = findCarrierProfile({ mc_number: mc });
    if (carrier) return { carrier, matchedBy: "mc" };
  }
  if (ids.fromEmail) {
    const carrier = findCarrierProfile({ email: ids.fromEmail });
    if (carrier) return { carrier, matchedBy: "email" };
  }
  let best: { profile: CarrierProfile; score: number } | null = null;
  for (const name of ids.carrierNames) {
    const hit = fuzzyFindCarrierProfile(name);
    if (hit && (!best || hit.score > best.score)) best = hit;
  }
  if (best) return { carrier: best.profile, matchedBy: "name", score: best.score };
  return { carrier: null, matchedBy: "none" };
}

export function resolveLoad(ids: ExtractedIdentifiers): Load | null {
  for (const ref of ids.loadRefs) {
    const load = findLoad(ref);
    if (load) return load;
  }
  return null;
}

export type TimelineChartPoint = {
  kind: "email" | "rate" | "call";
  timestamp: string;
  id: string;
  label: string;
};

export type TimelineChartData = {
  points: TimelineChartPoint[];
  domain: { min: string; max: string };
  emailCount: number;
  rateCount: number;
};

export function buildTimelineChartData(): TimelineChartData {
  const points: TimelineChartPoint[] = [];

  for (const email of loadCarrierEmails()) {
    points.push({
      kind: "email",
      timestamp: email.timestamp,
      id: email.email_id,
      label: `${email.from_name}: ${email.subject.slice(0, 40)}`,
    });
  }

  for (const row of loadRateHistory()) {
    points.push({
      kind: "rate",
      timestamp: `${row.week_start}T00:00:00Z`,
      id: `${row.week_start}-${row.origin_state}-${row.destination_state}-${row.equipment_type}`,
      label: `${row.origin_state}→${row.destination_state} ${row.equipment_type} $${row.avg_rate_per_mile}/mi`,
    });
  }

  for (const transcript of loadTranscripts()) {
    points.push({
      kind: "call",
      timestamp: transcript.recorded_at,
      id: transcript.call_id,
      label: `Call ${transcript.call_id} (${transcript.type})`,
    });
  }

  // Collapse the dense per-lane rate rows into one point per week for the chart.
  const rateWeeks = new Map<string, number>();
  for (const p of points.filter((x) => x.kind === "rate")) {
    const week = p.timestamp.slice(0, 10);
    rateWeeks.set(week, (rateWeeks.get(week) ?? 0) + 1);
  }
  const rateChartPoints: TimelineChartPoint[] = [...rateWeeks.entries()].map(([week, count]) => ({
    kind: "rate" as const,
    timestamp: `${week}T00:00:00Z`,
    id: week,
    label: `Rate history week ${week} (${count} lane rows)`,
  }));

  // Keep emails + calls as individual points; rates use the per-week summary.
  const nonRatePoints = points.filter((p) => p.kind !== "rate");
  const chartPoints = [...nonRatePoints, ...rateChartPoints];

  chartPoints.sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));

  const timestamps = chartPoints.map((p) => Date.parse(p.timestamp)).filter((t) => !Number.isNaN(t));
  const min = timestamps.length ? new Date(Math.min(...timestamps)).toISOString() : new Date().toISOString();
  const max = timestamps.length ? new Date(Math.max(...timestamps)).toISOString() : new Date().toISOString();

  return {
    points: chartPoints,
    domain: { min, max },
    emailCount: chartPoints.filter((p) => p.kind === "email").length,
    rateCount: loadRateHistory().length,
  };
}

export type RecordListItem =
  | {
      kind: "email";
      id: string;
      timestamp: string;
      label: string;
      preview: string;
    }
  | {
      kind: "transcript";
      id: string;
      timestamp: string;
      label: string;
      preview: string;
    };

export function listIngestionRecords(): RecordListItem[] {
  const emails: RecordListItem[] = loadCarrierEmails()
    .map((e) => ({
      kind: "email" as const,
      id: e.email_id,
      timestamp: e.timestamp,
      label: `${e.email_id} · ${e.from_name}`,
      preview: e.subject,
    }))
    .sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp));

  const transcripts: RecordListItem[] = loadTranscripts()
    .map((t) => ({
      kind: "transcript" as const,
      id: t.call_id,
      timestamp: t.recorded_at,
      label: `${t.call_id} · ${t.type}`,
      preview: t.transcript.replace(/\n/g, " ").slice(0, 80),
    }))
    .sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp));

  return [...emails, ...transcripts];
}
