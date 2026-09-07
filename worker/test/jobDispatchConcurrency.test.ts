import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { dedupeKeyFor, enqueueResearchJob } from "../src/jobs/enqueue";
import { acquireSourceDeletionClaim } from "../src/reservoir/deletionClaim";

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

  it("rejects a source-owned enqueue while its deletion claim is active", async () => {
    const sourceId = `enqueue-claim-${crypto.randomUUID()}`;
    const now = new Date().toISOString();
    await env.DB.prepare(
      `INSERT INTO sources (id, kind, title, reliability, provenance_class, status, created_at, updated_at)
       VALUES (?, 'WEB', ?, 'DISCOVERY', 'SOURCE', 'received', ?, ?)`,
    ).bind(sourceId, `enqueue claim fixture ${sourceId}`, now, now).run();
    await acquireSourceDeletionClaim(env.DB, sourceId, new Date(now));

    const workflow = { create: async ({ id }: { id: string }) => ({ id: `wf:${id}` }) };
    const testEnv = { ...env, RESEARCH_JOBS_WORKFLOW: workflow } as unknown as Env;
    const request = { kind: "DEEP_ANALYSIS" as const, input: { sourceId, profile: "precision" as const } };

    await expect(enqueueResearchJob(testEnv, request, "test@example.com")).rejects.toMatchObject({
      name: "SourceDeletionClaimError",
      code: "source_delete_in_progress",
    });
    const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM research_jobs WHERE dedupe_key = ?")
      .bind(dedupeKeyFor(request)).first<{ n: number }>();
    expect(row?.n).toBe(0);
  });
});

describe("recursive job input identity", () => {
  const profile = { original: { keywords: ["light", "image"], strength: 50 }, counter: { keywords: ["machine"], strength: 40 }, updatedAt: "2026-09-07" };
  const key = (value: typeof profile) => dedupeKeyFor({ kind: "DISCOVERY_RUN", input: { divergence: 0.5, profile: value } });
  it("preserves nested values", () => {
    expect(key(profile)).not.toBe(key({ ...profile, original: { ...profile.original, strength: 51 } }));
  });
  it("ignores object insertion order at every level", () => {
    expect(key(profile)).toBe(key({ updatedAt: profile.updatedAt, counter: { strength: 40, keywords: ["machine"] }, original: { strength: 50, keywords: ["light", "image"] } }));
  });
  it("preserves array order", () => {
    expect(key(profile)).not.toBe(key({ ...profile, original: { ...profile.original, keywords: ["image", "light"] } }));
  });
});

it("strips client execution snapshots before dedupe and job persistence", async () => {
  const request = { kind: "DISTILL_RUN" as const, input: { includeCounter: true, _execution: { sourceVersionId: "untrusted-version" } } };
  const expectedKey = dedupeKeyFor({ kind: "DISTILL_RUN", input: { includeCounter: true } });
  expect(dedupeKeyFor(request)).toBe(expectedKey);
  const result = await enqueueResearchJob({ ...env, RESEARCH_JOBS_WORKFLOW: { create: async ({ id }: { id: string }) => ({ id }) } } as unknown as Env, request, "test");
  const persisted = await env.DB.prepare("SELECT input_json FROM research_jobs WHERE id = ?").bind(result.job.id).first<{ input_json: string }>();
  expect(JSON.parse(persisted!.input_json)).toEqual({ includeCounter: true });
});
