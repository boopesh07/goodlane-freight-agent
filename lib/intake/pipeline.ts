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
import { paths } from "@/lib/data/paths";
import {
  classifyIntent,
  crossReferenceIngestion,
  extractIdentifiers,
  resolveCarrier,
  resolveLoad,
  type CarrierResolution,
  type ValidationFinding,
} from "@/lib/ingestion/context";
import type {
  CallExtraction,
  CallExtractionScores,
  CallTranscript,
  CarrierEmail,
  CarrierProfile,
  Load,
  RateHistoryRow,
} from "@/lib/data/types";

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

/** A deterministic data lookup, surfaced so the UI can show what was retrieved. */
export type RetrievalStep = {
  tool: string;
  args: Record<string, unknown>;
  summary: string;
  data: unknown;
};

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
  /** Per-field confidence from LLM call extraction (calls only). */
  fieldScores?: CallExtractionScores;
  extractionWarnings?: string[];
};

export type IntakeResult = {
  channel: "email" | "call";
  recordId: string;
  asOf: string;
  intent: string;
  /** Source file the inbound record was read from. */
  sourceFile: string;
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
  /** Deterministic tool lookups performed during intake (mirrors agent tools). */
  retrievals: RetrievalStep[];
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
  return toIntakeExtraction(
    ex ?? {
      carrier_speaker: null,
      mc_number: null,
      company_name: null,
      load_reference: null,
      origin_state: null,
      destination_state: null,
      carrier_rate_usd: null,
      dispatcher_rate_usd: null,
      equipment: null,
      available_location: null,
      available_date: null,
      questions: [],
    },
    call.extraction_scores ?? undefined,
    call.extraction_warnings,
  );
}

