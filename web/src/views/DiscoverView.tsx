import { useCallback, useEffect, useState } from "react";
import { runTask, useTasks } from "../lib/tasks";

interface Candidate {
  id: string;
  openalexId: string | null;
  title: string;
  authors: string | null;
  year: number | null;
  relevanceScore: number | null;
  status: string;
  queryUsed: string | null;
  provider?: string;
  externalUrl?: string | null;
}

const btn: React.CSSProperties = { padding: "6px 14px", border: "1px solid #1a1a1a", background: "#1a1a1a", color: "#fff", borderRadius: 4, cursor: "pointer", fontSize: 13 };
const smallBtn: React.CSSProperties = { padding: "3px 10px", border: "1px solid #1a1a1a", background: "#fff", borderRadius: 4, cursor: "pointer", fontSize: 11 };
const h4: React.CSSProperties = { margin: "0 0 8px", fontSize: 11, letterSpacing: 1.2, textTransform: "uppercase", color: "#777" };

export default function DiscoverView() {
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [statusFilter, setStatusFilter] = useState("CANDIDATE");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const [queries, setQueries] = useState("");
  const [savedQueries, setSavedQueries] = useState<string[]>([]);
  const [feeds, setFeeds] = useState("");
  const [feedMsg, setFeedMsg] = useState("");
  const tasks = useTasks();
  const discoverBusy = tasks.some((t) => t.label === "Discovery" && t.status === "running");

  const load = useCallback(async () => {
    const r = await fetch(`/api/discover/candidates?status=${statusFilter}`);
    const d = (await r.json()) as { items: Candidate[] };
    setCandidates(d.items ?? []);
  }, [statusFilter]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    fetch("/api/discover/queries")
      .then((r) => r.json() as Promise<{ queries: string[] }>)
      .then((d) => {
        setSavedQueries(d.queries ?? []);
        setQueries((d.queries ?? []).join("\n"));
      })
      .catch(() => undefined);
    fetch("/api/discover/feeds")
      .then((r) => r.json() as Promise<{ feeds: string[] }>)
      .then((d) => setFeeds((d.feeds ?? []).join("\n")))
      .catch(() => undefined);
  }, []);

  async function saveFeeds() {
    const list = feeds.split("\n").map((f) => f.trim()).filter((f) => /^https?:\/\//.test(f));
    const r = await fetch("/api/discover/feeds", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ feeds: list }),
    });
    if (r.ok) setFeedMsg(`${list.length} feeds saved.`);
    else setFeedMsg("Save failed.");
  }

  async function runDiscovery() {
    await runTask("Discovery", async (setTaskMsg) => {
      setTaskMsg("collecting…");
      const r = await fetch("/api/discover/run", { method: "POST" });
      const d = (await r.json()) as { collected?: number; queries?: string[]; error?: string };
      if (!r.ok) throw new Error(`Failed: ${d.error ?? r.status}`);
      setTaskMsg(`${d.collected} collected`);
      setMsg(`Collected ${d.collected} new candidates (queries: ${d.queries?.join(", ")}).`);
      setStatusFilter("CANDIDATE");
      await load();
    });
  }

  async function act(id: string, action: string) {
    const r = await fetch(`/api/discover/candidates/${id}/${action}`, { method: "POST" });
    const d = (await r.json()) as { status?: string; sourceId?: string };
    if (r.ok) {
      setMsg(action === "keep" && d.sourceId ? `Kept — added to Reservoir (${d.status}).` : `${action} → ${d.status}`);
      await load();
    }
  }

  async function saveQueries() {
    const list = queries.split("\n").map((q) => q.trim()).filter(Boolean);
    const r = await fetch("/api/discover/queries", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ queries: list }),
    });
    if (r.ok) {
      setSavedQueries(list);
      setMsg("Queries saved.");
    }
  }

  return (
    <div style={{ maxWidth: 760 }}>
      <div style={{ marginBottom: 14 }}>
        <button style={btn} disabled={discoverBusy} onClick={() => void runDiscovery()}>
          {discoverBusy ? "Collecting…" : "Run discovery now"}
        </button>
        <span style={{ fontSize: 11, color: "#777", marginLeft: 10 }}>
          weekly cron auto-runs · max 20/run
          {savedQueries.length ? ` · custom: ${savedQueries.join(", ")}` : ""}
        </span>
      </div>
      {msg && <p style={{ fontSize: 12, color: "#2a7a2a", margin: "0 0 10px" }}>{msg}</p>}

      <div style={{ marginBottom: 16 }}>
        <h4 style={h4}>Custom queries (one per line, max 4 — added on top of momentum keywords)</h4>
        <textarea
          style={{ width: "100%", padding: "6px 10px", border: "1px solid #ccc", borderRadius: 4, fontSize: 13, fontFamily: "inherit", height: 70, boxSizing: "border-box" }}
          value={queries}
          onChange={(e) => setQueries(e.target.value)}
          placeholder={"computational photography\ndeep learning image formation"}
        />
        <button style={{ ...smallBtn, marginTop: 6 }} onClick={() => void saveQueries()}>
          Save queries
        </button>
      </div>

      <div style={{ marginBottom: 16 }}>
        <h4 style={h4}>RSS/Atom feeds (one URL per line, max 6 — journals, blogs)</h4>
        <textarea
          style={{ width: "100%", padding: "6px 10px", border: "1px solid #ccc", borderRadius: 4, fontSize: 12, fontFamily: "inherit", height: 70, boxSizing: "border-box" }}
          value={feeds}
          onChange={(e) => setFeeds(e.target.value)}
          placeholder={"https://some-journal.org/rss\nhttps://blog.example.com/feed"}
        />
        <button style={{ ...smallBtn, marginTop: 6 }} onClick={() => void saveFeeds()}>
          Save feeds
        </button>
        {feedMsg && <span style={{ fontSize: 11, color: "#2a7a2a", marginLeft: 8 }}>{feedMsg}</span>}
      </div>

      <div style={{ marginBottom: 8 }}>
        {["CANDIDATE", "KEPT", "WATCHED", "IGNORED"].map((s) => (
          <button key={s} style={{ ...smallBtn, marginRight: 4, ...(s === statusFilter ? { background: "#1a1a1a", color: "#fff" } : {}) }} onClick={() => setStatusFilter(s)}>
            {s}
          </button>
        ))}
      </div>

      {candidates.length === 0 ? (
        <p style={{ color: "#666", fontSize: 13 }}>No candidates. Run discovery.</p>
      ) : (
        candidates.map((c) => (
          <div key={c.id} style={{ padding: "10px 0", borderBottom: "1px solid #eee" }}>
            <div style={{ fontSize: 14 }}>
              {c.externalUrl || c.openalexId ? (
                <a href={c.externalUrl ?? c.openalexId ?? "#"} target="_blank" rel="noreferrer" style={{ color: "#1a1a1a" }}>
                  {c.title}
                </a>
              ) : (
                c.title
              )}
              {c.provider && c.provider !== "openalex" && (
                <span style={{ fontSize: 10, background: "#eef", color: "#446", padding: "1px 6px", borderRadius: 3, marginLeft: 6 }}>
                  {c.provider}
                </span>
              )}
            </div>
            <p style={{ margin: "2px 0", fontSize: 12, color: "#777" }}>
              {c.authors ?? "unknown"} · {c.year ?? "?"} · score {(c.relevanceScore ?? 0).toFixed(2)}
              {c.queryUsed ? ` · query: ${c.queryUsed}` : ""}
            </p>
            {c.status === "CANDIDATE" && (
              <div>
                <button style={{ ...smallBtn, marginRight: 4 }} onClick={() => void act(c.id, "keep")}>
                  Keep → Reservoir
                </button>
                <button style={{ ...smallBtn, marginRight: 4 }} onClick={() => void act(c.id, "watch")}>
                  Watch
                </button>
                <button style={smallBtn} onClick={() => void act(c.id, "ignore")}>
                  Ignore
                </button>
              </div>
            )}
          </div>
        ))
      )}
    </div>
  );
}
