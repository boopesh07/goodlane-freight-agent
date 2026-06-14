"use client";

import { useChat } from "ai/react";
import type { ToolInvocation } from "ai";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import type { RecordListItem } from "@/lib/ingestion/context";
import { TimelineChart } from "@/app/components/TimelineChart";

type Mode = "query" | "email" | "transcript";

/* ----------------------------- intake types ----------------------------- */

type IntakeResult = {
  channel: "email" | "call";
  recordId: string;
  asOf: string;
  intent: string;
  sourceFile: string;
  carrier: {
    profile: {
      company_name: string;
      mc_number: string | null;
      authority_status: string | null;
      onboarded: boolean;
      reliability_score: number | null;
    } | null;
    matchedBy: string;
    confidence?: number;
  };
  load: {
    load: {
      load_id: string;
      origin_city: string;
      origin_state: string;
      destination_city: string;
      destination_state: string;
      equipment_type: string;
      status: string;
      offered_rate_usd: number;
    } | null;
    matchedBy: string;
    confidence: number;
    needsHumanVerification: boolean;
  };
  scope: "load" | "carrier" | "none";
  rateContext: { lane: string | null; avg_rate_per_mile: number | null; market_total_usd: number | null };
  offers: { source: string; source_id: string; carrier_name: string | null; rate_usd: number }[];
  bestOffer: { rate_usd: number; carrier_name: string | null; source_id: string } | null;
  compliance: { severity: string; message: string }[];
  validation: { severity: string; field: string; message: string }[];
  timeline: { timestamp: string; channel: string; id: string; summary: string }[];
  summary: string[];
  recommendation: string;
  retrievals: { tool: string; args: Record<string, unknown>; summary: string; data: unknown }[];
};

type Draft = { subject: string; body: string; to: string | null; status: string };

type EmailRecord = {
  email_id: string;
  timestamp: string;
  from_name: string;
  from_email: string;
  to_email: string;
  subject: string;
  body: string;
  mc_number: string | null;
  load_reference: string | null;
  equipment_mentioned: string | null;
  rate_quoted_usd: number | null;
  intent: string | null;
};

type TranscriptRecord = {
  call_id: string;
  type: string;
  transcript: string;
  recorded_at: string;
  extracted?: Record<string, unknown> | null;
  extraction_scores?: Record<string, { confidence: number; evidence: string }> | null;
};

type RecordPreview =
  | { kind: "email"; sourceFile: string; record: EmailRecord }
  | { kind: "transcript"; sourceFile: string; record: TranscriptRecord };

/* ----------------------------- free-query agent helpers ----------------------------- */

function previewResult(toolName: string, result: unknown): string {
  if (result == null || typeof result !== "object") return String(result ?? "—");
  const r = result as Record<string, unknown>;
  if (r.found === false) {
    const sugg = Array.isArray(r.suggestions) ? ` · ${r.suggestions.length} suggestion(s)` : "";
    return `not found${sugg}`;
  }
  if (typeof r.count === "number") return `${r.count} record(s)`;
  const load = r.load as Record<string, unknown> | undefined;
  if (load) return `${load.load_id} · ${load.origin_state}→${load.destination_state} ${load.equipment_type} $${load.offered_rate_usd} (${load.status})`;
  const profile = r.profile as Record<string, unknown> | undefined;
  if (profile) return `${profile.company_name} · MC ${profile.mc_number ?? "?"} · ${profile.authority_status ?? "?"}`;
  return `${toolName} result`;
}

function ToolTrace({ invocations }: { invocations?: ToolInvocation[] }) {
  if (!invocations || invocations.length === 0) return null;
  return (
    <details className="tool-trace">
      <summary>{invocations.length} tool call{invocations.length > 1 ? "s" : ""} — retrieved data</summary>
      {invocations.map((inv) => {
        const done = inv.state === "result";
        const result = done ? (inv as { result: unknown }).result : undefined;
        return (
          <div key={inv.toolCallId} className="tool-call">
            <div className="tool-head">
              <code>{inv.toolName}</code>
              <span className="tool-args">({JSON.stringify(inv.args)})</span>
            </div>
            {done ? (
              <>
                <div className="tool-summary">→ {previewResult(inv.toolName, result)}</div>
                <pre className="tool-result">{JSON.stringify(result, null, 2)}</pre>
              </>
            ) : (
              <div className="tool-summary">→ running…</div>
            )}
          </div>
        );
      })}
    </details>
  );
}

