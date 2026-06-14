import { agentTools } from "@/lib/agent/tools";
import { extractEmail } from "@/lib/extraction/email";
import { extractCall } from "@/lib/extraction/llm";
import { findEmailById, findTranscriptById } from "@/lib/data/loaders";
import { paths } from "@/lib/data/paths";
import {
  classifyIntent,
  crossReferenceIngestion,
  extractIdentifiers,
  resolveCarrier,
  type CarrierResolution,
} from "@/lib/ingestion/context";
import { generateRecommendation } from "./recommendation";
import {
  type IntakeExtraction,
  type IntakeResult,
  type LoadResolution,
  type RetrievalStep,
  assembleFromContext,
  toIntakeExtraction,
  loadResolutionFromToolResult,
  scopedEmailHistory,
  scopedCalls,
} from "./pipeline";

export type IntakeEvent =
  | { type: "step"; step: string; status: "running" | "done"; summary?: string; data?: unknown }
  | { type: "complete"; result: IntakeResult }
  | { type: "error"; message: string };

type Emit = (event: IntakeEvent) => void;

const TOOL_CTX = { toolCallId: "intake", messages: [] };

function summarizeToolResult(tool: string, data: unknown): string {
  if (!data || typeof data !== "object") return String(data ?? "—");
  const r = data as Record<string, unknown>;
  if (tool === "get_carrier_profile") {
    const p = r.profile as Record<string, unknown> | undefined;
    return r.found ? `${p?.company_name ?? "carrier"} · MC ${p?.mc_number ?? "?"}` : "not found";
  }
  if (tool === "get_load") {
    const load = r.load as Record<string, unknown> | undefined;
    const loads = r.loads as unknown[] | undefined;
    if (load) return `${load.load_id} · ${load.origin_state}→${load.destination_state}`;
    if (loads?.length) return `${loads.length} candidate(s)`;
    return "not resolved";
  }
  if (typeof r.count === "number") return `${r.count} record(s)`;
  return `${tool} complete`;
}

async function execTool(
  tool: keyof typeof agentTools,
  args: Record<string, unknown>,
  emit: Emit,
  retrievals: RetrievalStep[],
): Promise<unknown> {
  emit({ type: "step", step: tool, status: "running", data: { args } });
  const t = agentTools[tool];
  if (!t.execute) throw new Error(`Tool ${tool} has no execute handler`);
  const data = await t.execute(args as never, TOOL_CTX as never);
  const summary = summarizeToolResult(tool, data);
  retrievals.push({ tool, args, summary, data });
  emit({ type: "step", step: tool, status: "done", summary, data });
  return data;
}

function carrierFromTool(data: unknown, ids: ReturnType<typeof extractIdentifiers>): CarrierResolution {
  const resolved = resolveCarrier(ids);
  if (!data || typeof data !== "object") return resolved;
  const r = data as Record<string, unknown>;
  if (r.found && r.profile) {
    return {
      carrier: r.profile as CarrierResolution["carrier"],
      matchedBy: resolved.matchedBy !== "none" ? resolved.matchedBy : "mc",
      score: resolved.score,
    };
  }
  return resolved;
}

/**
 * Full intake workflow triggered on Process click: LLM extraction → sequential tool
 * calls → LLM recommendation. Emits progress events for the UI.
 */
export async function processIntake(kind: "email" | "call", id: string, emit: Emit): Promise<IntakeResult> {
  const retrievals: RetrievalStep[] = [];

  emit({ type: "step", step: "inbound_record", status: "running" });

  if (kind === "email") {
    const email = findEmailById(id);
    if (!email) throw new Error(`Email not found: ${id}`);
    retrievals.push({
      tool: "inbound_record",
      args: { source: paths.carrierEmails, email_id: id },
      summary: `${email.from_name} · ${email.subject}`,
      data: email,
    });
    emit({ type: "step", step: "inbound_record", status: "done", summary: email.subject, data: email });

    emit({ type: "step", step: "extract_fields", status: "running" });
    const { data, scores, warnings } = await extractEmail(email);
    if (!data) throw new Error("Email extraction failed");
    const ex = toIntakeExtraction(data, scores ?? undefined, warnings);
    retrievals.push({
      tool: "extract_fields",
      args: { email_id: id },
      summary: `mc=${ex.mc_number ?? "—"}, rate=${ex.carrier_rate_usd ?? "—"}`,
      data: { extracted: data, scores, warnings },
    });
    emit({
      type: "step",
      step: "extract_fields",
      status: "done",
      summary: `Extracted MC ${ex.mc_number ?? "—"}, rate $${ex.carrier_rate_usd ?? "—"}`,
      data: { extracted: data, scores, warnings },
    });

    return finishIntake("email", paths.carrierEmails, email, id, email.timestamp, ex, emit, retrievals, email.from_email);
  }

  const call = findTranscriptById(id);
  if (!call) throw new Error(`Transcript not found: ${id}`);
  const { segments: _s, ...callPreview } = call;
  retrievals.push({
    tool: "inbound_record",
    args: { source: paths.transcripts, call_id: id },
    summary: `${call.call_id} · ${call.type}`,
    data: callPreview,
  });
  emit({ type: "step", step: "inbound_record", status: "done", summary: call.call_id, data: callPreview });

  emit({ type: "step", step: "extract_call_fields", status: "running" });
  const { data, scores, warnings } = await extractCall(call.transcript);
  if (!data) throw new Error("Call extraction failed");
  const ex = toIntakeExtraction(data, scores ?? undefined, warnings);
  retrievals.push({
    tool: "extract_call_fields",
    args: { call_id: id },
    summary: `mc=${ex.mc_number ?? "—"}, carrier_rate=${ex.carrier_rate_usd ?? "—"}`,
    data: { extracted: data, scores, warnings },
  });
  emit({
    type: "step",
    step: "extract_call_fields",
    status: "done",
    summary: `Extracted MC ${ex.mc_number ?? "—"}, carrier rate $${ex.carrier_rate_usd ?? "—"}`,
    data: { extracted: data, scores, warnings },
  });

  const callWithEx = { ...call, extracted: data, extraction_scores: scores ?? undefined, extraction_warnings: warnings };
  return finishIntake("call", paths.transcripts, callWithEx, id, call.recorded_at, ex, emit, retrievals);
}

