import { useEffect, useState } from "react";
import { VIEWS, type View, type HealthResponse } from "@radar/shared";
import InboxView from "./views/InboxView";
import DiscoverView from "./views/DiscoverView";
import DistillView from "./views/DistillView";
import RadarView from "./views/RadarView";
import ReservoirView from "./views/ReservoirView";
import SettingsView from "./views/SettingsView";
import UsageView from "./views/UsageView";
import { useTasks } from "./lib/tasks";

interface UsageBadge {
  usedUsd: number;
  budgetUsd: number;
  usedPct: number;
  blocked: boolean;
}

export default function App() {
  const [view, setView] = useState<View>("RADAR");
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [ai, setAi] = useState<string>("checking...");
  const [usage, setUsage] = useState<UsageBadge | null>(null);
  const tasks = useTasks();

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
    fetch("/api/usage/summary")
      .then((r) => r.json() as Promise<UsageBadge>)
      .then(setUsage)
      .catch(() => setUsage(null));
  }, []);

  const usageColor = usage
    ? usage.usedPct >= 100
      ? "#b04040"
      : usage.usedPct >= 80
        ? "#b08020"
        : "#777"
    : "#777";

  return (
    <div style={{ fontFamily: "system-ui, sans-serif", margin: 0, color: "#1a1a1a" }}>
      <nav
        style={{
          display: "flex",
          alignItems: "center",
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
        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 10 }}>
          {tasks.length > 0 && (
            <div style={{ display: "flex", gap: 10, fontSize: 11, maxWidth: 340, overflow: "hidden" }}>
              {tasks.slice(-3).map((t) => (
                <span
                  key={t.id}
                  title={`${t.label}${t.message ? ` — ${t.message}` : ""}`}
                  style={{
                    color: t.status === "failed" ? "#b04040" : t.status === "running" ? "#4a6fa5" : "#2a7a2a",
                    whiteSpace: "nowrap",
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 5,
                  }}
                >
                  {t.status === "running" ? (
                    <>
                      <span style={{ display: "inline-flex", gap: 3 }}>
                        {[0, 1, 2, 3, 4].map((i) => {
                          const filled = ((t.progress ?? 0) / 100) * 5 > i;
                          return (
                            <span
                              key={i}
                              style={{
                                width: 4,
                                height: 4,
                                borderRadius: "50%",
                                background: filled ? "#4a6fa5" : "#d5d5d5",
                                display: "inline-block",
                              }}
                            />
                          );
                        })}
                      </span>
                      {t.label}
                      <span style={{ color: "#999", fontSize: 10 }}>{t.progress ?? 0}%</span>
                    </>
                  ) : (
                    <>
                      {t.status === "done" ? "✓" : "✗"} {t.label}
                    </>
                  )}
                </span>
              ))}
            </div>
          )}
          {usage && (
            <button
              onClick={() => setView("USAGE")}
              title="Monthly AI budget — click for details"
              style={{
                background: "transparent",
                color: usageColor,
                border: `1px solid ${usageColor}`,
                borderRadius: 4,
                padding: "3px 10px",
                cursor: "pointer",
                fontSize: 11,
              }}
            >
              ${usage.usedUsd.toFixed(2)} / ${usage.budgetUsd} · {usage.usedPct.toFixed(0)}%
              {usage.blocked ? " ⛔ blocked" : ""}
            </button>
          )}
        </div>
      </nav>
      <main style={{ padding: 24 }}>
        <h2 style={{ fontSize: 14, letterSpacing: 1, textTransform: "uppercase" }}>{view}</h2>
        {view === "RADAR" ? (
          <RadarView />
        ) : view === "INBOX" ? (
          <InboxView />
        ) : view === "DISTILL" ? (
          <DistillView />
        ) : view === "RESERVOIR" ? (
          <ReservoirView />
        ) : view === "DISCOVER" ? (
          <DiscoverView />
        ) : view === "USAGE" ? (
          <UsageView />
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