function RetrievalTrace({ steps }: { steps: { tool: string; args: Record<string, unknown>; summary: string; data: unknown }[] }) {
  if (!steps.length) return null;
  return (
    <div className="intake-card">
      <h3>Retrieved data ({steps.length} lookup{steps.length > 1 ? "s" : ""})</h3>
      <p className="muted">Each step reads fresh from the source files — no caching.</p>
      {steps.map((step, i) => (
        <details key={`${step.tool}-${i}`} className="tool-trace" open={i < 2}>
          <summary>
            <code>{step.tool}</code> → {step.summary}
          </summary>
          <div className="tool-call">
            <div className="tool-head">
              <span className="tool-args">args: {JSON.stringify(step.args)}</span>
            </div>
            <pre className="tool-result">{JSON.stringify(step.data, null, 2)}</pre>
          </div>
        </details>
      ))}
    </div>
  );
}

function RecordPreviewPanel({ preview, loading }: { preview: RecordPreview | null; loading: boolean }) {
  if (loading) return <p className="muted">Loading preview…</p>;
  if (!preview) return null;

  if (preview.kind === "email") {
    const e = preview.record;
    return (
      <div className="intake-card record-preview-panel">
        <h3>Inbound email preview</h3>
        <p className="muted">
          Source: <code>{preview.sourceFile}</code>
        </p>
        <dl className="record-meta">
          <div>
            <dt>From</dt>
            <dd>
              {e.from_name} &lt;{e.from_email}&gt;
            </dd>
          </div>
          <div>
            <dt>To</dt>
            <dd>{e.to_email}</dd>
          </div>
          <div>
            <dt>Timestamp</dt>
            <dd>
              <code>{e.timestamp}</code>
            </dd>
          </div>
          <div>
            <dt>Subject</dt>
            <dd>{e.subject}</dd>
          </div>
        </dl>
        <p className="muted">Structured fields come from the dataset; click Process to resolve and cross-reference.</p>
        <pre className="record-preview">{e.body}</pre>
      </div>
    );
  }

  const t = preview.record;
  return (
    <div className="intake-card record-preview-panel">
      <h3>Call transcript preview</h3>
      <p className="muted">
        Source: <code>{preview.sourceFile}</code> · type: {t.type}
      </p>
      <p className="muted">
        Recorded: <code>{t.recorded_at}</code> · fields were extracted offline; click Process to resolve
      </p>
      <pre className="record-preview">{t.transcript}</pre>
    </div>
  );
}

function ProcessProgress({
  steps,
}: {
  steps: { step: string; status: "running" | "done"; summary?: string }[];
}) {
  if (!steps.length) return null;
  const labels: Record<string, string> = {
    inbound_record: "Loading inbound record",
    extract_call_fields: "Reading extracted call fields",
    get_carrier_profile: "Looking up carrier profile",
    get_load: "Resolving load",
    get_email_history: "Fetching email history",
    get_transcript: "Fetching call transcripts",
    get_rate_history: "Fetching rate history",
  };
  return (
    <div className="intake-card process-progress">
      <h3>Processing…</h3>
      <ol className="process-steps">
        {steps.map((s, i) => (
          <li key={`${s.step}-${i}`} className={s.status === "running" ? "step-running" : "step-done"}>
            <span className="step-icon">{s.status === "running" ? "◌" : "✓"}</span>
            <span className="step-label">{labels[s.step] ?? s.step}</span>
            {s.summary && s.status === "done" && <span className="step-summary"> — {s.summary}</span>}
          </li>
        ))}
      </ol>
    </div>
  );
}

/* ----------------------------- intake view ----------------------------- */

function pct(n: number | undefined) {
  return n == null ? "" : `${Math.round(n * 100)}%`;
}

