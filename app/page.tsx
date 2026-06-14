"use client";

import { useChat } from "ai/react";
import type { ToolInvocation } from "ai";
import { FormEvent, useEffect, useMemo, useState } from "react";
import { TimelineChart, type RecordListItem } from "@/app/components/TimelineChart";

type Mode = "query" | "email" | "transcript";

/** One-line preview of a record returned by a tool, for at-a-glance auditing. */
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

/** Collapsible trace of the tool calls behind an answer (transparency). */
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

export default function HomePage() {
  const [mode, setMode] = useState<Mode>("email");
  const [asOf, setAsOf] = useState("2026-05-25T23:59:59Z");
  const [records, setRecords] = useState<RecordListItem[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [recordPreview, setRecordPreview] = useState<string>("");
  const [loadError, setLoadError] = useState<string | null>(null);

  const filteredRecords = useMemo(
    () => records.filter((r) => (mode === "email" ? r.kind === "email" : r.kind === "transcript")),
    [records, mode],
  );

  const selectedRecord = filteredRecords.find((r) => r.id === selectedId) ?? null;

  const emailId = mode === "email" ? selectedId : undefined;
  const callId = mode === "transcript" ? selectedId : undefined;

  const { messages, input, setInput, handleInputChange, append, isLoading, error, setMessages } =
    useChat({
      api: "/api/chat",
      body: { mode, asOf, emailId, callId },
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
    if (!selectedId || mode === "query") {
      setRecordPreview("");
      return;
    }
    const item = records.find((r) => r.id === selectedId && r.kind === (mode === "email" ? "email" : "transcript"));
    if (!item) return;

    fetch("/api/records", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: item.kind, id: item.id }),
    })
      .then((r) => r.json())
      .then((data) => {
        if (data.record) {
          setRecordPreview(JSON.stringify(data.record, null, 2));
        }
      })
      .catch(() => setRecordPreview(item.preview));
  }, [selectedId, mode, records]);

  useEffect(() => {
    const first = filteredRecords[0];
    if (first && !filteredRecords.some((r) => r.id === selectedId)) {
      setSelectedId(first.id);
    }
  }, [filteredRecords, selectedId]);

  const cutoffTimestamp =
    mode === "query" ? asOf : selectedRecord?.timestamp ?? null;

  const onQuerySubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!input.trim()) return;
    append({ role: "user", content: input });
    setInput("");
  };

  const onIngest = () => {
    if (!selectedRecord) return;
    setMessages([]);
    const label =
      mode === "email"
        ? `Process inbound email ${selectedRecord.id}`
        : `Process inbound call ${selectedRecord.id}`;
    append({ role: "user", content: label });
  };

  return (
    <main className="page">
      <header className="header">
        <h1>Goodlane Freight Agent</h1>
        <p>
          Ingest a carrier email or call transcript, or ask a free-form question. Ingestion
          automatically collects email and rate history strictly before the record&apos;s timestamp.
        </p>
      </header>

      <TimelineChart
        cutoffTimestamp={cutoffTimestamp}
        highlightId={mode !== "query" ? selectedId : null}
      />

      <section className="mode-tabs">
        <button
          type="button"
          className={mode === "email" ? "active" : ""}
          onClick={() => setMode("email")}
        >
          Email ingestion
        </button>
        <button
          type="button"
          className={mode === "transcript" ? "active" : ""}
          onClick={() => setMode("transcript")}
        >
          Call ingestion
        </button>
        <button
          type="button"
          className={mode === "query" ? "active" : ""}
          onClick={() => setMode("query")}
        >
          Free query
        </button>
      </section>

      {mode === "query" ? (
        <section className="controls">
          <label htmlFor="as-of">
            As-of timestamp
            <input
              id="as-of"
              type="text"
              value={asOf}
              onChange={(e) => setAsOf(e.target.value)}
              placeholder="2026-05-25T23:59:59Z"
            />
          </label>
        </section>
      ) : (
        <section className="ingestion-panel">
          <label htmlFor="record-select">
            Select {mode === "email" ? "email" : "call transcript"}
            <select
              id="record-select"
              value={selectedId}
              onChange={(e) => setSelectedId(e.target.value)}
            >
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
            </p>
          )}

          {recordPreview && (
            <pre className="record-preview">{recordPreview}</pre>
          )}

          <button
            type="button"
            className="ingest-btn"
            onClick={onIngest}
            disabled={isLoading || !selectedRecord}
          >
            Process inbound {mode === "email" ? "email" : "call"}
          </button>
        </section>
      )}

      {loadError && <p className="error">{loadError}</p>}

      <section className="chat">
        {messages.length === 0 && mode === "query" && (
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

      {mode === "query" && (
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
      )}
    </main>
  );
}
