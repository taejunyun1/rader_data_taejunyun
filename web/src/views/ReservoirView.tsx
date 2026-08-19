import { useCallback, useEffect, useState } from "react";

interface ReservoirItem {
  id: string;
  title: string;
  kind: string;
  reliability: string;
  status: string;
  origin: string | null;
  year: number | null;
  createdAt: string;
  topics: string | null;
  keywordCount: number;
  signalCount: number;
}

interface SourceDetail {
  source: Record<string, unknown>;
  analysis: {
    summary?: string;
    keywords?: string[];
    questions?: string[];
    important_fragments?: string[];
    classification?: { language?: string; medium?: string };
  } | null;
  keywords: { keyword: string; weight: number }[];
  questions: { question: string; status: string }[];
  fragments: { text: string }[];
  versions: { version: number; char_count: number; created_at: string }[];
  signals: { action: string; created_at: string }[];
}

const btn: React.CSSProperties = {
  padding: "4px 12px",
  border: "1px solid #1a1a1a",
  background: "#fff",
  borderRadius: 4,
  cursor: "pointer",
  fontSize: 12,
};
const activeBtn: React.CSSProperties = { ...btn, background: "#1a1a1a", color: "#fff" };
const chip: React.CSSProperties = {
  display: "inline-block",
  padding: "1px 7px",
  borderRadius: 3,
  fontSize: 10,
  background: "#eee",
  marginRight: 6,
};