async function finishIntake(
  channel: "email" | "call",
  sourceFile: string,
  inbound: Parameters<typeof assembleFromContext>[0]["inbound"],
  recordId: string,
  asOf: string,
  ex: IntakeExtraction,
  emit: Emit,
  retrievals: RetrievalStep[],
  fromEmail?: string,
): Promise<IntakeResult> {
  const intent = classifyIntent(inbound as never);
  const ids = extractIdentifiers(inbound as never);
  if (fromEmail && !ids.fromEmail) ids.fromEmail = fromEmail;

  const carrierArgs: Record<string, unknown> = {};
  if (ids.mcNumbers[0]) carrierArgs.mc_number = ids.mcNumbers[0];
  if (ids.fromEmail) carrierArgs.email = ids.fromEmail;
  if (ids.carrierNames[0]) carrierArgs.company_name = ids.carrierNames[0];

  const carrierData = await execTool("get_carrier_profile", carrierArgs, emit, retrievals);
  const carrierRes = carrierFromTool(carrierData, ids);

  const loadArgs: Record<string, unknown> = {};
  if (ids.loadRefs[0]) loadArgs.load_id = ids.loadRefs[0];
  else if (ids.loadRefCandidates[0]) loadArgs.load_id = ids.loadRefCandidates[0];
  if (ex.origin_state) loadArgs.origin_state = ex.origin_state;
  if (ex.destination_state) loadArgs.destination_state = ex.destination_state;
  if (ex.equipment) loadArgs.equipment_type = ex.equipment;
  if (ex.carrier_rate_usd != null) loadArgs.offered_rate = ex.carrier_rate_usd;
  if (!loadArgs.load_id) loadArgs.status = "open";

  const loadData = await execTool("get_load", loadArgs, emit, retrievals);
  const load: LoadResolution = loadResolutionFromToolResult(loadData, ids, ex);

  const { findings } = crossReferenceIngestion(ids, carrierRes, load.load);
  const { emails, scope } = scopedEmailHistory(asOf, load.load, carrierRes.carrier, ids);
  const emailHistory = channel === "email" ? emails.filter((e) => e.email_id !== recordId) : emails;
  const calls = scopedCalls(asOf, load.load, carrierRes.carrier).filter(
    (c) => channel !== "call" || c.call_id !== recordId,
  );

  const historyArgs: Record<string, unknown> = { before_timestamp: asOf };
  if (load.load) historyArgs.load_reference = load.load.load_id;
  else if (carrierRes.carrier?.mc_number) historyArgs.mc_number = carrierRes.carrier.mc_number;
  if (ids.fromEmail) historyArgs.from_email = ids.fromEmail;
  await execTool("get_email_history", historyArgs, emit, retrievals);

  const callArgs: Record<string, unknown> = { before_timestamp: asOf };
  if (load.load) callArgs.search_text = load.load.load_id;
  else if (carrierRes.carrier?.mc_number) callArgs.search_text = carrierRes.carrier.mc_number;
  await execTool("get_transcript", callArgs, emit, retrievals);

  if (load.load) {
    await execTool(
      "get_rate_history",
      {
        before_timestamp: asOf,
        origin_state: load.load.origin_state,
        destination_state: load.load.destination_state,
        equipment_type: load.load.equipment_type,
      },
      emit,
      retrievals,
    );
  }

  emit({ type: "step", step: "generate_recommendation", status: "running" });

  const partial = assembleFromContext({
    channel,
    sourceFile,
    inbound: inbound as never,
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
    retrievals,
    recommendation: "",
    summary: [],
  });

  const recommendation = await generateRecommendation(partial);
  emit({
    type: "step",
    step: "generate_recommendation",
    status: "done",
    summary: recommendation.slice(0, 120) + (recommendation.length > 120 ? "…" : ""),
    data: { recommendation },
  });

  const result = assembleFromContext({
    channel,
    sourceFile,
    inbound: inbound as never,
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
    retrievals,
    recommendation,
    summary: [
      `Carrier: ${partial.carrier.profile?.company_name ?? ex.company_name ?? "unresolved"}${partial.carrier.profile?.mc_number ? ` (MC ${partial.carrier.profile.mc_number})` : ""} · intent: ${intent}`,
      load.load
        ? `Load ${load.load.load_id}: ${load.load.origin_city}, ${load.load.origin_state} → ${load.load.destination_city}, ${load.load.destination_state} · ${load.load.equipment_type} · ${load.load.status}`
        : "Load: not resolved from the inquiry",
      partial.bestOffer
        ? `Best offer: $${partial.bestOffer.rate_usd} from ${partial.bestOffer.carrier_name ?? "carrier"}${load.load ? ` (posted $${load.load.offered_rate_usd})` : ""}`
        : load.load
          ? `No carrier rate on offer yet (posted $${load.load.offered_rate_usd})`
          : "No rate context",
      `Next: ${recommendation.replace(/\.$/, "")}`,
    ],
  });

  emit({ type: "complete", result });
  return result;
}
