import { Hono } from "hono";
import type { ResearchJobKind } from "@radar/shared/discovery";
import { enqueueResearchJob, type ResearchJobRequest } from "../jobs/enqueue";
import { dismissResearchJob, getResearchJob, listResearchJobs } from "../jobs/store";
import { jsonError, verifiedRequester } from "../lib/httpErrors";

const jobs = new Hono<{ Bindings: Env }>();

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
  const items = await listResearchJobs(c.env.DB, verifiedRequester(c), 30);
  const status = c.req.query("status");
  return c.json({ jobs: status === "active" ? items.filter((item) => item.status === "QUEUED" || item.status === "RUNNING") : items });
});

jobs.get("/:id", async (c) => {
  const item = await getResearchJob(c.env.DB, c.req.param("id"));
  if (!item || (item.requestedBy && item.requestedBy !== verifiedRequester(c))) return jsonError(c, 404, "not_found");
  return c.json({ job: item });
});

jobs.patch("/:id/dismiss", async (c) => {
  const ok = await dismissResearchJob(c.env.DB, c.req.param("id"), verifiedRequester(c));
  return ok ? c.json({ ok: true }) : jsonError(c, 404, "not_found");
});

jobs.post("/:id/retry", async (c) => {
  const old = await getResearchJob(c.env.DB, c.req.param("id"));
  if (!old || (old.requestedBy && old.requestedBy !== verifiedRequester(c))) return jsonError(c, 404, "not_found");
  if (old.status !== "FAILED" && old.status !== "BLOCKED") return jsonError(c, 409, "job_not_retryable");
  const request = { kind: old.kind, input: old.input };
  if (!isResearchJobRequest(request)) return jsonError(c, 400, "job_kind_not_retryable");
  try {
    const result = await enqueueResearchJob(c.env, request, verifiedRequester(c), old.id);
    return c.json(result, 202);
  } catch (error) {
    console.error(JSON.stringify({ level: "error", scope: "jobs:retry", requestId: c.req.header("X-Request-ID"), message: error instanceof Error ? error.message : String(error) }));
    return jsonError(c, 500, "workflow_create_failed");
  }
});

export default jobs;
