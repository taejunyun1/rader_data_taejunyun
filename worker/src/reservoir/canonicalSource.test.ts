import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { selectCanonicalSourceId } from "./canonicalSource";

async function insertCandidate(input: {
  id: string;
  createdAt: string;
  signalCount?: number;
  threadCount?: number;
  readyFullText?: boolean;
  textLength?: number;
}): Promise<void> {
  const versionId = `${input.id}-v1`;
  await env.DB.prepare(
    `INSERT INTO sources
     (id, kind, title, reliability, status, quality_status, active_version_id, created_at, updated_at)
     VALUES (?, 'WEB', ?, 'PRIMARY', 'stored', ?, ?, ?, ?)`,
  ).bind(
    input.id,
    input.id,
    input.readyFullText ? "READY" : "REVIEW",
    versionId,
    input.createdAt,
    input.createdAt,
  ).run();
  await env.DB.prepare(
    `INSERT INTO source_versions
     (id, source_id, version, normalized_text, char_count, normalization_status,
      version_origin, review_status, text_scope, extraction_method, created_at)
     VALUES (?, ?, 1, ?, ?, 'READY', 'INITIAL_INGEST', 'ACTIVE', ?, 'MANUAL_TEXT', ?)`,
  ).bind(
    versionId,
    input.id,
    "x".repeat(input.textLength ?? 0),
    input.textLength ?? 0,
    input.readyFullText ? "FULLTEXT" : "PARTIAL",
    input.createdAt,
  ).run();
  for (let index = 0; index < (input.signalCount ?? 0); index += 1) {
    await env.DB.prepare(
      "INSERT INTO user_signals (id, source_id, action, created_at) VALUES (?, ?, 'keep', ?)",
    ).bind(`${input.id}-signal-${index}`, input.id, input.createdAt).run();
  }
  for (let index = 0; index < (input.threadCount ?? 0); index += 1) {
    const threadId = `${input.id}-thread-${index}`;
    await env.DB.prepare(
      "INSERT INTO threads (id, title, status, created_at) VALUES (?, ?, 'SEED', ?)",
    ).bind(threadId, threadId, input.createdAt).run();
    await env.DB.prepare(
      "INSERT INTO thread_links (thread_id, source_id, created_at) VALUES (?, ?, ?)",
    ).bind(threadId, input.id, input.createdAt).run();
  }
}

describe("selectCanonicalSourceId", () => {
  it("orders by user/thread evidence, ready full text, text length, age, and id", async () => {
    const prefix = crypto.randomUUID();
    const ids = {
      weak: `${prefix}-weak`,
      evidence: `${prefix}-evidence`,
      ready: `${prefix}-ready`,
      longer: `${prefix}-longer`,
    };
    await insertCandidate({ id: ids.weak, createdAt: "2026-08-01T00:00:00.000Z", textLength: 200 });
    await insertCandidate({ id: ids.ready, createdAt: "2026-08-02T00:00:00.000Z", readyFullText: true, textLength: 2_000 });
    await insertCandidate({ id: ids.longer, createdAt: "2026-08-03T00:00:00.000Z", readyFullText: true, textLength: 3_000 });
    await insertCandidate({ id: ids.evidence, createdAt: "2026-08-04T00:00:00.000Z", signalCount: 1, textLength: 50 });

    await expect(selectCanonicalSourceId(env.DB, Object.values(ids))).resolves.toBe(ids.evidence);
    await expect(selectCanonicalSourceId(env.DB, [ids.ready, ids.longer])).resolves.toBe(ids.longer);
    await expect(selectCanonicalSourceId(env.DB, [ids.weak])).resolves.toBe(ids.weak);
  });

  it("rejects an empty or missing candidate set", async () => {
    await expect(selectCanonicalSourceId(env.DB, [])).rejects.toThrow("canonical_source_not_found");
    await expect(selectCanonicalSourceId(env.DB, [`missing-${crypto.randomUUID()}`]))
      .rejects.toThrow("canonical_source_not_found");
  });
});