function IntakeView({
  result,
  draft,
  drafting,
  onDraft,
}: {
  result: IntakeResult;
  draft: Draft | null;
  drafting: boolean;
  onDraft: () => void;
}) {
  const load = result.load.load;
  const carrier = result.carrier.profile;
  return (
    <div className="intake">
      <RetrievalTrace steps={result.retrievals} />

      <div className="intake-card">
        <h3>Quick summary</h3>
        <ul className="summary-list">
          {result.summary.map((s, i) => (
            <li key={i}>{s}</li>
          ))}
        </ul>
      </div>

      <div className="intake-grid">
        <div className="intake-card">
          <h3>Carrier</h3>
          {carrier ? (
            <p>
              <strong>{carrier.company_name}</strong> · MC {carrier.mc_number ?? "?"}
              <br />
              authority: {carrier.authority_status ?? "?"} · onboarded: {String(carrier.onboarded)} · reliability:{" "}
              {carrier.reliability_score ?? "?"}
              <br />
              <span className="muted">matched by {result.carrier.matchedBy}{result.carrier.confidence != null ? ` (${pct(result.carrier.confidence)})` : ""}</span>
            </p>
          ) : (
            <p className="flag-error">Not resolved</p>
          )}
        </div>

        <div className="intake-card">
          <h3>Load</h3>
          {load ? (
            <p>
              <strong>{load.load_id}</strong> · {load.origin_city}, {load.origin_state} → {load.destination_city},{" "}
              {load.destination_state}
              <br />
              {load.equipment_type} · {load.status} · posted ${load.offered_rate_usd}
              <br />
              <span className={result.load.needsHumanVerification ? "flag-error" : "muted"}>
                matched by {result.load.matchedBy} ({pct(result.load.confidence)})
                {result.load.needsHumanVerification ? " — needs human confirmation" : ""}
              </span>
            </p>
          ) : (
            <p className="flag-error">Not resolved — confirm load with carrier</p>
          )}
        </div>
      </div>

      <div className="intake-grid">
        <div className="intake-card">
          <h3>Best offer</h3>
          {result.bestOffer ? (
            <p>
              <strong>${result.bestOffer.rate_usd}</strong> from {result.bestOffer.carrier_name ?? "carrier"}{" "}
              <span className="muted">({result.bestOffer.source_id})</span>
              {result.rateContext.market_total_usd != null && (
                <>
                  <br />
                  <span className="muted">market est. ${result.rateContext.market_total_usd}</span>
                </>
              )}
            </p>
          ) : (
            <p className="muted">No carrier rate on offer yet.</p>
          )}
        </div>

        <div className="intake-card">
          <h3>Compliance</h3>
          {result.compliance.length ? (
            <ul className="flag-list">
              {result.compliance.map((c, i) => (
                <li key={i} className={c.severity === "error" ? "flag-error" : "flag-warn"}>
                  {c.message}
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted">No flags.</p>
          )}
        </div>
      </div>

      {result.validation.length > 0 && (
        <div className="intake-card">
          <h3>Cross-reference checks</h3>
          <ul className="flag-list">
            {result.validation.map((v, i) => (
              <li key={i} className={v.severity === "error" ? "flag-error" : v.severity === "warning" ? "flag-warn" : "muted"}>
                [{v.field}] {v.message}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="intake-card">
        <h3>Timeline (scoped to {result.scope})</h3>
        {result.timeline.length ? (
          <ol className="timeline-list">
            {result.timeline.map((t) => (
              <li key={`${t.channel}-${t.id}`}>
                <code>{t.timestamp.slice(0, 16).replace("T", " ")}</code> · {t.channel} · {t.summary}
              </li>
            ))}
          </ol>
        ) : (
          <p className="muted">No prior activity on this {result.scope === "load" ? "load" : "carrier"}.</p>
        )}
      </div>

      <div className="intake-card recommendation">
        <h3>Recommended next action</h3>
        <p>{result.recommendation}</p>
        <button type="button" className="ingest-btn" onClick={onDraft} disabled={drafting}>
          {drafting ? "Drafting…" : "Draft reply email"}
        </button>
      </div>

      {draft && (
        <div className="intake-card">
          <h3>Draft reply <span className="muted">— {draft.status}</span></h3>
          {draft.to && <p className="muted">To: {draft.to}</p>}
          <p>
            <strong>Subject:</strong> {draft.subject}
          </p>
          <pre className="record-preview">{draft.body}</pre>
        </div>
      )}
    </div>
  );
}

/* ----------------------------- page ----------------------------- */

export default function HomePage() {
  const [mode, setMode] = useState<Mode>("email");
  const [asOf, setAsOf] = useState("2026-05-25T23:59:59Z");
  const [records, setRecords] = useState<RecordListItem[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [loadError, setLoadError] = useState<string | null>(null);

  const [intake, setIntake] = useState<IntakeResult | null>(null);
  const [intakeLoading, setIntakeLoading] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [drafting, setDrafting] = useState(false);
  const [recordPreview, setRecordPreview] = useState<RecordPreview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [processSteps, setProcessSteps] = useState<{ step: string; status: "running" | "done"; summary?: string }[]>(
    [],
  );

  const filteredRecords = useMemo(
    () => records.filter((r) => (mode === "email" ? r.kind === "email" : r.kind === "transcript")),
    [records, mode],
  );
  const selectedRecord = filteredRecords.find((r) => r.id === selectedId) ?? null;

  const { messages, input, setInput, handleInputChange, append, isLoading, error } = useChat({
    api: "/api/chat",
    body: { mode: "query", asOf },
  });

  useEffect(() => {
    fetch("/api/records")
      .then((r) => r.json())
      .then((data: { records: RecordListItem[] }) => {
        setRecords(data.records);
        const firstEmail = data.records.find((r) => r.kind === "email");
        if (firstEmail) setSelectedId(firstEmail.id);
      })
      .catch((e) => setLoadError(e instanceof Error ? e.message : "Failed to load records"));
  }, []);

  useEffect(() => {
    const first = filteredRecords[0];
    if (first && !filteredRecords.some((r) => r.id === selectedId)) setSelectedId(first.id);
  }, [filteredRecords, selectedId]);

  // Reset intake results when the selection or mode changes.
  useEffect(() => {
    setIntake(null);
    setDraft(null);
    setProcessSteps([]);
  }, [selectedId, mode]);

  // Load full record preview from source files when selection changes.
  useEffect(() => {
    if (mode === "query" || !selectedId) {
      setRecordPreview(null);
      return;
    }
    setPreviewLoading(true);
    fetch("/api/records", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: mode === "email" ? "email" : "transcript", id: selectedId }),
    })
      .then((r) => r.json())
      .then((data: RecordPreview | { error: string }) => {
        if ("error" in data) setLoadError(data.error);
        else setRecordPreview(data);
      })
      .catch((e) => setLoadError(e instanceof Error ? e.message : "Failed to load preview"))
      .finally(() => setPreviewLoading(false));
  }, [selectedId, mode]);

  const cutoffTimestamp = mode === "query" ? asOf : selectedRecord?.timestamp ?? null;

  const onProcess = async () => {
    if (!selectedRecord) return;
    setIntakeLoading(true);
    setIntake(null);
    setDraft(null);
    setProcessSteps([]);
    setLoadError(null);
    try {
      const res = await fetch("/api/intake", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind: mode === "email" ? "email" : "call", id: selectedRecord.id }),
      });
      if (!res.ok || !res.body) {
        const err = await res.json().catch(() => ({ error: "Intake failed" }));
        setLoadError(err.error ?? "Intake failed");
        return;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          const event = JSON.parse(line) as
            | { type: "step"; step: string; status: "running" | "done"; summary?: string }
            | { type: "complete"; result: IntakeResult }
            | { type: "error"; message: string };
          if (event.type === "step") {
            setProcessSteps((prev) => {
              const idx = prev.findIndex((p) => p.step === event.step);
              const next = { step: event.step, status: event.status, summary: event.summary };
              if (idx >= 0) {
                const copy = [...prev];
                copy[idx] = next;
                return copy;
              }
              return [...prev, next];
            });
          } else if (event.type === "complete") {
            setIntake(event.result);
          } else if (event.type === "error") {
            setLoadError(event.message);
          }
        }
      }
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "Intake failed");
    } finally {
      setIntakeLoading(false);
    }
  };

  const onDraft = async () => {
    if (!selectedRecord) return;
    setDrafting(true);
    try {
      const res = await fetch("/api/draft", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind: mode === "email" ? "email" : "call", id: selectedRecord.id }),
      });
      const data = await res.json();
      if (data.draft) setDraft(data.draft);
      else setLoadError(data.error ?? "Draft failed");
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "Draft failed");
    } finally {
      setDrafting(false);
    }
  };

  const onQuerySubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!input.trim()) return;
    append({ role: "user", content: input });
    setInput("");
  };

  return (
    <main className="page">
      <header className="header">
        <h1>Goodlane Freight Agent</h1>
        <p>
          Select an inbound email or call, then click Process. Resolution, cross-reference checks,
          rate math, and the recommendation all run deterministically in code — the LLM is reserved
          for the on-demand draft reply and the free-query chat.
        </p>
      </header>

      <TimelineChart cutoffTimestamp={cutoffTimestamp} highlightId={mode !== "query" ? selectedId : null} />

      <section className="mode-tabs">
        <button type="button" className={mode === "email" ? "active" : ""} onClick={() => setMode("email")}>
          Email ingestion
        </button>
        <button type="button" className={mode === "transcript" ? "active" : ""} onClick={() => setMode("transcript")}>
          Call ingestion
        </button>
        <button type="button" className={mode === "query" ? "active" : ""} onClick={() => setMode("query")}>
          Free query
        </button>
      </section>

      {mode === "query" ? (
        <section className="controls">
          <label htmlFor="as-of">
            As-of timestamp
            <input id="as-of" type="text" value={asOf} onChange={(e) => setAsOf(e.target.value)} placeholder="2026-05-25T23:59:59Z" />
          </label>
        </section>
      ) : (
        <section className="ingestion-panel">
          <label htmlFor="record-select">
            Select {mode === "email" ? "email" : "call transcript"}
            <select id="record-select" value={selectedId} onChange={(e) => setSelectedId(e.target.value)}>
              {filteredRecords.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.label} — {r.preview.slice(0, 60)}
                </option>
              ))}
            </select>
          </label>

          {selectedRecord && (
            <p className="ingestion-meta">
              Ingestion timestamp: <code>{selectedRecord.timestamp}</code>
              {" · "}
              Source:{" "}
              <code>{mode === "email" ? "goodlane-interview-dataset/carrier_emails.json" : "data/transcripts.json"}</code>
            </p>
          )}

          <RecordPreviewPanel preview={recordPreview} loading={previewLoading} />

          <button type="button" className="ingest-btn" onClick={onProcess} disabled={intakeLoading || !selectedRecord}>
            {intakeLoading ? "Processing…" : `Process inbound ${mode === "email" ? "email" : "call"}`}
          </button>
        </section>
      )}

      {loadError && <p className="error">{loadError}</p>}

      {mode !== "query" && intakeLoading && <ProcessProgress steps={processSteps} />}

      {mode !== "query" && intake && (
        <IntakeView result={intake} draft={draft} drafting={drafting} onDraft={onDraft} />
      )}

      {mode === "query" && (
        <>
          <section className="chat">
            {messages.length === 0 && (
              <div className="empty">
                <p>Example queries:</p>
                <ul>
                  <li>What is the best rate on offer for load 29372343?</li>
                  <li>Build a timeline for load 29372312 and recommend next steps.</li>
                </ul>
              </div>
            )}
            {messages.map((m) => (
              <article key={m.id} className={`bubble ${m.role}`}>
                <strong>{m.role === "user" ? "You" : "Agent"}</strong>
                <ToolTrace invocations={m.toolInvocations} />
                <div className="content">{m.content}</div>
              </article>
            ))}
            {isLoading && <p className="status">Agent is thinking…</p>}
            {error && <p className="error">{error.message}</p>}
          </section>

          <form className="composer" onSubmit={onQuerySubmit}>
            <textarea
              value={input}
              onChange={handleInputChange}
              rows={3}
              placeholder="Ask about a load, carrier, lane, or draft next steps…"
            />
            <button type="submit" disabled={isLoading || !input.trim()}>
              Send
            </button>
          </form>
        </>
      )}
    </main>
  );
}
