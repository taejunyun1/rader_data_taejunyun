import { Hono } from "hono";
import type { HealthResponse } from "@radar/shared";
import inbox from "./routes/inbox";
import discoverRoute from "./routes/discover";
import distillRoute from "./routes/distill";
import exportRoute from "./routes/export";
import radarRoute from "./routes/radar";
import reservoir from "./routes/reservoir";
import search from "./routes/search";
import settings from "./routes/settings";
import signals from "./routes/signals";
import syncRoute from "./routes/sync";
import usageRoute from "./routes/usage";
import jobsRoute from "./routes/jobs";
import visualAssetsRoute from "./routes/visualAssets";
import { syncHomepageReading } from "./homepage/reading";
import { verifyAccessAssertion, extractAssertion, type AccessIdentity } from "./lib/access";

type AppEnv = { Bindings: Env; Variables: { identity?: AccessIdentity } };

const app = new Hono<AppEnv>();

app.use("/api/*", async (c, next) => {
  if (c.req.path === "/api/health") return next();

  const authHeader = c.req.header("Authorization");
  if (authHeader?.startsWith("Bearer ") && c.env.CLI_TOKEN) {
    const token = authHeader.slice(7);
    const [a, b] = await Promise.all([
      crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)),
      crypto.subtle.digest("SHA-256", new TextEncoder().encode(c.env.CLI_TOKEN)),
    ]);
    if (buffersEqual(new Uint8Array(a), new Uint8Array(b))) {
      c.set("identity", { sub: "cli", email: "cli@radar", name: "CLI" });
      return next();
    }
  }

  const teamDomain = c.env.ACCESS_TEAM_DOMAIN;
  if (!teamDomain || String(c.env.ENVIRONMENT) === "development") return next();

  const assertion = extractAssertion(c.req.raw);
  if (!assertion) return c.json({ error: "unauthorized" }, 401);
  try {
    const identity = await verifyAccessAssertion(assertion, teamDomain, c.env.ACCESS_AUD ?? "");
    c.set("identity", identity);
    return next();
  } catch (err) {
    console.warn(JSON.stringify({ level: "warn", scope: "access", reason: (err as Error).message }));
    return c.json({ error: "unauthorized" }, 401);
  }
});

app.get("/api/health", (c) => {
  const body: HealthResponse = {
    ok: true,
    service: "research-radar",
    time: new Date().toISOString(),
  };
  return c.json(body);
});

app.get("/api/me", (c) => {
  const identity = c.get("identity");
  if (!identity) return c.json({ authenticated: false });
  return c.json({ authenticated: true, email: identity.email, name: identity.name });
});

app.route("/api/inbox", inbox);
app.route("/api/discover", discoverRoute);
app.route("/api/distill", distillRoute);
app.route("/api/export", exportRoute);
app.route("/api/radar", radarRoute);
app.route("/api/reservoir", reservoir);
app.route("/api/search", search);
app.route("/api/settings", settings);
app.route("/api/signals", signals);
app.route("/api/sync", syncRoute);
app.route("/api/usage", usageRoute);
app.route("/api/jobs", jobsRoute);
app.route("/api/visual-assets", visualAssetsRoute);

app.get("/api/debug/ai-check", async (c) => {
  const { callOpenAi } = await import("./lib/openai");
  try {
    const r = await callOpenAi(c.env, {
      purpose: "debug",
      model: "low",
      messages: [{ role: "user", content: "Reply with the single word: ok" }],
      maxOutputTokens: 200,
    });
    return c.json({ ok: true, model: r.model, reply: r.text.trim(), costUsd: r.costUsd });
  } catch (err) {
    return c.json({ ok: false, error: (err as Error).message.slice(0, 300) }, 500);
  }
});

function buffersEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

app.notFound((c) => c.json({ error: "not_found" }, 404));

app.onError((err, c) => {
  console.error(JSON.stringify({ level: "error", message: err.message, stack: err.stack }));
  return c.json({ error: "internal_error" }, 500);
});

export default {
  fetch: app.fetch,
  async scheduled(event: ScheduledEvent, env: Env) {
    if (event.cron === "0 1 * * *") {
      try {
        const result = await syncHomepageReading(env);
        console.log(JSON.stringify({ level: "info", cron: event.cron, homepageReading: result }));
      } catch (err) {
        console.error(
          JSON.stringify({
            level: "error",
            scope: "cron:homepage-reading",
            message: (err as Error).message,
            stack: (err as Error).stack,
          })
        );
      }
      return;
    }

    const { createWeeklySnapshotWithSynthesis } = await import("./radar/snapshot");
    try {
      const id = await createWeeklySnapshotWithSynthesis(env);
      console.log(JSON.stringify({ level: "info", cron: event.cron, snapshot: id ?? "skipped" }));
    } catch (err) {
      console.error(JSON.stringify({ level: "error", scope: "cron:snapshot", message: (err as Error).message }));
    }
    try {
      const { runDiscovery } = await import("./discovery/run");
      const { loadParams } = await import("./lib/params");
      const params = await loadParams(env.DB);
      const result = await runDiscovery(env, params.divergence);
      console.log(JSON.stringify({
        level: "info",
        cron: event.cron,
        discovery: result.collected,
        fieldSignals: result.fieldSignalsCollected,
        queries: result.queries,
      }));
    } catch (err) {
      console.error(JSON.stringify({ level: "error", scope: "cron:discovery", message: (err as Error).message }));
    }
  },
};

export { ResearchJobWorkflow } from "./workflows/researchJob";
