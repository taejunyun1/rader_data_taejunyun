import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { dedupeKeyFor, enqueueResearchJob } from "../src/jobs/enqueue";

describe("research job dispatch dedupe", () => {
  it("returns one elected job for concurrent identical enqueues", async () => {
    const workflow = { create: async ({ id }: { id: string }) => ({ id: `wf:${id}` }) };
    const testEnv = { ...env, RESEARCH_JOBS_WORKFLOW: workflow } as unknown as Env;
    const request = { kind: "DISCOVERY_RUN" as const, input: { divergence: 0.5, profile: { original: { keywords: ["photography"], strength: 50 }, counter: { keywords: ["automation"], strength: 50 }, updatedAt: "2026-08-28T00:00:00.000Z" } } };
    const results = await Promise.all(Array.from({ length: 50 }, () => enqueueResearchJob(testEnv, request, "test@example.com")));
    const ids = new Set(results.map((result) => result.job.id));
    expect(ids.size).toBe(1);
    const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM research_jobs WHERE dedupe_key = ?").bind(dedupeKeyFor(request)).first<{ n: number }>();
    expect(row?.n).toBe(1);
  });
});
