import { useCallback, useEffect, useState } from "react";

interface DistillOutput {
  keywords: string[];
  thoughts_fragments: string[];
  questions: string[];
  read_next: { title: string; author?: string; why_read: string; related_question?: string }[];
  research_gaps: { gap: string; kind: string }[];
  research_directions: string[];
  artwork_directions: string[];
  small_experiment?: string;
}

interface SessionData {
  session: {
    id: string;
    redistillOf: string | null;
    modelVersion: string;
    promptVersion: string;
    costUsd: number;
    createdAt: string;
    sourcesUsed: { id: string; title: string }[] | null;
    output: DistillOutput | null;
    critic: { warnings: { category: string; note: string }[]; overall: string } | null;
    counter: { axes: { from: string; to: string; rationale: string }[]; suggestions: { direction: string; grounding: { name: string; kind: string; note: string }[] }[] } | null;
  };
  readingQueue: { id: string; title: string; author: string | null; priority: string; whyRead: string | null; relatedQuestion: string | null; sourceUrl: string | null; openalexId: string | null; verified: number }[];
  researchGaps: { id: string; gap: string; kind: string | null }[];
}

interface SessionListItem {
  id: string;
  redistillOf: string | null;
  costUsd: number;
  createdAt: string;
}

const btn: React.CSSProperties = { padding: "6px 14px", border: "1px solid #1a1a1a", background: "#1a1a1a", color: "#fff", borderRadius: 4, cursor: "pointer", fontSize: 13 };
const smallBtn: React.CSSProperties = { padding: "3px 10px", border: "1px solid #1a1a1a", background: "#fff", borderRadius: 4, cursor: "pointer", fontSize: 11 };
const h4: React.CSSProperties = { margin: "18px 0 6px", fontSize: 11, letterSpacing: 1.2, textTransform: "uppercase", color: "#777" };

const SELECTABLE = ["keywords", "thoughts_fragments", "questions", "read_next", "research_gaps", "research_directions", "artwork_directions", "small_experiment"];

