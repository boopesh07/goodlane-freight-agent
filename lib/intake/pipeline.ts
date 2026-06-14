import {
  findEmailById,
  findLoad,
  findLoadFuzzy,
  findTranscriptById,
  getEmailHistoryBefore,
  getRateHistoryBefore,
  loadTranscripts,
  normalizeMc,
  searchLoads,
  type LoadMatch,
} from "@/lib/data/loaders";
import {
  classifyIntent,
  crossReferenceIngestion,
  extractIdentifiers,
  resolveCarrier,
  resolveLoad,
  type CarrierResolution,
  type ValidationFinding,
} from "@/lib/ingestion/context";
import type { CallTranscript, CarrierEmail, CarrierProfile, Load, RateHistoryRow } from "@/lib/data/types";

/**
 * Deterministic intake pipeline.
 *
 * Design: the LLM is used ONLY to extract structured fields from messy inputs
 * (calls, offline) and to draft the reply email (see lib/intake/draft.ts).
 * Everything in THIS module — retrieval, identifier resolution, cross-reference
 * validation, rate math, the timeline, and the recommendation — is deterministic
 * code over the typed data tools. The agent therefore answers only from
 * retrieved facts and never hallucinates a number, carrier, or load.
 */

export type RateOffer = {
  source: "email" | "call";
  source_id: string;
  carrier_name: string | null;
  mc_number: string | null;
  rate_usd: number;
  timestamp: string;
};

export type TimelineItem = {
  timestamp: string;
  channel: "email" | "call";
  id: string;
  summary: string;
};

export type ComplianceFlag = { severity: "warning" | "error"; message: string };

export type LoadResolution = {
  load: Load | null;
  matchedBy: "load_id" | "fuzzy_id" | "structured_search" | "none";
  confidence: number;
  candidates: Load[];
  needsHumanVerification: boolean;
};

export type IntakeExtraction = {
  mc_number: string | null;
  company_name: string | null;
  load_reference: string | null;
  origin_state: string | null;
  destination_state: string | null;
  equipment: string | null;
  carrier_rate_usd: number | null;
  questions: string[];
};

export type IntakeResult = {
  channel: "email" | "call";
  recordId: string;
  asOf: string;
  intent: string;
  extraction: IntakeExtraction;
  carrier: { profile: CarrierProfile | null; matchedBy: CarrierResolution["matchedBy"]; confidence?: number };
  load: LoadResolution;
  scope: "load" | "carrier" | "none";
  emailHistory: CarrierEmail[];
  callHistory: Array<Pick<CallTranscript, "call_id" | "type" | "recorded_at"> & { extracted: CallTranscript["extracted"] }>;
  rateContext: { lane: string | null; equipment: string | null; avg_rate_per_mile: number | null; market_total_usd: number | null };
  offers: RateOffer[];
  bestOffer: RateOffer | null;
  compliance: ComplianceFlag[];
  validation: ValidationFinding[];
  timeline: TimelineItem[];
  summary: string[];
  recommendation: string;
};

const DATASET_NOW = "2026-05-25T23:59:59Z";

/* ----------------------------- extraction ----------------------------- */

function emailExtraction(email: CarrierEmail): IntakeExtraction {
  return {
    mc_number: email.mc_number,
    company_name: email.from_name,
    load_reference: email.load_reference,
    origin_state: null,
    destination_state: null,
    equipment: email.equipment_mentioned,
    carrier_rate_usd: email.rate_quoted_usd,
    questions: [],
  };
}

function callExtraction(call: CallTranscript): IntakeExtraction {
  const ex = call.extracted;
  return {
    mc_number: ex?.mc_number ?? null,
    company_name: ex?.company_name ?? null,
    load_reference: ex?.load_reference ?? null,
    origin_state: ex?.origin_state ?? null,
    destination_state: ex?.destination_state ?? null,
    equipment: ex?.equipment ?? null,
    carrier_rate_usd: ex?.carrier_rate_usd ?? null,
    questions: ex?.questions ?? [],
  };
}

/* ----------------------------- load resolve ----------------------------- */

