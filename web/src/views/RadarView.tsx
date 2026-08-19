import { useEffect, useState } from "react";
import type { RadarPeriod } from "@radar/shared";
import { runTask, useTasks } from "../lib/tasks";

interface Stats {
  newSources: number;
  newKeywords: { keyword: string; count: number }[];
  newQuestions: string[];
  signalCounts: Record<string, number>;
  topKeptSources: { title: string; kind: string }[];
  distillRuns: number;
  gapsRaised: number;
  readingQueueSize: number;
  kindBreakdown: Record<string, number>;
}

interface Synthesis {
  period: RadarPeriod;
  narrative: string;
  sections: { heading: string; items: string[] }[];
  biasWatch: string[];
  costUsd: number;
}

const btn: React.CSSProperties = { padding: "6px 14px", border: "1px solid #1a1a1a", background: "#1a1a1a", color: "#fff", borderRadius: 4, cursor: "pointer", fontSize: 13 };
const tabBtn: React.CSSProperties = { padding: "4px 12px", border: "1px solid #ccc", background: "#fff", borderRadius: 4, cursor: "pointer", fontSize: 12 };
const activeTab: React.CSSProperties = { ...tabBtn, background: "#1a1a1a", color: "#fff", borderColor: "#1a1a1a" };
const h4: React.CSSProperties = { margin: "16px 0 6px", fontSize: 11, letterSpacing: 1.2, textTransform: "uppercase", color: "#777" };

let lastSynth: Synthesis | null = null;

export default function RadarView() {
  const [period, setPeriod] = useState<RadarPeriod>("WEEKLY");
  const [stats, setStats] = useState<Stats | null>(null);
  const [synth, setSynth] = useState<Synthesis | null>(lastSynth);
  const [msg, setMsg] = useState("");
  const tasks = useTasks();
  const synthBusy = tasks.some((t) => t.label === "Radar synthesis" && t.status === "running");

  useEffect(() => {
    setSynth(lastSynth);
  }, []);

  useEffect(() => {
    fetch(`/api/radar/stats?period=${period}`)
      .then((r) => r.json() as Promise<{ stats: Stats }>)
      .then((d) => setStats(d.stats))
      .catch(() => setStats(null));
  }, [period]);

  async function runSynthesis() {
    await runTask("Radar synthesis", async (setTaskMsg) => {
      setTaskMsg(`${period.toLowerCase()}…`);
      const r = await fetch("/api/radar/synthesize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ period }),
      });
      if (r.ok) {
        const s = (await r.json()) as Synthesis;
        lastSynth = s;
        setSynth(s);
        setMsg("");
      } else {
        const d = (await r.json()) as { error?: string };
        throw new Error(`Failed: ${d.error ?? r.status}`);
      }
    });
  }

  return (
    <div style={{ maxWidth: 760 }}>
      <div style={{ marginBottom: 12 }}>
        {(["WEEKLY", "MONTHLY", "YEARLY"] as RadarPeriod[]).map((p) => (
          <button key={p} style={p === period ? { ...activeTab, marginRight: 6 } : { ...tabBtn, marginRight: 6 }} onClick={() => setPeriod(p)}>
            {p}
          </button>
        ))}
        <button style={{ ...btn, marginLeft: 8 }} disabled={synthBusy} onClick={() => void runSynthesis()}>
          {synthBusy ? "Synthesizing…" : "Run Radar synthesis"}
        </button>
      </div>
      {msg && <p style={{ fontSize: 12, color: "#2a7a2a" }}>{msg}</p>}

      {synth && (
        <div style={{ background: "#f7f7f5", padding: 16, borderRadius: 6, marginBottom: 20 }}>
          <p style={{ fontSize: 15, margin: "0 0 8px" }}>{synth.narrative}</p>
          {synth.sections.map((s, i) => (
            <div key={i} style={{ marginTop: 10 }}>
              <h4 style={{ ...h4, margin: "6px 0 2px" }}>{s.heading}</h4>
              <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13 }}>
                {s.items.map((it, j) => (
                  <li key={j}>{it}</li>
                ))}
              </ul>
            </div>
          ))}
          {synth.biasWatch.length > 0 && (
            <div style={{ marginTop: 12, padding: 8, background: "#f0e8f7", borderRadius: 4 }}>
              <h4 style={{ ...h4, color: "#5a3a7a", margin: "0 0 2px" }}>Bias watch</h4>
              {synth.biasWatch.map((b, i) => (
                <p key={i} style={{ margin: "2px 0", fontSize: 12, color: "#5a3a7a" }}>
                  ⚠ {b}
                </p>
              ))}
            </div>
          )}
          <p style={{ fontSize: 10, color: "#999", margin: "10px 0 0" }}>synthesized · ${synth.costUsd.toFixed(4)}</p>
        </div>
      )}

      {stats ? (
        <div>
          <h4 style={h4}>Signals ({period.toLowerCase()})</h4>
          <p style={{ fontSize: 13, margin: "0 0 4px" }}>
            new sources: <strong>{stats.newSources}</strong> · distills: <strong>{stats.distillRuns}</strong> · gaps raised:{" "}
            <strong>{stats.gapsRaised}</strong> · reading queue: <strong>{stats.readingQueueSize}</strong>
          </p>
          <p style={{ fontSize: 13, margin: "0 0 4px" }}>
            user actions: {Object.entries(stats.signalCounts).map(([k, v]) => `${k} ${v}`).join(" · ") || "none"}
          </p>

          {stats.newKeywords.length > 0 && (
            <>
              <h4 style={h4}>Rising keywords</h4>
              <div>
                {stats.newKeywords.map((k, i) => (
                  <span key={i} style={{ display: "inline-block", padding: "1px 7px", borderRadius: 3, fontSize: 11, background: "#eee", marginRight: 6 }}>
                    {k.keyword} ({k.count})
                  </span>
                ))}
              </div>
            </>
          )}

          {stats.newQuestions.length > 0 && (
            <>
              <h4 style={h4}>Recent questions</h4>
              <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13 }}>
                {stats.newQuestions.slice(0, 5).map((q, i) => (
                  <li key={i}>{q}</li>
                ))}
              </ul>
            </>
          )}

          {stats.topKeptSources.length > 0 && (
            <>
              <h4 style={h4}>Kept / developed</h4>
              <p style={{ fontSize: 13 }}>{stats.topKeptSources.map((s) => s.title).join(" · ")}</p>
            </>
          )}

          <h4 style={h4}>Reservoir composition</h4>
          <p style={{ fontSize: 12, color: "#666" }}>{Object.entries(stats.kindBreakdown).map(([k, v]) => `${k}: ${v}`).join(" · ") || "empty"}</p>
        </div>
      ) : (
        <p style={{ color: "#666" }}>Loading stats…</p>
      )}
    </div>
  );
}
