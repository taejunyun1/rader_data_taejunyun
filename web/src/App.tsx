import { useEffect, useState } from "react";
import { VIEWS, type View, type HealthResponse } from "@radar/shared";
import InboxView from "./views/InboxView";
import DistillView from "./views/DistillView";
import ReservoirView from "./views/ReservoirView";
import SettingsView from "./views/SettingsView";

export default function App() {
  const [view, setView] = useState<View>("RADAR");
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [ai, setAi] = useState<string>("checking...");

  useEffect(() => {
    fetch("/api/health")
      .then((r) => r.json() as Promise<HealthResponse>)
      .then(setHealth)
      .catch(() => setHealth(null));
    fetch("/api/debug/ai-check")
      .then(async (r) => {
        const d = await r.json();
        setAi(JSON.stringify(d).slice(0, 220));
      })
      .catch(() => setAi("failed: network"));
  }, []);

  return (
    <div style={{ fontFamily: "system-ui, sans-serif", margin: 0, color: "#1a1a1a" }}>
      <nav
        style={{
          display: "flex",
          gap: 16,
          padding: "12px 24px",
          borderBottom: "1px solid #e0e0e0",
        }}
      >
        {VIEWS.map((v) => (
          <button
            key={v}
            onClick={() => setView(v)}
            style={{
              background: v === view ? "#1a1a1a" : "transparent",
              color: v === view ? "#fff" : "#1a1a1a",
              border: "1px solid #1a1a1a",
              borderRadius: 4,
              padding: "4px 10px",
              cursor: "pointer",
              fontSize: 12,
              letterSpacing: 0.5,
            }}
          >
            {v}
          </button>
        ))}
      </nav>
      <main style={{ padding: 24 }}>
        <h2 style={{ fontSize: 14, letterSpacing: 1, textTransform: "uppercase" }}>{view}</h2>
        {view === "INBOX" ? (
          <InboxView />
        ) : view === "DISTILL" ? (
          <DistillView />
        ) : view === "RESERVOIR" ? (
          <ReservoirView />
        ) : view === "SETTINGS" ? (
          <SettingsView />
        ) : (
          <p style={{ color: "#666" }}>This view arrives in a later phase.</p>
        )}
        <p style={{ fontSize: 12, color: health ? "#2a7a2a" : "#b04040" }}>
          API: {health ? `connected (${health.service})` : "not reachable"}
        </p>
        <p style={{ fontSize: 12, color: "#555" }}>AI check: {ai}</p>
      </main>
    </div>
  );
}