function resolveLoadDeterministic(
  ids: ReturnType<typeof extractIdentifiers>,
  ex: IntakeExtraction,
): LoadResolution {
  // 1. exact id
  const exact = resolveLoad(ids);
  if (exact) {
    return { load: exact, matchedBy: "load_id", confidence: 1, candidates: [], needsHumanVerification: false };
  }
  // 2. fuzzy id recovery for mistyped numbers
  for (const ref of ids.loadRefCandidates) {
    if (findLoad(ref)) continue;
    const near = findLoadFuzzy(ref);
    if (near.length) {
      return {
        load: near[0],
        matchedBy: "fuzzy_id",
        confidence: 0.7,
        candidates: near,
        needsHumanVerification: true,
      };
    }
  }
  // 3. structured search by lane/equipment/rate (e.g. a call with no load id)
  if (ex.origin_state || ex.destination_state || ex.equipment) {
    const { matches, topConfidence, needsHumanVerification } = searchLoads({
      originState: ex.origin_state ?? undefined,
      destinationState: ex.destination_state ?? undefined,
      equipmentType: ex.equipment ?? undefined,
      offeredRate: ex.carrier_rate_usd ?? undefined,
      status: "open",
    });
    if (matches.length) {
      return {
        load: matches[0].load,
        matchedBy: "structured_search",
        confidence: topConfidence,
        candidates: matches.map((m: LoadMatch) => m.load),
        needsHumanVerification,
      };
    }
  }
  return { load: null, matchedBy: "none", confidence: 0, candidates: [], needsHumanVerification: true };
}

/* ----------------------------- email scoping ----------------------------- */

/**
 * Tight scoping — the fix for the "unwanted emails" problem. When the load is
 * known, history is the LOAD THREAD only (every carrier's emails on that load —
 * relevant for best-rate). We do NOT pull the carrier's unrelated cross-load
 * history. Only when there is no load do we fall back to the carrier's emails.
 */
function scopedEmailHistory(
  beforeTimestamp: string,
  load: Load | null,
  carrier: CarrierProfile | null,
  ids: ReturnType<typeof extractIdentifiers>,
): { emails: CarrierEmail[]; scope: IntakeResult["scope"] } {
  if (load) {
    return {
      emails: getEmailHistoryBefore({ beforeTimestamp, load_reference: load.load_id }),
      scope: "load",
    };
  }
  const mc = carrier?.mc_number ?? ids.mcNumbers[0];
  const fromEmail = carrier?.email ?? ids.fromEmail ?? undefined;
  if (mc || fromEmail) {
    const byMc = mc ? getEmailHistoryBefore({ beforeTimestamp, mc_number: mc }) : [];
    const byEmail = fromEmail ? getEmailHistoryBefore({ beforeTimestamp, from_email: fromEmail }) : [];
    const seen = new Set<string>();
    const emails = [...byMc, ...byEmail].filter((e) => (seen.has(e.email_id) ? false : seen.add(e.email_id)));
    emails.sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
    return { emails, scope: "carrier" };
  }
  return { emails: [], scope: "none" };
}

/* ----------------------------- rate / offers ----------------------------- */

/**
 * Mirror the email scoping: when the load is known, only calls that reference
 * THAT load count (so a carrier's calls about other loads don't leak into this
 * load's offers/timeline). Only when there's no load do we scope by carrier.
 */
function scopedCalls(beforeTimestamp: string, load: Load | null, carrier: CarrierProfile | null): CallTranscript[] {
  const beforeMs = Date.parse(beforeTimestamp);
  return loadTranscripts().filter((t) => {
    if (Date.parse(t.recorded_at) >= beforeMs) return false;
    const ex = t.extracted;
    if (load) return Boolean(ex?.load_reference && ex.load_reference === load.load_id);
    if (carrier?.mc_number) return Boolean(ex?.mc_number && normalizeMc(ex.mc_number) === normalizeMc(carrier.mc_number));
    return false;
  });
}

function collectOffers(emails: CarrierEmail[], calls: CallTranscript[]): RateOffer[] {
  const offers: RateOffer[] = [];
  for (const e of emails) {
    if (e.rate_quoted_usd != null) {
      offers.push({
        source: "email",
        source_id: e.email_id,
        carrier_name: e.from_name,
        mc_number: e.mc_number,
        rate_usd: e.rate_quoted_usd,
        timestamp: e.timestamp,
      });
    }
  }
  for (const c of calls) {
    const r = c.extracted?.carrier_rate_usd;
    if (r != null) {
      offers.push({
        source: "call",
        source_id: c.call_id,
        carrier_name: c.extracted?.company_name ?? null,
        mc_number: c.extracted?.mc_number ?? null,
        rate_usd: r,
        timestamp: c.recorded_at,
      });
    }
  }
  return offers;
}

