import {
  findCarrierProfile,
  findEmailById,
  findLoad,
  findLoadFuzzy,
  findTranscriptById,
  fuzzyFindCarrierProfile,
  getEmailHistoryBefore,
  getRateHistoryBefore,
  loadCarrierEmails,
  loadRateHistory,
  loadTranscripts,
  normalizeMc,
} from "@/lib/data/loaders";
import type { CallTranscript, CarrierEmail, CarrierProfile, Load, RateHistoryRow } from "@/lib/data/types";

export type IngestionKind = "email" | "transcript";

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

/** A cross-reference / consistency check finding surfaced to the agent. */
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

export type IngestionContext = {
  kind: IngestionKind;
  ingestionTimestamp: string;
  ingested: CarrierEmail | CallTranscript;
  intent: string;
  identifiers: ExtractedIdentifiers;
  carrierResolution: CarrierResolution;
  validation: ValidationFinding[];
  loadCandidates: Load[];
  emailHistory: CarrierEmail[];
  rateHistory: RateHistoryRow[];
  load: Load | null;
  carrier: CarrierProfile | null;
};

// Load ids in this dataset are 8-digit (e.g. 29372515); MC numbers are 5-6 digit.
const LOAD_ID_RE = /\b(\d{7,9})\b/g;
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
    // Prefer the call-side extraction pipeline's structured fields; fall back to
    // mining the raw transcript text for anything it missed.
    const ex = record.extracted;
    if (ex?.mc_number) sets.mcNumbers.add(normalizeMc(ex.mc_number));
    if (ex?.company_name) sets.carrierNames.add(ex.company_name);
    if (ex?.load_reference) {
      sets.loadRefCandidates.add(ex.load_reference);
      if (findLoad(ex.load_reference)) sets.loadRefs.add(ex.load_reference);
    }
    mineText(record.transcript, sets);
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
function resolveCarrier(ids: ExtractedIdentifiers): CarrierResolution {
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

function resolveLoad(ids: ExtractedIdentifiers): Load | null {
  for (const ref of ids.loadRefs) {
    const load = findLoad(ref);
    if (load) return load;
  }
  return null;
}

function rateHistoryForIngestion(
  beforeTimestamp: string,
  load: Load | null,
): RateHistoryRow[] {
  return getRateHistoryBefore({
    beforeTimestamp,
    originState: load?.origin_state,
    destinationState: load?.destination_state,
    equipmentType: load?.equipment_type,
  });
}

/**
 * Strictly scope prior email history to the SAME load or SAME carrier as the
 * ingested record. Never falls back to "all emails" — an empty result is
 * correct and keeps unrelated carriers out of the agent's context.
 */
function emailHistoryForIngestion(
  beforeTimestamp: string,
  ids: ExtractedIdentifiers,
  carrier: CarrierProfile | null,
): CarrierEmail[] {
  const allBefore = getEmailHistoryBefore({ beforeTimestamp });

  const loadRefs = new Set(ids.loadRefs);
  const mcNumbers = new Set(ids.mcNumbers);
  if (carrier?.mc_number) mcNumbers.add(normalizeMc(carrier.mc_number));
  const emails = new Set<string>();
  if (ids.fromEmail) emails.add(ids.fromEmail.toLowerCase());
  if (carrier?.email) emails.add(carrier.email.toLowerCase());

  // Nothing to scope by → return nothing rather than every carrier's mail.
  if (loadRefs.size === 0 && mcNumbers.size === 0 && emails.size === 0) return [];

  return allBefore.filter((email) => {
    if (email.load_reference && loadRefs.has(email.load_reference)) return true;
    if (email.mc_number && mcNumbers.has(normalizeMc(email.mc_number))) return true;
    if (email.from_email && emails.has(email.from_email.toLowerCase())) return true;
    return false;
  });
}

export function buildEmailIngestionContext(emailId: string): IngestionContext {
  const ingested = findEmailById(emailId);
  if (!ingested) {
    throw new Error(`Email not found: ${emailId}`);
  }

  const identifiers = extractIdentifiers(ingested);
  const intent = classifyIntent(ingested);
  const load = resolveLoad(identifiers);
  const carrierResolution = resolveCarrier(identifiers);
  const { findings, loadCandidates } = crossReferenceIngestion(identifiers, carrierResolution, load);

  return {
    kind: "email",
    ingestionTimestamp: ingested.timestamp,
    ingested,
    intent,
    identifiers,
    carrierResolution,
    validation: findings,
    loadCandidates,
    emailHistory: emailHistoryForIngestion(ingested.timestamp, identifiers, carrierResolution.carrier),
    rateHistory: rateHistoryForIngestion(ingested.timestamp, load),
    load,
    carrier: carrierResolution.carrier,
  };
}

export function buildTranscriptIngestionContext(callId: string): IngestionContext {
  const ingested = findTranscriptById(callId);
  if (!ingested) {
    throw new Error(`Transcript not found: ${callId}`);
  }

  const identifiers = extractIdentifiers(ingested);
  const intent = classifyIntent(ingested);
  const load = resolveLoad(identifiers);
  const carrierResolution = resolveCarrier(identifiers);
  const { findings, loadCandidates } = crossReferenceIngestion(identifiers, carrierResolution, load);

  return {
    kind: "transcript",
    ingestionTimestamp: ingested.recorded_at,
    ingested,
    intent,
    identifiers,
    carrierResolution,
    validation: findings,
    loadCandidates,
    emailHistory: emailHistoryForIngestion(ingested.recorded_at, identifiers, carrierResolution.carrier),
    rateHistory: rateHistoryForIngestion(ingested.recorded_at, load),
    load,
    carrier: carrierResolution.carrier,
  };
}

export function formatIngestionSystemContext(ctx: IngestionContext): string {
  const ingestedJson =
    ctx.kind === "email"
      ? JSON.stringify(ctx.ingested, null, 2)
      : JSON.stringify(
          { ...ctx.ingested, segments: undefined },
          null,
          2,
        );

  const ids = ctx.identifiers;
  const carrierLine = ctx.carrier
    ? `${ctx.carrier.company_name} (MC ${ctx.carrier.mc_number ?? "?"}) — matched by ${ctx.carrierResolution.matchedBy}${
        ctx.carrierResolution.score != null ? ` (fuzzy score ${ctx.carrierResolution.score.toFixed(2)})` : ""
      }`
    : "NOT RESOLVED — retry get_carrier_profile with the carrier name(s) below before answering";

  const validationLines = ctx.validation.length
    ? ctx.validation.map((f) => `- [${f.severity.toUpperCase()}] ${f.field}: ${f.message}`).join("\n")
    : "- No identifiers to cross-reference.";

  const candidateLines = ctx.loadCandidates.length
    ? `\nPOSSIBLE INTENDED LOADS (for unresolved/misspelled references):\n${JSON.stringify(ctx.loadCandidates, null, 2)}\n`
    : "";

  // No load id resolved → force a structured get_load search before answering.
  const loadActionLine = ctx.load
    ? ""
    : `\nACTION REQUIRED — NO LOAD RESOLVED: This ${ctx.kind} references a load but no usable load id was found. Before writing your answer you MUST call get_load with the structured fields you can read from the ${ctx.kind} (origin_state, destination_state, equipment_type, offered_rate, status:"open"). Report the returned confidence score; if needs_human_verification is true, present the candidate with its confidence and ASK THE BROKER TO CONFIRM the load — do not quote a rate or draft a reply as if it were confirmed.\n`;

  return `

INGESTION MODE — ${ctx.kind.toUpperCase()}
The broker is processing a new inbound ${ctx.kind}. Treat ${ctx.ingestionTimestamp} as the ingestion timestamp.

DETECTED INTENT: ${ctx.intent}

EXTRACTED IDENTIFIERS:
- load_refs: ${ids.loadRefs.length ? ids.loadRefs.join(", ") : "none"}
- mc_numbers: ${ids.mcNumbers.length ? ids.mcNumbers.join(", ") : "none"}
- carrier_names: ${ids.carrierNames.length ? ids.carrierNames.join(", ") : "none"}
- from_email: ${ids.fromEmail ?? "none"}

RESOLVED CARRIER: ${carrierLine}

CROSS-REFERENCE & VALIDATION (resolve every flag before replying — carriers often send the wrong MC/email or misspell load numbers):
${validationLines}
${candidateLines}${loadActionLine}
CRITICAL: Email history is scoped to THIS load/carrier only (same load_reference or same MC/email). Email and rate history were pre-fetched with timestamps STRICTLY BEFORE ${ctx.ingestionTimestamp}. Do not include later events. You may still call get_carrier_profile and get_load for additional facts.

PRE-FETCHED EMAIL HISTORY (${ctx.emailHistory.length} records — scoped to this load/carrier, all before ingestion):
${JSON.stringify(ctx.emailHistory.slice(0, 30), null, 2)}

PRE-FETCHED RATE HISTORY (${ctx.rateHistory.length} rows, all before ingestion${ctx.load ? ` for ${ctx.load.origin_state}→${ctx.load.destination_state} ${ctx.load.equipment_type}` : ""}):
${JSON.stringify(ctx.rateHistory.slice(0, 20), null, 2)}

${ctx.load ? `RELATED LOAD:\n${JSON.stringify(ctx.load, null, 2)}\n` : ""}${ctx.carrier ? `CARRIER PROFILE:\n${JSON.stringify(ctx.carrier, null, 2)}\n` : ""}
INGESTED ${ctx.kind.toUpperCase()} (respond to THIS):
${ingestedJson}

Deliver, in this order:
1. **Quick summary** — exactly 4 lines: (a) who the carrier is + intent, (b) the load/lane in question, (c) the key number (rate/availability) or open question, (d) the headline recommendation. Note any unresolved cross-reference flag here.
2. **Timeline** of prior email/call activity (before ingestion only)
3. **Analysis** of the ingested ${ctx.kind}, explicitly addressing every cross-reference flag above
4. **Recommended next action** for the broker
5. **Sources** — a short bullet list previewing the records you relied on (id + 1-line preview of the retrieved data) so the broker can audit it`;
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
