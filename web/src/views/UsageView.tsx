import { useEffect, useState } from "react";

interface UsageSummary {
  month: string;
  budgetUsd: number;
  usedUsd: number;
  usedPct: number;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  distillSessions: number;
  distillAvgCost: number;
  byPurpose: { purpose: string; calls: number; inputTokens: number; outputTokens: number; costUsd: number }[];
  byModel: { model: string; calls: number; costUsd: number }[];
  daily: { day: string; costUsd: number; calls: number }[];
  months: { month: string; costUsd: number; calls: number }[];
}

const h4: React.CSSProperties = { margin: "18px 0 6px", fontSize: 11, letterSpacing: 1.2, textTransform: "uppercase", color: "#777" };

export default function UsageView() {
  const [data, setData] = useState<UsageSummary | null>(null);

  useEffect(() => {
    fetch("/api/usage/summary")
      .then((r) => r.json() as Promise<UsageSummary>)
      .then(setData)
      .catch(() => setData(null));
  }, []);

  if (!data) return <p style={{ color: "#666" }}>Loading usage…</p>;

  const maxDaily = Math.max(...data.daily.map((d) => d.costUsd), 0.001);
  const pctColor = data.usedPct >= 100 ? "#b04040" : data.usedPct >= 80 ? "#b08020" : "#2a7a2a";

  return (
    <div style={{ maxWidth: 720 }}>
      <div style={{ padding: 14, background: "#f7f7f5", borderRadius: 6, marginBottom: 8 }}>
        <div style={{ fontSize: 28, fontWeight: 600 }}>
          ${data.usedUsd.toFixed(4)}{" "}
          <span style={{ fontSize: 14, color: "#999" }}>of ${data.budgetUsd}/month</span>
        </div>
        <div style={{ height: 8, background: "#e5e5e5", borderRadius: 4, marginTop: 8, overflow: "hidden" }}>
          <div style={{ height: "100%", width: `${Math.min(data.usedPct, 100)}%`, background: pctColor, borderRadius: 4 }} />
        </div>
        <p style={{ fontSize: 12, color: pctColor, margin: "4px 0 0" }}>
          {data.usedPct.toFixed(1)}% used · {data.calls} calls · {(data.inputTokens / 1000).toFixed(1)}k in / {(data.outputTokens / 1000).toFixed(1)}k out tokens
        </p>
        <p style={{ fontSize: 12, color: "#777", margin: "2px 0 0" }}>
          Distill sessions this month: {data.distillSessions} (avg ${data.distillAvgCost.toFixed(4)}/session)
        </p>
      </div>

      <h4 style={h4}>By purpose</h4>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
        <thead>
          <tr style={{ borderBottom: "1px solid #ddd", textAlign: "left", color: "#999", fontSize: 11 }}>
            <th style={{ padding: 4 }}>purpose</th>
            <th style={{ padding: 4, textAlign: "right" }}>calls</th>
            <th style={{ padding: 4, textAlign: "right" }}>tokens (in/out)</th>
            <th style={{ padding: 4, textAlign: "right" }}>cost</th>
          </tr>
        </thead>
        <tbody>
          {data.byPurpose.map((p) => (
            <tr key={p.purpose} style={{ borderBottom: "1px solid #f0f0f0" }}>
              <td style={{ padding: 5 }}>{p.purpose}</td>
              <td style={{ padding: 5, textAlign: "right" }}>{p.calls}</td>
              <td style={{ padding: 5, textAlign: "right", color: "#777" }}>
                {(p.inputTokens / 1000).toFixed(1)}k / {(p.outputTokens / 1000).toFixed(1)}k
              </td>
              <td style={{ padding: 5, textAlign: "right" }}>${p.costUsd.toFixed(4)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h4 style={h4}>By model</h4>
      <p style={{ fontSize: 13, margin: 0 }}>
        {data.byModel.map((m) => (
          <span key={m.model} style={{ display: "inline-block", marginRight: 14 }}>
            {m.model}: {m.calls} calls · ${m.costUsd.toFixed(4)}
          </span>
        ))}
      </p>

      {data.daily.length > 0 && (
        <>
          <h4 style={h4}>Daily spend ({data.month})</h4>
          <div style={{ display: "flex", alignItems: "flex-end", gap: 2, height: 60, maxWidth: 640 }}>
            {data.daily.map((d) => (
              <div
                key={d.day}
                title={`${d.day}: $${d.costUsd.toFixed(4)} (${d.calls} calls)`}
                style={{
                  width: Math.max(100 / data.daily.length - 2, 4),
                  height: `${Math.max((d.costUsd / maxDaily) * 100, 2)}%`,
                  background: "#4a6fa5",
                  borderRadius: 2,
                }}
              />
            ))}
          </div>
        </>
      )}

      {data.months.length > 1 && (
        <>
          <h4 style={h4}>Monthly history</h4>
          <p style={{ fontSize: 13, margin: 0 }}>
            {data.months.map((m) => (
              <span key={m.month} style={{ display: "inline-block", marginRight: 14 }}>
                {m.month}: ${m.costUsd.toFixed(4)} ({m.calls})
              </span>
            ))}
          </p>
        </>
      )}

      <p style={{ fontSize: 11, color: "#999", marginTop: 16 }}>
        Workers AI (analysis/embeddings) runs on the free allocation and is not billed here.
      </p>
    </div>
  );
}