function rateContextFor(beforeTimestamp: string, load: Load | null): IntakeResult["rateContext"] {
  if (!load) return { lane: null, equipment: null, avg_rate_per_mile: null, market_total_usd: null };
  const rows: RateHistoryRow[] = getRateHistoryBefore({
    beforeTimestamp,
    originState: load.origin_state,
    destinationState: load.destination_state,
    equipmentType: load.equipment_type,
  });
  const latest = rows[rows.length - 1] ?? null;
  const avg = latest?.avg_rate_per_mile ?? null;
  return {
    lane: `${load.origin_state}→${load.destination_state}`,
    equipment: load.equipment_type,
    avg_rate_per_mile: avg,
    market_total_usd: avg != null ? Math.round(avg * load.distance_miles) : null,
  };
}

/* ----------------------------- compliance ----------------------------- */

function complianceFlags(carrier: CarrierProfile | null): ComplianceFlag[] {
  if (!carrier) return [];
  const flags: ComplianceFlag[] = [];
  if (carrier.authority_status && carrier.authority_status !== "ACTIVE") {
    flags.push({ severity: "error", message: `Authority status is ${carrier.authority_status} (not ACTIVE).` });
  }
  if (!carrier.onboarded) flags.push({ severity: "warning", message: "Carrier is not onboarded with Goodlane." });
  if (carrier.insurance_expiry && Date.parse(carrier.insurance_expiry) < Date.parse(DATASET_NOW)) {
    flags.push({ severity: "error", message: `Insurance expired ${carrier.insurance_expiry}.` });
  }
  if (carrier.safety_rating && !/satisfactory/i.test(carrier.safety_rating)) {
    flags.push({ severity: "warning", message: `Safety rating: ${carrier.safety_rating}.` });
  }
  return flags;
}

/* ----------------------------- timeline ----------------------------- */

function buildTimeline(emails: CarrierEmail[], calls: CallTranscript[]): TimelineItem[] {
  const items: TimelineItem[] = [];
  for (const e of emails) {
    const rate = e.rate_quoted_usd != null ? `, offered $${e.rate_quoted_usd}` : "";
    items.push({
      timestamp: e.timestamp,
      channel: "email",
      id: e.email_id,
      summary: `${e.from_name} — ${e.subject}${rate}`,
    });
  }
  for (const c of calls) {
    const ex = c.extracted;
    const rate = ex?.carrier_rate_usd != null ? `, carrier asked $${ex.carrier_rate_usd}` : "";
    items.push({
      timestamp: c.recorded_at,
      channel: "call",
      id: c.call_id,
      summary: `${ex?.company_name ?? "carrier"} call (${c.type})${rate}`,
    });
  }
  items.sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
  return items;
}

/* ----------------------------- recommendation ----------------------------- */

function buildRecommendation(
  load: LoadResolution,
  carrier: CarrierProfile | null,
  compliance: ComplianceFlag[],
  bestOffer: RateOffer | null,
  rateContext: IntakeResult["rateContext"],
): string {
  if (!load.load) {
    return "No load could be matched from the inquiry. Ask the carrier to confirm the load number or lane before proceeding.";
  }
  if (load.needsHumanVerification) {
    return `Load matched only at ${Math.round(load.confidence * 100)}% confidence (${load.matchedBy}). Confirm with the carrier that this is load ${load.load.load_id} before quoting.`;
  }
  if (load.load.status !== "open") {
    return `Load ${load.load.load_id} is ${load.load.status}, not open. Let the carrier know it is no longer available.`;
  }
  const errors = compliance.filter((c) => c.severity === "error");
  if (errors.length) {
    return `Do not book: ${carrier?.company_name ?? "carrier"} has blocking compliance issues — ${errors.map((e) => e.message).join(" ")} Resolve before quoting.`;
  }
  if (bestOffer) {
    const vsMarket =
      rateContext.market_total_usd != null
        ? bestOffer.rate_usd <= rateContext.market_total_usd
          ? " (at or below market)"
          : " (above market)"
        : "";
    return `Best current offer on load ${load.load.load_id} is $${bestOffer.rate_usd} from ${bestOffer.carrier_name ?? "a carrier"}${vsMarket}. Posted rate is $${load.load.offered_rate_usd}. Reply to the carrier to confirm or counter.`;
  }
  return `Load ${load.load.load_id} is open at $${load.load.offered_rate_usd} (${rateContext.lane ?? ""}). No carrier rate on offer yet — reply with the posted rate to move it forward.`;
}

