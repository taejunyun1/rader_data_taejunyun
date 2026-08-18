import { useState } from "react";

const btnStyle: React.CSSProperties = {
  padding: "6px 14px",
  border: "1px solid #1a1a1a",
  background: "#1a1a1a",
  color: "#ffffff",
  borderRadius: 4,
  cursor: "pointer",
  fontSize: 13,
};
const h3Style: React.CSSProperties = {
  margin: "0 0 8px",
  fontSize: 11,
  letterSpacing: 1.2,
  textTransform: "uppercase",
  color: "#777",
};

interface ImportResult {
  imported: number;
  duplicates: number;
  total: number;
}

export default function SettingsView() {
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);

  async function syncWebsite() {
    setBusy(true);
    setMsg("Syncing…");
    try {
      const r = await fetch("/api/settings/import-homepage", { method: "POST" });
      const d = (await r.json()) as ImportResult;
      setMsg(
        r.ok
          ? `Website sync: ${d.imported} imported, ${d.duplicates} duplicates (of ${d.total} projects).`
          : `Sync failed: ${r.status}`
      );
    } catch (e) {
      setMsg(`Sync failed: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ maxWidth: 720 }}>
      <div style={{ marginBottom: 22 }}>
        <h3 style={h3Style}>Website</h3>
        <button style={btnStyle} disabled={busy} onClick={() => void syncWebsite()}>
          {busy ? "Syncing…" : "Sync website projects"}
        </button>
        {msg && <p style={{ fontSize: 13, color: "#444", marginTop: 8 }}>{msg}</p>}
      </div>

      <div>
        <h3 style={h3Style}>Parameters</h3>
        <p style={{ color: "#666", fontSize: 13 }}>
          Familiarity / Research Depth / Divergence / Counter Strength / Technical↔Photographic arrive in Phase 2.
        </p>
      </div>
    </div>
  );
}
