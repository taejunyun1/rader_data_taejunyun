import { useEffect, useRef, useState, type ChangeEvent } from "react";
import type { InboxItem } from "@radar/shared";
import { extractPdfText, fileToBase64 } from "../lib/pdf";

const STATUS_COLORS: Record<string, string> = {
  received: "#888888",
  stored: "#4a6fa5",
  extracted: "#2a7a2a",
  analyzed: "#1a6c1a",
  indexed: "#155c15",
  failed: "#b04040",
};

export default function InboxView() {
  const [items, setItems] = useState<InboxItem[]>([]);
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const [title, setTitle] = useState("");
  const [text, setText] = useState("");
  const [url, setUrl] = useState("");
  const fileRef = useRef<HTMLInputElement | null>(null);

  async function load() {
    try {
      const r = await fetch("/api/inbox");
      const d = (await r.json()) as { items?: InboxItem[] };
      setItems(d.items ?? []);
    } catch {
      setItems([]);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function post(path: string, body: unknown): Promise<Record<string, unknown> | null> {
    setBusy(true);
    setMsg("");
    try {
      const r = await fetch(`/api/inbox${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const d = (await r.json()) as Record<string, unknown>;
      if (!r.ok) {
        setMsg(`Error: ${String(d.error ?? r.status)}`);
        return null;
      }
      return d;
    } catch (e) {
      setMsg(`Error: ${(e as Error).message}`);
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function addNote() {
    if (!text.trim()) return;
    const d = await post("/text", { text, title: title || undefined });
    if (d) {
      setMsg(d.duplicateOf ? "Duplicate — linked to existing source." : `Added: ${String(d.title)}`);
      setTitle("");
      setText("");
      void load();
    }
  }

  async function addUrl() {
    if (!url.trim()) return;
    const d = await post("/url", { url });
    if (d) {
      if (d.error) setMsg(`Fetch failed (kept for retry): ${String(d.error)}`);
      else if (d.duplicateOf) setMsg("Duplicate — linked to existing source.");
      else setMsg(`Added: ${String(d.title)}`);
      setUrl("");
      void load();
    }
  }

  async function onFile(e: ChangeEvent<HTMLInputElement>) {
    const files = e.target.files;
    if (!files) return;
    for (const f of Array.from(files)) {
      if (/\.(md|markdown|txt)$/i.test(f.name)) {
        const fileText = await f.text();
        const d = await post("/file", { filename: f.name, text: fileText });
        if (d) setMsg(d.duplicateOf ? "Duplicate — linked to existing source." : `Added: ${f.name}`);
      } else if (/\.pdf$/i.test(f.name)) {
        setMsg(`Extracting text from ${f.name}…`);
        try {
          const { text, pageCount } = await extractPdfText(f);
          const hasText = text.replace(/\[page \d+\]|\s/g, "").length >= 20;
          const originalBase64 = f.size <= 10_000_000 ? await fileToBase64(f) : undefined;
          const d = await post("/file", {
            filename: f.name,
            text: hasText ? text : undefined,
            originalBase64,
            contentType: "application/pdf",
          });
          if (d) {
            if (d.duplicateOf) setMsg("Duplicate — linked to existing source.");
            else if (!hasText)
              setMsg(
                `${f.name}: ${pageCount} pages, NO text layer (scanned PDF). Original preserved — add key passages as a note for analysis.`
              );
            else setMsg(`Added: ${f.name} (${pageCount} pages)`);
          }
        } catch (err) {
          setMsg(`${f.name}: PDF extraction failed — ${(err as Error).message}`);
        }
      } else {
        setMsg(`Unsupported file type: ${f.name}`);
      }
    }
    e.target.value = "";
    void load();
  }

  async function retry(sourceId: string) {
    const d = await post(`/retry/${sourceId}`, {});
    setMsg(d && d.ok ? "Retry succeeded." : "Retry failed — see status.");
    void load();
  }

  const inputStyle: React.CSSProperties = {
    padding: "6px 10px",
    border: "1px solid #ccc",
    borderRadius: 4,
    fontSize: 13,
    width: "100%",
    boxSizing: "border-box",
  };
  const btnStyle: React.CSSProperties = {
    padding: "6px 14px",
    border: "1px solid #1a1a1a",
    background: busy ? "#cccccc" : "#1a1a1a",
    color: "#ffffff",
    borderRadius: 4,
    cursor: busy ? "default" : "pointer",
    fontSize: 13,
  };
  const sectionStyle: React.CSSProperties = { marginBottom: 22 };
  const h3Style: React.CSSProperties = {
    margin: "0 0 8px",
    fontSize: 11,
    letterSpacing: 1.2,
    textTransform: "uppercase",
    color: "#777",
  };

  return (
    <div style={{ maxWidth: 720 }}>
      <div style={sectionStyle}>
        <h3 style={h3Style}>Add note / text</h3>
        <input
          style={{ ...inputStyle, marginBottom: 6 }}
          placeholder="Title (optional)"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
        <textarea
          style={{ ...inputStyle, height: 90, marginBottom: 6, fontFamily: "inherit" }}
          placeholder="Paste text or a note…"
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <button style={btnStyle} disabled={busy} onClick={() => void addNote()}>
          Save note
        </button>
      </div>

      <div style={sectionStyle}>
        <h3 style={h3Style}>Add URL</h3>
        <input
          style={{ ...inputStyle, marginBottom: 6 }}
          placeholder="https://…"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
        />
        <button style={btnStyle} disabled={busy} onClick={() => void addUrl()}>
          Fetch &amp; add
        </button>
      </div>

      <div style={sectionStyle}>
        <h3 style={h3Style}>Upload file (.md / .txt / .pdf)</h3>
        <input ref={fileRef} type="file" accept=".md,.markdown,.txt,.pdf" multiple onChange={(e) => void onFile(e)} />
      </div>

      {msg && <p style={{ fontSize: 13, color: "#444" }}>{msg}</p>}

      <h3 style={h3Style}>Recent items</h3>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
        <tbody>
          {items.map((it) => (
            <tr key={it.sourceId} style={{ borderBottom: "1px solid #eee" }}>
              <td style={{ padding: "7px 6px 7px 0", verticalAlign: "top" }}>
                <span
                  style={{
                    display: "inline-block",
                    padding: "1px 6px",
                    borderRadius: 3,
                    fontSize: 10,
                    letterSpacing: 0.5,
                    color: "#fff",
                    background: STATUS_COLORS[it.status] ?? "#888",
                    marginRight: 8,
                  }}
                >
                  {it.status}
                </span>
                {it.title}
                <span style={{ color: "#999", marginLeft: 8, fontSize: 11 }}>
                  {it.kind} · {it.origin ?? "?"} · {it.createdAt?.slice(0, 10)}
                </span>
                {it.error && (
                  <span style={{ color: "#b04040", marginLeft: 8, fontSize: 11 }}>{it.error.slice(0, 90)}</span>
                )}
              </td>
              <td style={{ padding: 7, textAlign: "right", verticalAlign: "top" }}>
                {it.status === "failed" && (
                  <button
                    style={{ ...btnStyle, padding: "2px 8px", fontSize: 11 }}
                    disabled={busy}
                    onClick={() => void retry(it.sourceId)}
                  >
                    Retry
                  </button>
                )}
              </td>
            </tr>
          ))}
          {items.length === 0 && (
            <tr>
              <td style={{ padding: 8, color: "#999" }}>Nothing yet — add a note, URL, or file above.</td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
