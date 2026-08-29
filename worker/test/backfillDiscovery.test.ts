import { describe, expect, it, vi } from "vitest";
import {
  backfillDiscoverySources,
  selectDiscoveryBackfillSources,
} from "../src/ingestion/backfillDiscovery";

function mockDb(rows: Array<Record<string, unknown>>) {
  const statement = {
    bind: vi.fn(),
    all: vi.fn().mockResolvedValue({ results: rows }),
  };
  statement.bind.mockReturnValue(statement);
  return {
    db: { prepare: vi.fn().mockReturnValue(statement) },
    statement,
  };
}

describe("selectDiscoveryBackfillSources", () => {
  it("selects discovery and homepage reading sources without usable active text", () => {
    const ids = selectDiscoveryBackfillSources([
      { id: "metadata", origin: "discovery:arxiv", textScope: "METADATA_ONLY", charCount: 92 },
      { id: "partial", origin: "discovery:rss", textScope: "PARTIAL", charCount: 1_200 },
      { id: "short-fulltext", origin: "discovery:openalex", textScope: "FULLTEXT", charCount: 999 },
      { id: "ready", origin: "discovery:rss", textScope: "FULLTEXT", charCount: 2_400 },
      { id: "homepage-reading", origin: "homepage-reading", textScope: "METADATA_ONLY", charCount: 283 },
      { id: "manual", origin: "manual", textScope: "METADATA_ONLY", charCount: 40 },
    ]);

    expect(ids).toEqual(["metadata", "partial", "short-fulltext", "homepage-reading"]);
  });
});

describe("backfillDiscoverySources", () => {
  it("caps selection at 10 and enqueues canonical acquisition URLs", async () => {
    const rows = Array.from({ length: 12 }, (_, index) => ({
      id: `source-${index + 1}`,
      origin: "discovery:rss",
      textScope: "METADATA_ONLY",
      charCount: 50,
      canonicalUrl: `https://example.com/article/${index + 1}?utm_source=radar`,
    }));
    const { db, statement } = mockDb(rows);
    const enqueue = vi.fn().mockResolvedValue({ job: { id: "job" }, reused: false });

    const result = await backfillDiscoverySources(
      { DB: db } as never,
      "operator@example.com",
      99,
      enqueue as never,
    );

    expect(statement.bind).toHaveBeenCalledWith(10);
    expect(enqueue).toHaveBeenCalledTimes(10);
    expect(enqueue).toHaveBeenNthCalledWith(
      1,
      { DB: db },
      {
        kind: "SOURCE_ACQUISITION",
        input: { sourceId: "source-1", url: "https://example.com/article/1" },
      },
      "operator@example.com",
    );
    expect(result).toEqual({ selected: 10, enqueued: 10, skipped: 0, errors: 0 });
  });

  it("skips invalid or active duplicate jobs and counts enqueue errors", async () => {
    const { db } = mockDb([
      { id: "new", origin: "discovery:rss", textScope: "METADATA_ONLY", charCount: 50, canonicalUrl: "https://example.com/new" },
      { id: "missing-url", origin: "discovery:rss", textScope: "EMPTY", charCount: 0, canonicalUrl: null },
      { id: "duplicate", origin: "discovery:arxiv", textScope: "PARTIAL", charCount: 500, canonicalUrl: "https://example.com/duplicate" },
      { id: "failed", origin: "discovery:openalex", textScope: "UNKNOWN", charCount: 0, canonicalUrl: "https://example.com/failed" },
      { id: "manual", origin: "manual", textScope: "EMPTY", charCount: 0, canonicalUrl: "https://example.com/manual" },
    ]);
    const enqueue = vi.fn()
      .mockResolvedValueOnce({ job: { id: "new-job" }, reused: false })
      .mockResolvedValueOnce({ job: { id: "existing-job" }, reused: true })
      .mockRejectedValueOnce(new Error("workflow unavailable"));

    const result = await backfillDiscoverySources(
      { DB: db } as never,
      "operator@example.com",
      10,
      enqueue as never,
    );

    expect(db.prepare).toHaveBeenCalledTimes(1);
    expect(db.prepare).toHaveBeenCalledWith(expect.stringMatching(/origin = 'homepage-reading'/));
    expect(enqueue).toHaveBeenCalledTimes(3);
    expect(enqueue).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ input: expect.objectContaining({ sourceId: "manual" }) }),
      expect.anything(),
    );
    expect(result).toEqual({ selected: 4, enqueued: 1, skipped: 2, errors: 1 });
  });
});
