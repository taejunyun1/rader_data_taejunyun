import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { computeStats } from "./snapshot";

describe("radar live snapshot stats", () => {
  it("does not count derived results whose source was permanently deleted", async () => {
    const beforeWindow = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
    const end = new Date(Date.now() + 60 * 1000).toISOString();
    const before = await computeStats(env.DB, beforeWindow, end);
    const now = new Date().toISOString();
    const activeSourceId = `radar-live-${crypto.randomUUID()}`;
    const activeSessionId = `radar-session-live-${crypto.randomUUID()}`;
    const deletedSessionId = `radar-session-deleted-${crypto.randomUUID()}`;
    const mixedSessionId = `radar-session-mixed-${crypto.randomUUID()}`;
    const deletedSourceId = `deleted-source-${crypto.randomUUID()}`;

    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO sources (id, kind, title, reliability, status, created_at, updated_at)
         VALUES (?, 'RADAR_TEST', '활성 자료', 'PRIMARY', 'indexed', ?, ?)`,
      ).bind(activeSourceId, now, now),
      env.DB.prepare(
        `INSERT INTO distill_sessions (id, sources_used_json, created_at)
         VALUES (?, ?, ?)`,
      ).bind(activeSessionId, JSON.stringify([{ id: activeSourceId, title: "활성 자료" }]), now),
      env.DB.prepare(
        `INSERT INTO distill_sessions (id, sources_used_json, created_at)
         VALUES (?, ?, ?)`,
      ).bind(deletedSessionId, JSON.stringify([{ id: deletedSourceId, title: "삭제된 가이드" }]), now),
      env.DB.prepare(
        `INSERT INTO distill_sessions (id, sources_used_json, created_at)
         VALUES (?, ?, ?)`,
      ).bind(mixedSessionId, JSON.stringify([
        { id: activeSourceId, title: "활성 자료" },
        { id: deletedSourceId, title: "삭제된 가이드" },
      ]), now),
      env.DB.prepare(
        `INSERT INTO reading_queue (id, distill_session_id, title, priority, created_at)
         VALUES (?, ?, '활성 다음 읽기', 'WORTH', ?)`,
      ).bind(`queue-live-${crypto.randomUUID()}`, activeSessionId, now),
      env.DB.prepare(
        `INSERT INTO reading_queue (id, distill_session_id, title, priority, created_at)
         VALUES (?, ?, '삭제된 가이드에서 나온 읽기', 'WORTH', ?)`,
      ).bind(`queue-deleted-${crypto.randomUUID()}`, deletedSessionId, now),
      env.DB.prepare(
        `INSERT INTO reading_queue (id, distill_session_id, title, priority, created_at)
         VALUES (?, ?, '혼합 세션에서 나온 읽기', 'WORTH', ?)`,
      ).bind(`queue-mixed-${crypto.randomUUID()}`, mixedSessionId, now),
      env.DB.prepare(
        `INSERT INTO research_gaps (id, distill_session_id, gap_text, created_at)
         VALUES (?, ?, '활성 공백', ?)`,
      ).bind(`gap-live-${crypto.randomUUID()}`, activeSessionId, now),
      env.DB.prepare(
        `INSERT INTO research_gaps (id, distill_session_id, gap_text, created_at)
         VALUES (?, ?, '삭제된 가이드에서 나온 공백', ?)`,
      ).bind(`gap-deleted-${crypto.randomUUID()}`, deletedSessionId, now),
      env.DB.prepare(
        `INSERT INTO research_gaps (id, distill_session_id, gap_text, created_at)
         VALUES (?, ?, '혼합 세션에서 나온 공백', ?)`,
      ).bind(`gap-mixed-${crypto.randomUUID()}`, mixedSessionId, now),
    ]);

    const after = await computeStats(env.DB, beforeWindow, end);

    expect(after.distillRuns - before.distillRuns).toBe(1);
    expect(after.readingQueueSize - before.readingQueueSize).toBe(1);
    expect(after.gapsRaised - before.gapsRaised).toBe(1);
    expect((after.kindBreakdown.RADAR_TEST ?? 0) - (before.kindBreakdown.RADAR_TEST ?? 0)).toBe(1);
  });
});