function toIntakeExtraction(
  data: CallExtraction,
  scores?: CallExtractionScores,
  warnings?: string[],
): IntakeExtraction {
  return {
    mc_number: data.mc_number,
    company_name: data.company_name,
    load_reference: data.load_reference,
    origin_state: data.origin_state,
    destination_state: data.destination_state,
    equipment: data.equipment,
    carrier_rate_usd: data.carrier_rate_usd,
    questions: data.questions,
    fieldScores: scores,
    extractionWarnings: warnings,
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

/* ----------------------------- retrievals ----------------------------- */

function buildRetrievals(args: {
  channel: "email" | "call";
  sourceFile: string;
  inbound: CarrierEmail | CallTranscript;
  asOf: string;
  ids: ReturnType<typeof extractIdentifiers>;
  ex: IntakeExtraction;
  carrierRes: CarrierResolution;
  load: LoadResolution;
  scope: IntakeResult["scope"];
  emails: CarrierEmail[];
  calls: CallTranscript[];
}): RetrievalStep[] {
  const steps: RetrievalStep[] = [];
  const { channel, sourceFile, inbound, asOf, ids, ex, carrierRes, load, scope, emails, calls } = args;

  if (channel === "email") {
    const email = inbound as CarrierEmail;
    steps.push({
      tool: "inbound_record",
      args: { source: sourceFile, email_id: email.email_id },
      summary: `${email.from_name} · ${email.subject}`,
      data: email,
    });
  } else {
    const call = inbound as CallTranscript;
    const { segments: _s, ...rest } = call;
    steps.push({
      tool: "inbound_record",
      args: { source: sourceFile, call_id: call.call_id },
      summary: `${call.call_id} · ${call.type}`,
      data: rest,
    });
    steps.push({
      tool: "extract_call_fields",
      args: { call_id: call.call_id },
      summary: ex.mc_number
        ? `mc=${ex.mc_number}, carrier_rate=${ex.carrier_rate_usd ?? "—"}`
        : "no structured fields",
      data: {
        extracted: call.extracted ?? null,
        extraction_scores: call.extraction_scores ?? null,
        extraction_warnings: call.extraction_warnings ?? [],
      },
    });
  }

  const carrierArgs: Record<string, unknown> = {};
  if (ids.mcNumbers[0]) carrierArgs.mc_number = ids.mcNumbers[0];
  if (ids.fromEmail) carrierArgs.email = ids.fromEmail;
  if (ids.carrierNames[0]) carrierArgs.company_name = ids.carrierNames[0];
  steps.push({
    tool: "get_carrier_profile",
    args: carrierArgs,
    summary: carrierRes.carrier
      ? `${carrierRes.carrier.company_name} · matched by ${carrierRes.matchedBy}`
      : "not found",
    data: {
      found: Boolean(carrierRes.carrier),
      matchedBy: carrierRes.matchedBy,
      score: carrierRes.score ?? null,
      profile: carrierRes.carrier,
    },
  });

  const loadArgs: Record<string, unknown> = {};
  if (ids.loadRefs[0]) loadArgs.load_id = ids.loadRefs[0];
  else if (ids.loadRefCandidates[0]) loadArgs.load_id = ids.loadRefCandidates[0];
  if (ex.origin_state) loadArgs.origin_state = ex.origin_state;
  if (ex.destination_state) loadArgs.destination_state = ex.destination_state;
  if (ex.equipment) loadArgs.equipment_type = ex.equipment;
  if (ex.carrier_rate_usd != null) loadArgs.offered_rate = ex.carrier_rate_usd;
  if (load.matchedBy === "structured_search") loadArgs.status = "open";
  steps.push({
    tool: "get_load",
    args: loadArgs,
    summary: load.load
      ? `${load.load.load_id} · ${load.matchedBy} (${Math.round(load.confidence * 100)}%)`
      : "not resolved",
    data: {
      found: Boolean(load.load),
      matchedBy: load.matchedBy,
      confidence: load.confidence,
      needsHumanVerification: load.needsHumanVerification,
      load: load.load,
      candidates: load.candidates,
    },
  });

  const historyArgs: Record<string, unknown> = { before_timestamp: asOf, scope };
  if (load.load) historyArgs.load_reference = load.load.load_id;
  else if (carrierRes.carrier?.mc_number) historyArgs.mc_number = carrierRes.carrier.mc_number;
  if (ids.fromEmail) historyArgs.from_email = ids.fromEmail;
  steps.push({
    tool: "get_email_history",
    args: historyArgs,
    summary: `${emails.length} email(s)`,
    data: { before_timestamp: asOf, count: emails.length, emails },
  });

  const callArgs: Record<string, unknown> = { before_timestamp: asOf, scope };
  if (load.load) callArgs.load_reference = load.load.load_id;
  else if (carrierRes.carrier?.mc_number) callArgs.mc_number = carrierRes.carrier.mc_number;
  steps.push({
    tool: "get_transcript",
    args: callArgs,
    summary: `${calls.length} call(s)`,
    data: {
      before_timestamp: asOf,
      count: calls.length,
      transcripts: calls.map(({ segments: _s, ...c }) => ({
        call_id: c.call_id,
        type: c.type,
        recorded_at: c.recorded_at,
        extracted: c.extracted,
        extraction_scores: c.extraction_scores,
      })),
    },
  });

  if (load.load) {
    const rows = getRateHistoryBefore({
      beforeTimestamp: asOf,
      originState: load.load.origin_state,
      destinationState: load.load.destination_state,
      equipmentType: load.load.equipment_type,
    });
    const latest = rows[rows.length - 1] ?? null;
    steps.push({
      tool: "get_rate_history",
      args: {
        before_timestamp: asOf,
        origin_state: load.load.origin_state,
        destination_state: load.load.destination_state,
        equipment_type: load.load.equipment_type,
      },
      summary: latest
        ? `${rows.length} row(s) · latest $${latest.avg_rate_per_mile}/mi`
        : `${rows.length} row(s)`,
      data: {
        before_timestamp: asOf,
        count: rows.length,
        latest_week: latest,
        rows: rows.slice(-52),
      },
    });
  }

  return steps;
}

/* ----------------------------- assemble ----------------------------- */

type AssembleContext = {
  channel: "email" | "call";
  sourceFile: string;
  inbound: CarrierEmail | CallTranscript;
  recordId: string;
  asOf: string;
  intent: string;
  ex: IntakeExtraction;
  ids: ReturnType<typeof extractIdentifiers>;
  carrierRes: CarrierResolution;
  load: LoadResolution;
  scope: IntakeResult["scope"];
  emails: CarrierEmail[];
  calls: CallTranscript[];
  validation: ValidationFinding[];
  retrievals: RetrievalStep[];
  recommendation: string;
  summary: string[];
};

function assembleFromContext(ctx: AssembleContext): IntakeResult {
  const carrier = ctx.carrierRes.carrier;
  const rateContext = rateContextFor(ctx.asOf, ctx.load.load);
  const offers = collectOffers(ctx.emails, ctx.calls).sort((a, b) => a.rate_usd - b.rate_usd);
  const bestOffer = offers[0] ?? null;
  const compliance = complianceFlags(carrier);
  const timeline = buildTimeline(ctx.emails, ctx.calls);
  const recommendation =
    ctx.recommendation || buildRecommendation(ctx.load, carrier, compliance, bestOffer, rateContext);

  const summary =
    ctx.summary.length > 0
      ? ctx.summary
      : [
          `Carrier: ${carrier?.company_name ?? ctx.ex.company_name ?? "unresolved"}${carrier?.mc_number ? ` (MC ${carrier.mc_number})` : ""} · intent: ${ctx.intent}`,
          ctx.load.load
            ? `Load ${ctx.load.load.load_id}: ${ctx.load.load.origin_city}, ${ctx.load.load.origin_state} → ${ctx.load.load.destination_city}, ${ctx.load.load.destination_state} · ${ctx.load.load.equipment_type} · ${ctx.load.load.status}`
            : "Load: not resolved from the inquiry",
          bestOffer
            ? `Best offer: $${bestOffer.rate_usd} from ${bestOffer.carrier_name ?? "carrier"}${ctx.load.load ? ` (posted $${ctx.load.load.offered_rate_usd})` : ""}`
            : ctx.load.load
              ? `No carrier rate on offer yet (posted $${ctx.load.load.offered_rate_usd})`
              : "No rate context",
          `Next: ${recommendation.replace(/\.$/, "")}`,
        ];

  return {
    channel: ctx.channel,
    recordId: ctx.recordId,
    asOf: ctx.asOf,
    intent: ctx.intent,
    sourceFile: ctx.sourceFile,
    extraction: ctx.ex,
    carrier: { profile: carrier, matchedBy: ctx.carrierRes.matchedBy, confidence: ctx.carrierRes.score },
    load: ctx.load,
    scope: ctx.scope,
    emailHistory: ctx.emails,
    callHistory: ctx.calls.map((c) => ({
      call_id: c.call_id,
      type: c.type,
      recorded_at: c.recorded_at,
      extracted: c.extracted,
    })),
    rateContext,
    offers,
    bestOffer,
    compliance,
    validation: ctx.validation,
    timeline,
    summary,
    recommendation,
    retrievals:
      ctx.retrievals.length > 0
        ? ctx.retrievals
        : buildRetrievals({
            channel: ctx.channel,
            sourceFile: ctx.sourceFile,
            inbound: ctx.inbound,
            asOf: ctx.asOf,
            ids: ctx.ids,
            ex: ctx.ex,
            carrierRes: ctx.carrierRes,
            load: ctx.load,
            scope: ctx.scope,
            emails: ctx.emails,
            calls: ctx.calls,
          }),
  };
}

/* ----------------------------- sync entry points (unit tests) ----------------------------- */

function syncIntake(
  channel: "email" | "call",
  sourceFile: string,
  inbound: CarrierEmail | CallTranscript,
  recordId: string,
  asOf: string,
  ex: IntakeExtraction,
): IntakeResult {
  const intent = classifyIntent(inbound);
  const ids = extractIdentifiers(inbound);
  const carrierRes = resolveCarrier(ids);
  const load = resolveLoadDeterministic(ids, ex);
  const { findings } = crossReferenceIngestion(ids, carrierRes, load.load);
  const { emails, scope } = scopedEmailHistory(asOf, load.load, carrierRes.carrier, ids);
  const emailHistory =
    channel === "email" ? emails.filter((e) => e.email_id !== recordId) : emails;
  const calls = scopedCalls(asOf, load.load, carrierRes.carrier).filter(
    (c) => channel !== "call" || c.call_id !== recordId,
  );

  return assembleFromContext({
    channel,
    sourceFile,
    inbound,
    recordId,
    asOf,
    intent,
    ex,
    ids,
    carrierRes,
    load,
    scope,
    emails: emailHistory,
    calls,
    validation: findings,
    retrievals: [],
    recommendation: "",
    summary: [],
  });
}

/** Sync intake using dataset fields — used by unit tests; production uses processIntake. */
export function runEmailIntake(emailId: string): IntakeResult {
  const email = findEmailById(emailId);
  if (!email) throw new Error(`Email not found: ${emailId}`);
  return syncIntake("email", paths.carrierEmails, email, emailId, email.timestamp, emailExtraction(email));
}

/** Sync intake using stored call extraction — used by unit tests; production uses processIntake. */
export function runCallIntake(callId: string): IntakeResult {
  const call = findTranscriptById(callId);
  if (!call) throw new Error(`Transcript not found: ${callId}`);
  return syncIntake("call", paths.transcripts, call, callId, call.recorded_at, callExtraction(call));
}