export default function DistillView() {
  const [data, setData] = useState<SessionData | null>(null);
  const [sessions, setSessions] = useState<SessionListItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [budget, setBudget] = useState<{ usedPct: number; budgetUsd: number; blocked: boolean; warn: boolean } | null>(null);
  const [kept, setKept] = useState<string[]>([]);
  const [variant, setVariant] = useState<string>("distill-v2-terse");

  const loadSessions = useCallback(async () => {
    const r = await fetch("/api/distill/sessions");
    const d = (await r.json()) as { sessions: SessionListItem[] };
    setSessions(d.sessions ?? []);
    if (d.sessions?.length) await openSession(d.sessions[0]!.id);
    else setData(null);
  }, []);

  useEffect(() => {
    void loadSessions();
    fetch("/api/distill/budget")
      .then((r) => r.json())
      .then(setBudget)
      .catch(() => setBudget(null));
  }, [loadSessions]);

  async function openSession(id: string) {
    setMsg("");
    const r = await fetch(`/api/distill/sessions/${id}`);
    if (r.ok) setData((await r.json()) as SessionData);
  }

  async function runDistill(redistillOf?: string) {
    if (budget?.blocked) {
      setMsg("Monthly AI budget exhausted — Distill is blocked until next month.");
      return;
    }
    setBusy(true);
    setMsg(redistillOf ? `Re-distilling (keeping: ${kept.join(", ") || "none"})…` : "Distilling… this takes 30-60s.");
    try {
      const r = await fetch("/api/distill/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(redistillOf ? { redistillOf, keepElements: kept, promptVariant: variant } : { promptVariant: variant }),
      });
      const d = (await r.json()) as { ok?: boolean; sessionId?: string; error?: string; budgetUsedPct?: number };
      if (r.ok && d.sessionId) {
        setKept([]);
        await loadSessions();
        await openSession(d.sessionId);
        setMsg(`Done. Cost: $${(await (await fetch(`/api/distill/sessions/${d.sessionId}`)).json()).session.costUsd?.toFixed(4) ?? "?"}`);
        fetch("/api/distill/budget").then((x) => x.json()).then(setBudget).catch(() => undefined);
      } else {
        setMsg(`Failed: ${d.error ?? r.status}`);
      }
    } catch (e) {
      setMsg(`Failed: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  async function verifyQueue() {
    if (!data) return;
    setMsg("Verifying reading queue via OpenAlex…");
    const r = await fetch(`/api/distill/verify-queue/${data.session.id}`, { method: "POST" });
    const d = (await r.json()) as { verified?: number; total?: number };
    setMsg(`Verified ${d.verified ?? 0}/${d.total ?? 0} items.`);
    await openSession(data.session.id);
  }

  async function saveSelection() {
    if (!data) return;
    await fetch(`/api/distill/sessions/${data.session.id}/select`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kept }),
    });
    setMsg("Selection saved — it feeds future Radar.");
  }

  const o = data?.session.output;

  return (
    <div style={{ maxWidth: 760 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
        <button style={btn} disabled={busy} onClick={() => void runDistill()}>
          {busy ? "Distilling…" : data ? "Distill again" : "Run Distill"}
        </button>
        {data && (
          <button style={{ ...smallBtn, padding: "6px 14px" }} disabled={busy} onClick={() => void runDistill(data.session.id)}>
            Re-distill (keep selected)
          </button>
        )}
        <select
          value={variant}
          onChange={(e) => setVariant(e.target.value)}
          style={{ padding: "5px 8px", border: "1px solid #ccc", borderRadius: 4, fontSize: 12 }}
          title="Prompt variant (A/B)"
        >
          <option value="distill-v2-terse">v2 — terse (default)</option>
          <option value="distill-v1">v1 — standard</option>
        </select>
        {budget && (
          <span style={{ fontSize: 11, color: budget.blocked ? "#b04040" : budget.warn ? "#b08020" : "#777" }}>
            budget ${budget.usedPct.toFixed(0)}% of ${budget.budgetUsd}
          </span>
        )}
      </div>
      {msg && <p style={{ fontSize: 12, color: "#2a7a2a", margin: "0 0 10px" }}>{msg}</p>}

      {sessions.length > 1 && (
        <div style={{ marginBottom: 10 }}>
          {sessions.slice(0, 6).map((s) => (
            <button key={s.id} style={{ ...smallBtn, marginRight: 4 }} onClick={() => void openSession(s.id)}>
              {new Date(s.createdAt).toLocaleDateString()} {s.redistillOf ? "↻" : ""} ${s.costUsd?.toFixed(3) ?? "?"}
            </button>
          ))}
        </div>
      )}

      {!data && !busy && <p style={{ color: "#666" }}>No distill sessions yet. Run your first Distill.</p>}

      {o && data && (
        <div>
          <p style={{ fontSize: 11, color: "#999", margin: "0 0 4px" }}>
            {new Date(data.session.createdAt).toLocaleString()} · {data.session.modelVersion} · {data.session.promptVersion} · $
            {data.session.costUsd?.toFixed(4)} · sources: {data.session.sourcesUsed?.length ?? 0}
          </p>

          <h4 style={h4}>Keywords</h4>
          <div>
            {o.keywords?.map((k, i) => (
              <span key={i} style={{ display: "inline-block", padding: "1px 7px", borderRadius: 3, fontSize: 11, background: "#eee", marginRight: 6 }}>
                {k}
              </span>
            ))}
          </div>

          {o.thoughts_fragments?.length > 0 && (
            <>
              <h4 style={h4}>Thoughts / Fragments</h4>
              {o.thoughts_fragments.map((t, i) => (
                <p key={i} style={{ margin: "4px 0", fontSize: 14 }}>
                  — {t}
                </p>
              ))}
            </>
          )}

          {o.questions?.length > 0 && (
            <>
              <h4 style={h4}>Questions</h4>
              <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13 }}>
                {o.questions.map((q, i) => (
                  <li key={i}>{q}</li>
                ))}
              </ul>
            </>
          )}

          {data.readingQueue.length > 0 && (
            <>
              <h4 style={h4}>
                Reading Queue{" "}
                <button style={{ ...smallBtn, marginLeft: 8 }} onClick={() => void verifyQueue()}>
                  Verify via OpenAlex
                </button>
              </h4>
              {data.readingQueue.map((q) => (
                <div key={q.id} style={{ marginBottom: 8, fontSize: 13 }}>
                  <strong>
                    {q.sourceUrl ? (
                      <a href={q.sourceUrl} target="_blank" rel="noreferrer" style={{ color: "#1a1a1a" }}>
                        {q.title}
                      </a>
                    ) : (
                      q.title
                    )}
                  </strong>
                  {q.author ? <span style={{ color: "#666" }}> — {q.author}</span> : null}{" "}
                  <span
                    style={{
                      fontSize: 10,
                      padding: "1px 6px",
                      borderRadius: 3,
                      background: q.verified ? "#2a7a2a" : "#eee",
                      color: q.verified ? "#fff" : "#888",
                    }}
                    title={q.verified ? "Existence verified via OpenAlex" : "Not yet verified in OpenAlex"}
                  >
                    {q.verified ? "verified" : "unverified"}
                  </span>
                  {q.whyRead && <p style={{ margin: "2px 0 0", color: "#555", fontSize: 12 }}>why: {q.whyRead}</p>}
                </div>
              ))}
            </>
          )}

          {data.researchGaps.length > 0 && (
            <>
              <h4 style={h4}>Research Gaps</h4>
              {data.researchGaps.map((g) => (
                <p key={g.id} style={{ margin: "4px 0", fontSize: 13 }}>
                  • {g.gap} {g.kind && <span style={{ fontSize: 10, color: "#999" }}>[{g.kind}]</span>}
                </p>
              ))}
            </>
          )}

          {o.research_directions?.length > 0 && (
            <>
              <h4 style={h4}>Research Directions</h4>
              <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13 }}>
                {o.research_directions.map((d, i) => (
                  <li key={i}>{d}</li>
                ))}
              </ul>
            </>
          )}

          {o.artwork_directions?.length > 0 && (
            <>
              <h4 style={h4}>Artwork Directions</h4>
              <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13 }}>
                {o.artwork_directions.map((d, i) => (
                  <li key={i}>{d}</li>
                ))}
              </ul>
            </>
          )}

          {o.small_experiment && (
            <>
              <h4 style={h4}>Small Experiment</h4>
              <p style={{ fontSize: 13 }}>{o.small_experiment}</p>
            </>
          )}

          {data.session.critic && (
            <>
              <h4 style={{ ...h4, color: "#b08020" }}>Critic</h4>
              <p style={{ fontSize: 13, margin: "0 0 4px" }}>
                <em>{data.session.critic.overall}</em>
              </p>
              {data.session.critic.warnings?.map((w, i) => (
                <p key={i} style={{ margin: "2px 0", fontSize: 12, color: "#7a5a10" }}>
                  ⚠ [{w.category}] {w.note}
                </p>
              ))}
              {data.session.critic.warnings?.length === 0 && <p style={{ fontSize: 12, color: "#777" }}>No warnings.</p>}
            </>
          )}

          {data.session.counter && (
            <>
              <h4 style={{ ...h4, color: "#5a3a7a" }}>Counter</h4>
              {data.session.counter.axes?.map((a, i) => (
                <p key={i} style={{ margin: "2px 0", fontSize: 12, color: "#5a3a7a" }}>
                  {a.from} → {a.to}
                </p>
              ))}
              {data.session.counter.suggestions?.map((s, i) => (
                <div key={i} style={{ margin: "8px 0", fontSize: 13 }}>
                  <strong>{s.direction}</strong>
                  {s.grounding?.map((g, j) => (
                    <p key={j} style={{ margin: "2px 0 0", fontSize: 12, color: "#666" }}>
                      · {g.name} ({g.kind}): {g.note}
                    </p>
                  ))}
                </div>
              ))}
            </>
          )}

          <h4 style={h4}>Select to keep / re-distill</h4>
          <div style={{ marginBottom: 8 }}>
            {SELECTABLE.map((k) => (
              <label key={k} style={{ display: "inline-block", marginRight: 12, fontSize: 12 }}>
                <input
                  type="checkbox"
                  checked={kept.includes(k)}
                  onChange={(e) => setKept(e.target.checked ? [...kept, k] : kept.filter((x) => x !== k))}
                />{" "}
                {k}
              </label>
            ))}
          </div>
          <button style={{ ...smallBtn, marginRight: 6 }} onClick={() => void saveSelection()}>
            Save selection
          </button>
          <button style={smallBtn} disabled={busy} onClick={() => void runDistill(data.session.id)}>
            Re-distill with selection
          </button>
        </div>
      )}
    </div>
  );
}
