import { Hono } from "hono";
import type { ResearchJobKind } from "@radar/shared/discovery";
import { enqueueResearchJob, type ResearchJobRequest } from "../jobs/enqueue";
import { dismissResearchJob, getResearchJob, listResearchJobs } from "../jobs/store";

const jobs = new Hono<{ Bindings: Env }>();

function requestedBy(c: { req: { header(name: string): string | undefined } }): string {
  return c.req.header("CF-Access-Authenticated-User-Email") ?? "local";
}

function isResearchJobRequest(value: unknown): value is ResearchJobRequest {
  if (!value || typeof value !== "object") return false;
  const candidate = value as { kind?: unknown; input?: unknown };
  return typeof candidate.kind === "string"
    && [
      "DISCOVERY_RUN",
      "DISTILL_RUN",
      "RADAR_SYNTHESIS",
      "DEEP_ANALYSIS",
      "SOURCE_ACQUISITION",
      "VISUAL_TRANSFORM",
      "VISUAL_ANALYSIS",
      "VISUAL_EXTRACTION",
    ].includes(candidate.kind)
    && candidate.input !== undefined;
}

jobs.get("/", async (c) => {
  const items = await listResearchJobs(c.env.DB, requestedBy(c), 30);
  const status = c.req.query("status");
  return c.json({ jobs: status === "active" ? items.filter((item) => item.status === "QUEUED" || item.status === "RUNNING") : items });
});

jobs.get("/:id", async (c) => {
  const item = await getResearchJob(c.env.DB, c.req.param("id"));
  if (!item || (item.requestedBy && item.requestedBy !== requestedBy(c))) return c.json({ error: "not_found" }, 404);
  return c.json({ job: item });
});

jobs.patch("/:id/dismiss", async (c) => {
  const ok = await dismissResearchJob(c.env.DB, c.req.param("id"), requestedBy(c));
  return ok ? c.json({ ok: true }) : c.json({ error: "not_found" }, 404);
});

jobs.post("/:id/retry", async (c) => {
  const old = await getResearchJob(c.env.DB, c.req.param("id"));
  if (!old || (old.requestedBy && old.requestedBy !== requestedBy(c))) return c.json({ error: "not_found" }, 404);
  if (old.status !== "FAILED" && old.status !== "BLOCKED") return c.json({ error: "job_not_retryable" }, 409);
  const request = { kind: old.kind, input: old.input };
  if (!isResearchJobRequest(request)) return c.json({ error: "job_kind_not_retryable" }, 400);
  try {
    const result = await enqueueResearchJob(c.env, request, requestedBy(c), old.id);
    return c.json(result, 202);
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message.slice(0, 200) : "workflow_create_failed" }, 500);
  }
});

export default jobs;
