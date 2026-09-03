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
import visualExtractionRoute from "./routes/visualExtraction";
import homepagePublicationRoute from "./routes/homepagePublication";
import { verifyAccessAssertion, extractAssertion, type AccessIdentity } from "./lib/access";
import { HttpError, jsonError, requestId } from "./lib/httpErrors";
import { runScheduledCron } from "./operations/scheduled";
import { isSourceDeletionClaimError } from "./reservoir/deletionClaim";

type AppEnv = { Bindings: Env; Variables: { identity?: AccessIdentity } };

const app = new Hono<AppEnv>();

app.use("/api/*", async (c, next) => {
  requestId(c);
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

  if (String(c.env.ENVIRONMENT) === "development" || String(c.env.ENVIRONMENT) === "test") {
    const localEmail = c.req.header("CF-Access-Authenticated-User-Email") ?? "local";
    c.set("identity", { sub: "local-development", email: localEmail, name: "Local development" });
    return next();
  }
  const teamDomain = c.env.ACCESS_TEAM_DOMAIN;
  if (!teamDomain || !c.env.ACCESS_AUD) return jsonError(c, 503, "access_not_configured");

  const assertion = extractAssertion(c.req.raw);
  if (!assertion) return jsonError(c, 401, "unauthorized");
  try {
    const identity = await verifyAccessAssertion(assertion, teamDomain, c.env.ACCESS_AUD ?? "");
    c.set("identity", identity);
    return next();
  } catch (err) {
    console.warn(JSON.stringify({ level: "warn", scope: "access", reason: (err as Error).message }));
    return jsonError(c, 401, "unauthorized");
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
app.route("/api/visual-extraction", visualExtractionRoute);
app.route("/api/distill", homepagePublicationRoute);

function buffersEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

app.notFound((c) => c.json({ error: "not_found" }, 404));

app.onError((err, c) => {
  const id = c.req.header("X-Request-ID") ?? requestId(c);
  console.error(JSON.stringify({ level: "error", requestId: id, message: err.message, stack: err.stack }));
  if (isSourceDeletionClaimError(err)) return jsonError(c, 409, "source_delete_in_progress");
  if (err instanceof HttpError) return jsonError(c, err.status, err.code, err.details);
  return jsonError(c, 500, "internal_error");
});

export default {
  fetch: app.fetch,
  async scheduled(event: ScheduledEvent, env: Env) {
    const result = await runScheduledCron(env, event.cron);
    console.log(JSON.stringify({ level: "info", cron: event.cron, status: result.status, runId: result.run?.id ?? null }));
  },
};

export { ResearchJobWorkflow } from "./workflows/researchJob";