export default function ReservoirView() {
  const [items, setItems] = useState<ReservoirItem[]>([]);
  const [kindFilter, setKindFilter] = useState<string>("");
  const [topicFilter, setTopicFilter] = useState<string>("");
  const [topics, setTopics] = useState<{ topic: string; count: number }[]>([]);
  const [detail, setDetail] = useState<SourceDetail | null>(null);
  const [msg, setMsg] = useState("");
  const [query, setQuery] = useState("");
  const [searchHits, setSearchHits] = useState<{ sourceId: string; title: string; matched: string; snippet: string }[] | null>(null);

  const load = useCallback(async () => {
    const qs = new URLSearchParams();
    if (kindFilter) qs.set("kind", kindFilter);
    if (topicFilter) qs.set("topic", topicFilter);
    const r = await fetch(`/api/reservoir${qs.toString() ? `?${qs}` : ""}`);
    const d = (await r.json()) as { items?: ReservoirItem[] };
    setItems(d.items ?? []);
  }, [kindFilter, topicFilter]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    fetch("/api/reservoir/topics")
      .then((r) => r.json() as Promise<{ topics?: { topic: string; count: number }[] }>)
      .then((d) => setTopics(d.topics ?? []))
      .catch(() => setTopics([]));
  }, [items]);

  async function openDetail(id: string, keepMsg = true) {
    if (!keepMsg) setMsg("");
    setSearchHits(null);
    const r = await fetch(`/api/reservoir/${id}`);
    if (!r.ok) {
      setDetail(null);
      return;
    }
    setDetail((await r.json()) as SourceDetail);
    await fetch("/api/signals", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sourceId: id, action: "view" }),
    });
  }

  async function signal(action: string) {
    if (!detail) return;
    await fetch("/api/signals", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sourceId: detail.source.id, action }),
    });
    setMsg(`Recorded: ${action}`);
    await openDetail(String(detail.source.id));
  }

  async function runSearch() {
    if (!query.trim()) {
      setSearchHits(null);
      return;
    }
    const r = await fetch(`/api/search?q=${encodeURIComponent(query)}`);
    const d = (await r.json()) as { hits?: { sourceId: string; title: string; matched: string; snippet: string }[] };
    setSearchHits(d.hits ?? []);
    setDetail(null);
  }

  async function reanalyze() {
    if (!detail) return;
    setMsg("Re-analyzing…");
    const r = await fetch(`/api/inbox/retry/${String(detail.source.id)}?analyze=1`, { method: "POST" });
    const d = (await r.json()) as { status?: string; error?: string };
    setMsg(d.status === "analyzed" ? "Analysis complete." : `Analysis failed: ${String(d.error ?? "?").slice(0, 160)}`);
    await openDetail(String(detail.source.id));
  }

  const kinds = ["", "PERSONAL_WORK", "PERSONAL_TEXT", "PAPER_ACADEMIC", "BOOK_ARTICLE", "ARTIST_ARTWORK", "TECHNICAL", "WEB", "NOTE", "DISCOVERY"];

  if (detail) {
    const a = detail.analysis;
    return (
      <div style={{ maxWidth: 760 }}>
        <button style={btn} onClick={() => setDetail(null)}>
          ← Back
        </button>
        <h3 style={{ marginBottom: 4 }}>{String(detail.source.title)}</h3>
        <p style={{ fontSize: 12, color: "#777", marginTop: 0 }}>
          {String(detail.source.kind)} · {String(detail.source.reliability)} · {String(detail.source.origin)} ·{" "}
          {detail.source.year ? String(detail.source.year) + " · " : ""}
          {String(detail.source.createdAt).slice(0, 10)}
          {detail.source.canonicalUrl ? (
            <>
              {" · "}
              <a href={String(detail.source.canonicalUrl)} target="_blank" rel="noreferrer">
                source
              </a>
            </>
          ) : null}
        </p>

        <div style={{ marginBottom: 16 }}>
          {["keep", "watch", "develop", "ignore"].map((s) => (
            <button key={s} style={{ ...btn, marginRight: 6 }} onClick={() => void signal(s)}>
              {s.toUpperCase()}
            </button>
          ))}
          <button style={{ ...btn, marginLeft: 12 }} onClick={() => void reanalyze()}>
            Re-analyze
          </button>
        </div>
        {msg && <p style={{ fontSize: 12, color: "#2a7a2a" }}>{msg}</p>}

        {a?.summary && (
          <section style={{ marginBottom: 14 }}>
            <h4 style={{ margin: "0 0 4px", fontSize: 11, letterSpacing: 1, color: "#777", textTransform: "uppercase" }}>Summary</h4>
            <p style={{ margin: 0, fontSize: 14 }}>{a.summary}</p>
          </section>
        )}
        {(a?.keywords?.length ?? detail.keywords.length) > 0 && (
          <section style={{ marginBottom: 14 }}>
            <h4 style={{ margin: "0 0 4px", fontSize: 11, letterSpacing: 1, color: "#777", textTransform: "uppercase" }}>Keywords</h4>
            {(a?.keywords ?? detail.keywords.map((k) => k.keyword)).map((k, i) => (
              <span key={i} style={chip}>
                {k}
              </span>
            ))}
          </section>
        )}
        {(a?.questions?.length ?? 0) > 0 && (
          <section style={{ marginBottom: 14 }}>
            <h4 style={{ margin: "0 0 4px", fontSize: 11, letterSpacing: 1, color: "#777", textTransform: "uppercase" }}>Questions</h4>
            <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13 }}>
              {a?.questions?.map((q, i) => <li key={i}>{q}</li>)}
            </ul>
          </section>
        )}
        {(a?.important_fragments?.length ?? 0) > 0 && (
          <section style={{ marginBottom: 14 }}>
            <h4 style={{ margin: "0 0 4px", fontSize: 11, letterSpacing: 1, color: "#777", textTransform: "uppercase" }}>Fragments</h4>
            {a?.important_fragments?.map((f, i) => (
              <blockquote key={i} style={{ margin: "4px 0", paddingLeft: 10, borderLeft: "2px solid #ccc", fontSize: 13 }}>
                {f}
              </blockquote>
            ))}
          </section>
        )}
        <section>
          <h4 style={{ margin: "0 0 4px", fontSize: 11, letterSpacing: 1, color: "#777", textTransform: "uppercase" }}>
            History · versions {detail.versions.length} · signals {detail.signals.length}
          </h4>
          <p style={{ fontSize: 12, color: "#999" }}>
            {detail.signals.slice(0, 8).map((s, i) => (
              <span key={i}>
                {i > 0 ? " → " : ""}
                {s.action}
              </span>
            ))}
          </p>
        </section>
      </div>
    );
  }

  return (
    <div style={{ maxWidth: 760 }}>
      <div style={{ marginBottom: 14 }}>
        <input
          style={{ padding: "6px 10px", border: "1px solid #ccc", borderRadius: 4, fontSize: 13, width: 320, marginRight: 6 }}
          placeholder="Search reservoir…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void runSearch()}
        />
        <button style={btn} onClick={() => void runSearch()}>
          Search
        </button>
      </div>

      {searchHits ? (
        <>
          <p style={{ fontSize: 12, color: "#777" }}>{searchHits.length} results</p>
          {searchHits.map((h) => (
            <div key={h.sourceId} style={{ padding: "8px 0", borderBottom: "1px solid #eee" }}>
              <a href="#" style={{ color: "#1a1a1a", fontSize: 14 }} onClick={(e) => { e.preventDefault(); void openDetail(h.sourceId, false); }}>
                {h.title}
              </a>
              <span style={{ marginLeft: 8, fontSize: 10, background: "#eee", padding: "1px 7px", borderRadius: 3 }}>{h.matched}</span>
              {h.snippet && <p style={{ margin: "2px 0 0", fontSize: 12, color: "#666" }}>{h.snippet}</p>}
            </div>
          ))}
        </>
      ) : (
        <>
          <div style={{ marginBottom: 10 }}>
            {kinds.map((k) => (
              <button key={k} style={k === kindFilter ? activeBtn : { ...btn, marginRight: 4 }} onClick={() => setKindFilter(k)}>
                {k || "ALL"}
              </button>
            ))}
          </div>
          {topics.length > 0 && (
            <div style={{ marginBottom: 10, display: "flex", flexWrap: "wrap", gap: 4, maxWidth: 700 }}>
              {topics.slice(0, 14).map((t) => (
                <button
                  key={t.topic}
                  onClick={() => setTopicFilter(topicFilter === t.topic ? "" : t.topic)}
                  style={{
                    fontSize: 10,
                    padding: "1px 8px",
                    borderRadius: 10,
                    cursor: "pointer",
                    border: `1px solid ${topicFilter === t.topic ? "#4a6fa5" : "#ddd"}`,
                    background: topicFilter === t.topic ? "#4a6fa5" : "#f5f5f5",
                    color: topicFilter === t.topic ? "#fff" : "#555",
                  }}
                >
                  {t.topic} {t.count}
                </button>
              ))}
              {topicFilter && (
                <button style={{ fontSize: 10, padding: "1px 8px", borderRadius: 10, border: "none", background: "none", color: "#999", cursor: "pointer" }} onClick={() => setTopicFilter("")}>
                  clear ×
                </button>
              )}
            </div>
          )}
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <tbody>
              {items.map((it) => (
                <tr key={it.id} style={{ borderBottom: "1px solid #eee" }}>
                  <td style={{ padding: "7px 6px 7px 0" }}>
                    <a href="#" style={{ color: "#1a1a1a" }} onClick={(e) => { e.preventDefault(); void openDetail(it.id); }}>
                      {it.title}
                    </a>
                    <span style={{ color: "#999", marginLeft: 8, fontSize: 11 }}>
                      {it.kind} · {it.reliability} · {it.status}
                      {it.keywordCount > 0 ? ` · ${it.keywordCount} kw` : ""}
                      {it.signalCount > 0 ? ` · ★${it.signalCount}` : ""}
                    </span>
                    {it.topics && (
                      <div style={{ marginTop: 2 }}>
                        {(JSON.parse(it.topics) as string[]).map((t) => (
                          <span key={t} style={{ fontSize: 9, background: "#eef2f8", color: "#4a6fa5", padding: "0 6px", borderRadius: 8, marginRight: 4 }}>
                            {t}
                          </span>
                        ))}
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}