/* ----------------------------- assemble ----------------------------- */

function assemble(
  channel: "email" | "call",
  recordId: string,
  asOf: string,
  intent: string,
  ex: IntakeExtraction,
  carrierRes: CarrierResolution,
  load: LoadResolution,
  scope: IntakeResult["scope"],
  emails: CarrierEmail[],
  calls: CallTranscript[],
  validation: ValidationFinding[],
): IntakeResult {
  const carrier = carrierRes.carrier;
  const rateContext = rateContextFor(asOf, load.load);
  const offers = collectOffers(emails, calls).sort((a, b) => a.rate_usd - b.rate_usd);
  const bestOffer = offers[0] ?? null;
  const compliance = complianceFlags(carrier);
  const timeline = buildTimeline(emails, calls);
  const recommendation = buildRecommendation(load, carrier, compliance, bestOffer, rateContext);

  const summary = [
    `Carrier: ${carrier?.company_name ?? ex.company_name ?? "unresolved"}${carrier?.mc_number ? ` (MC ${carrier.mc_number})` : ""} · intent: ${intent}`,
    load.load
      ? `Load ${load.load.load_id}: ${load.load.origin_city}, ${load.load.origin_state} → ${load.load.destination_city}, ${load.load.destination_state} · ${load.load.equipment_type} · ${load.load.status}`
      : "Load: not resolved from the inquiry",
    bestOffer
      ? `Best offer: $${bestOffer.rate_usd} from ${bestOffer.carrier_name ?? "carrier"}${load.load ? ` (posted $${load.load.offered_rate_usd})` : ""}`
      : load.load
        ? `No carrier rate on offer yet (posted $${load.load.offered_rate_usd})`
        : "No rate context",
    `Next: ${recommendation.replace(/\.$/, "")}`,
  ];

  return {
    channel,
    recordId,
    asOf,
    intent,
    extraction: ex,
    carrier: { profile: carrier, matchedBy: carrierRes.matchedBy, confidence: carrierRes.score },
    load,
    scope,
    emailHistory: emails,
    callHistory: calls.map((c) => ({ call_id: c.call_id, type: c.type, recorded_at: c.recorded_at, extracted: c.extracted })),
    rateContext,
    offers,
    bestOffer,
    compliance,
    validation,
    timeline,
    summary,
    recommendation,
  };
}

/* ----------------------------- entry points ----------------------------- */

export function runEmailIntake(emailId: string): IntakeResult {
  const email = findEmailById(emailId);
  if (!email) throw new Error(`Email not found: ${emailId}`);
  const asOf = email.timestamp;
  const ex = emailExtraction(email);
  const intent = classifyIntent(email);
  const ids = extractIdentifiers(email);
  const carrierRes = resolveCarrier(ids);
  const load = resolveLoadDeterministic(ids, ex);
  const { findings } = crossReferenceIngestion(ids, carrierRes, load.load);
  const { emails, scope } = scopedEmailHistory(asOf, load.load, carrierRes.carrier, ids);
  const withoutSelf = emails.filter((e) => e.email_id !== emailId);
  const calls = scopedCalls(asOf, load.load, carrierRes.carrier);
  return assemble("email", emailId, asOf, intent, ex, carrierRes, load, scope, withoutSelf, calls, findings);
}

export function runCallIntake(callId: string): IntakeResult {
  const call = findTranscriptById(callId);
  if (!call) throw new Error(`Transcript not found: ${callId}`);
  const asOf = call.recorded_at;
  const ex = callExtraction(call);
  const intent = classifyIntent(call);
  const ids = extractIdentifiers(call);
  const carrierRes = resolveCarrier(ids);
  const load = resolveLoadDeterministic(ids, ex);
  const { findings } = crossReferenceIngestion(ids, carrierRes, load.load);
  const { emails, scope } = scopedEmailHistory(asOf, load.load, carrierRes.carrier, ids);
  const calls = scopedCalls(asOf, load.load, carrierRes.carrier).filter((c) => c.call_id !== callId);
  return assemble("call", callId, asOf, intent, ex, carrierRes, load, scope, emails, calls, findings);
}
