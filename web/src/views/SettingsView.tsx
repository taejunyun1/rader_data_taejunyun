import { useEffect, useState } from "react";
import { PRESETS, type PresetName, type RadarParams } from "@radar/shared";

const PARAM_FIELDS: { key: keyof RadarParams; label: string; left: string; right: string }[] = [
  { key: "familiarity", label: "Familiarity", left: "New territory", right: "Existing interests" },
  { key: "researchDepth", label: "Research Depth", left: "Light exploration", right: "Deep research" },
  { key: "divergence", label: "Divergence", left: "Coherent links", right: "Unexpected links" },
  { key: "counterStrength", label: "Counter Strength", left: "Mild counterpoint", right: "Strong counter-aesthetic" },
  { key: "technicalPhotographic", label: "Technical ↔ Photographic", left: "Systems & tech", right: "Image & matter" },
];

const btn: React.CSSProperties = {
  padding: "4px 12px",
  border: "1px solid #1a1a1a",
  background: "#fff",
  borderRadius: 4,
  cursor: "pointer",
  fontSize: 12,
};
const activeBtn: React.CSSProperties = { ...btn, background: "#1a1a1a", color: "#fff" };
const h3: React.CSSProperties = { margin: "0 0 8px", fontSize: 11, letterSpacing: 1.2, textTransform: "uppercase", color: "#777" };

const PRESET_LABELS: Record<PresetName, string> = {
  BALANCED: "Balanced",
  DEEP_RESEARCH: "Deep Research",
  ARTWORK_EXPLORATION: "Artwork Exploration",
  COUNTER_HEAVY: "Counter-heavy",
  TECHNICAL: "Technical",
};

export default function SettingsView() {
  const [params, setParams] = useState<RadarParams | null>(null);
  const [msg, setMsg] = useState("");
  const [syncMsg, setSyncMsg] = useState("");
  const [exportMsg, setExportMsg] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetch("/api/settings/params")
      .then((r) => r.json() as Promise<RadarParams>)
      .then(setParams)
      .catch(() => setParams(null));
  }, []);

  async function save(next: RadarParams) {
    setParams(next);
    setBusy(true);
    try {
      const r = await fetch("/api/settings/params", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(next),
      });
      setMsg(r.ok ? "Saved." : `Save failed: ${r.status}`);
    } catch (e) {
      setMsg(`Save failed: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  async function applyPreset(p: PresetName) {
    await save(PRESETS[p]);
    setMsg(`Preset applied: ${PRESET_LABELS[p]}`);
  }

  async function backupOriginals() {
    setBusy(true);
    setExportMsg("Copying originals to export bucket…");
    try {
      const r = await fetch("/api/export/originals-to-r2", { method: "POST" });
      const d = (await r.json()) as { copied?: number; total?: number; prefix?: string };
      setExportMsg(r.ok ? `Backed up ${d.copied}/${d.total} originals → ${d.prefix}` : `Backup failed: ${r.status}`);
    } catch (e) {
      setExportMsg(`Backup failed: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  async function buildIndex() {
    setBusy(true);
    setExportMsg("Building semantic index (embeddings)…");
    try {
      const r = await fetch("/api/search/embed-backfill?limit=25", { method: "POST" });
      const d = (await r.json()) as { embedded?: number; remaining?: number };
      setExportMsg(r.ok ? `Embedded ${d.embedded} sources. Remaining: ${d.remaining ?? 0}.` : `Failed: ${r.status}`);
    } catch (e) {
      setExportMsg(`Failed: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  async function retagTopics() {
    setBusy(true);
    setExportMsg("Re-tagging topics from analysis…");
    try {
      const r = await fetch("/api/reservoir/retag-all", { method: "POST" });
      const d = (await r.json()) as { retagged?: number };
      setExportMsg(r.ok ? `Re-tagged ${d.retagged ?? 0} sources.` : `Failed: ${r.status}`);
    } catch (e) {
      setExportMsg(`Failed: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  async function syncWebsite() {
    setBusy(true);
    setSyncMsg("Syncing…");
    try {
      const r = await fetch("/api/settings/import-homepage", { method: "POST" });
      const d = (await r.json()) as { imported: number; duplicates: number; total: number };
      setSyncMsg(
        r.ok
          ? `Website sync: ${d.imported} imported, ${d.duplicates} duplicates (of ${d.total} projects).`
          : `Sync failed: ${r.status}`
      );
    } catch (e) {
      setSyncMsg(`Sync failed: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ maxWidth: 640 }}>
      <div style={{ marginBottom: 26 }}>
        <h3 style={h3}>Parameters</h3>
        {params ? (
          <div>
            {PARAM_FIELDS.map((f) => (
              <div key={f.key} style={{ marginBottom: 16 }}>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, marginBottom: 2 }}>
                  <span>{f.label}</span>
                  <span style={{ color: "#777" }}>{params[f.key].toFixed(2)}</span>
                </div>
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.05}
                  value={params[f.key]}
                  disabled={busy}
                  style={{ width: "100%" }}
                  onChange={(e) => setParams({ ...params, [f.key]: parseFloat(e.target.value) })}
                  onMouseUp={() => void save(params)}
                  onTouchEnd={() => void save(params)}
                />
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, color: "#999" }}>
                  <span>{f.left}</span>
                  <span>{f.right}</span>
                </div>
              </div>
            ))}
            {msg && <p style={{ fontSize: 12, color: "#2a7a2a", margin: 0 }}>{msg}</p>}
          </div>
        ) : (
          <p style={{ color: "#666", fontSize: 13 }}>Loading…</p>
        )}
      </div>

      <div style={{ marginBottom: 26 }}>
        <h3 style={h3}>Presets</h3>
        {(Object.keys(PRESETS) as PresetName[]).map((p) => (
          <button key={p} style={{ ...btn, marginRight: 6, marginBottom: 6 }} disabled={busy} onClick={() => void applyPreset(p)}>
            {PRESET_LABELS[p]}
          </button>
        ))}
      </div>

      <div style={{ marginBottom: 26 }}>
        <h3 style={h3}>Export / Backup</h3>
        <div style={{ marginBottom: 8 }}>
          <a href="/api/export/json" style={{ ...btn, textDecoration: "none", display: "inline-block", marginRight: 6 }} download>
            JSON (full)
          </a>
          <a href="/api/export/markdown" style={{ ...btn, textDecoration: "none", display: "inline-block", marginRight: 6 }} download>
            Markdown
          </a>
          <a href="/api/export/csv" style={{ ...btn, textDecoration: "none", display: "inline-block" }} download>
            CSV (sources)
          </a>
        </div>
        <button style={btn} disabled={busy} onClick={() => void backupOriginals()}>
          Backup originals to R2
        </button>
        <button style={{ ...btn, marginLeft: 6 }} disabled={busy} onClick={() => void buildIndex()}>
          Build semantic index
        </button>
        <button style={{ ...btn, marginLeft: 6 }} disabled={busy} onClick={() => void retagTopics()}>
          Re-tag topics
        </button>
        {exportMsg && <p style={{ fontSize: 13, color: "#444", marginTop: 8 }}>{exportMsg}</p>}
      </div>

      <div>
        <h3 style={h3}>Website</h3>
        <button style={btn} disabled={busy} onClick={() => void syncWebsite()}>
          {busy ? "Working…" : "Sync website projects"}
        </button>
        {syncMsg && <p style={{ fontSize: 13, color: "#444", marginTop: 8 }}>{syncMsg}</p>}
      </div>
    </div>
  );
}
