import { Hono } from "hono";
import type { HealthResponse } from "@radar/shared";
import inbox from "./routes/inbox";
import { verifyAccessAssertion, extractAssertion, type AccessIdentity } from "./lib/access";

type AppEnv = { Bindings: Env; Variables: { identity?: AccessIdentity } };

const app = new Hono<AppEnv>();

app.use("/api/*", async (c, next) => {
  if (c.req.path === "/api/health") return next();

  const teamDomain = c.env.ACCESS_TEAM_DOMAIN;
  if (!teamDomain || c.env.ENVIRONMENT === "development") return next();

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

app.notFound((c) => c.json({ error: "not_found" }, 404));

app.onError((err, c) => {
  console.error(JSON.stringify({ level: "error", message: err.message, stack: err.stack }));
  return c.json({ error: "internal_error" }, 500);
});

export default {
  fetch: app.fetch,
  scheduled(event: ScheduledEvent, _env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(
      Promise.resolve().then(() => {
        console.log(JSON.stringify({ level: "info", cron: event.cron, scheduledTime: event.scheduledTime }));
      })
    );
  },
};
