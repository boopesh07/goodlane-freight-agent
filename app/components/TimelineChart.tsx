"use client";

import { useEffect, useMemo, useState } from "react";
import type { TimelineChartData } from "@/lib/ingestion/context";

type RecordListItem = {
  kind: "email" | "transcript";
  id: string;
  timestamp: string;
  label: string;
  preview: string;
};

type Props = {
  cutoffTimestamp?: string | null;
  highlightId?: string | null;
};

const ROW_HEIGHT = 28;
const PAD = 40;

function xPos(ts: string, min: number, max: number, width: number): number {
  const t = Date.parse(ts);
  if (max <= min) return PAD;
  return PAD + ((t - min) / (max - min)) * (width - PAD * 2);
}

export function TimelineChart({ cutoffTimestamp, highlightId }: Props) {
  const [data, setData] = useState<TimelineChartData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const width = 820;
  const height = 120;

  useEffect(() => {
    fetch("/api/timeline")
      .then((r) => r.json())
      .then(setData)
      .catch((e) => setError(e instanceof Error ? e.message : "Failed to load timeline"));
  }, []);

  const { min, max, emailPoints, ratePoints, callPoints } = useMemo(() => {
    if (!data) {
      return { min: 0, max: 1, emailPoints: [], ratePoints: [], callPoints: [] };
    }
    const minTs = Date.parse(data.domain.min);
    const maxTs = Date.parse(data.domain.max);
    return {
      min: minTs,
      max: maxTs,
      emailPoints: data.points.filter((p) => p.kind === "email"),
      ratePoints: data.points.filter((p) => p.kind === "rate"),
      callPoints: data.points.filter((p) => p.kind === "call"),
    };
  }, [data]);

  if (error) return <p className="error">{error}</p>;
  if (!data) return <p className="status">Loading timeline chart…</p>;

  const cutoffX =
    cutoffTimestamp && !Number.isNaN(Date.parse(cutoffTimestamp))
      ? xPos(cutoffTimestamp, min, max, width)
      : null;

  const renderRow = (
    points: typeof data.points,
    y: number,
    color: string,
    title: string,
  ) => (
    <g key={title}>
      <text x={4} y={y + 5} fill="#9fb0c5" fontSize={11}>
        {title}
      </text>
      {points.map((p) => {
        const cx = xPos(p.timestamp, min, max, width);
        const active = highlightId && p.id === highlightId;
        return (
          <circle
            key={p.id}
            cx={cx}
            cy={y}
            r={active ? 5 : 3}
            fill={active ? "#ffd166" : color}
            opacity={0.85}
          >
            <title>{`${p.label}\n${p.timestamp}`}</title>
          </circle>
        );
      })}
    </g>
  );

  return (
    <section className="chart-panel">
      <div className="chart-header">
        <h2>Dataset timeline</h2>
        <p>
          {data.emailCount} emails · {data.rateCount} rate rows · {callPoints.length} calls
        </p>
      </div>
      <svg viewBox={`0 0 ${width} ${height}`} className="timeline-chart" role="img">
        <line x1={PAD} y1={height - 18} x2={width - PAD} y2={height - 18} stroke="#2d3a4f" />
        {renderRow(emailPoints, 30, "#4da3ff", "Emails")}
        {renderRow(callPoints, 58, "#c77dff", "Calls")}
        {renderRow(ratePoints, 86, "#6dd58c", "Rates")}
        {cutoffX !== null && (
          <>
            <line
              x1={cutoffX}
              y1={16}
              x2={cutoffX}
              y2={height - 10}
              stroke="#ff8a8a"
              strokeDasharray="4 3"
            />
            <text x={cutoffX + 4} y={14} fill="#ff8a8a" fontSize={10}>
              ingestion cutoff
            </text>
          </>
        )}
      </svg>
      <p className="chart-note">
        Dots show every email, call transcript, and rate-history week. During ingestion, history is
        collected strictly before the red cutoff line.
      </p>
    </section>
  );
}

export type { RecordListItem };
