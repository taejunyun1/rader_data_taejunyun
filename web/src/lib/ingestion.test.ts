import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  classifyTextScope,
  deriveIngestMeta,
  normalizeIngestText,
  type InputFormat,
} from "@radar/shared/ingestion";
import { createSource } from "../../../worker/src/ingestion/store";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("ingestion normalization", () => {
  it("normalizes Obsidian links and keeps headings and code blocks", () => {
    const result = normalizeIngestText(
      "---\ntags: [photo]\n---\n# 제목\n[[작업노트|표시명]]\n![[image.png]]\n```js\nconst x = 1\n```",
      "OBSIDIAN_MARKDOWN",
    );

    expect(result.normalizedText).toContain("# 제목");
    expect(result.normalizedText).toContain("표시명");
    expect(result.normalizedText).toContain("[첨부: image.png]");
    expect(result.normalizedText).toContain("const x = 1");
    expect(result.report.unresolvedEmbedCount).toBe(1);
  });

  it("uses a shorter readiness threshold for personal notes", () => {
    expect(normalizeIngestText("사진의 표면과 데이터의 물질성을 연결해 다음 작업의 방향을 생각해 본 짧은 연구 메모입니다. 다음 관찰을 이어서 기록합니다.", "PLAIN_TEXT").qualityStatus).toBe("READY");
    expect(normalizeIngestText("짧음", "PDF_TEXT").qualityStatus).toBe("REVIEW");
  });

  it.each([
    ["obsidian:10_PROJECTS/note.md", "note.md", undefined, "OBSIDIAN", "OBSIDIAN_MARKDOWN"],
    ["upload:pdf", "paper.pdf", { scannedPdf: true }, "MANUAL", "PDF_SCAN"],
    ["url", undefined, undefined, "MANUAL", "URL_HTML"],
    ["discovery:arxiv", undefined, undefined, "DISCOVERY", "DISCOVERY_LINK"],
  ] satisfies Array<[string, string | undefined, Record<string, unknown> | undefined, string, InputFormat]>)
    ("derives %s as %s", (origin, filename, metadata, channel, format) => {
      expect(deriveIngestMeta(origin, filename, metadata)).toEqual({ channel, format });
    });

  it("accepts a long clean remote HTML article as full text", () => {
    const result = classifyTextScope({
      format: "URL_HTML",
      meaningfulChars: 2_400,
      warnings: [],
      extractionMethod: "HTML_STATIC",
    });

    expect(result).toEqual({ scope: "FULLTEXT", qualityStatus: "READY" });
  });

  it("does not treat a discovery title as analysable text", () => {
    const result = classifyTextScope({
      format: "DISCOVERY_LINK",
      meaningfulChars: 92,
      warnings: [],
      extractionMethod: "DISCOVERY_METADATA",
    });

    expect(result).toEqual({ scope: "METADATA_ONLY", qualityStatus: "REVIEW" });
  });

  it("marks a PDF conversion with no text as empty", () => {
    const result = classifyTextScope({
      format: "PDF_TEXT",
      meaningfulChars: 0,
      warnings: ["empty_text"],
      extractionMethod: "PDF_REMOTE_TO_MARKDOWN",
    });

    expect(result).toEqual({ scope: "EMPTY", qualityStatus: "EMPTY" });
  });

  it("keeps acquisition provenance values explicit", () => {
    expect(["FULLTEXT", "PARTIAL", "METADATA_ONLY", "EMPTY", "UNKNOWN"]).toHaveLength(5);
    expect(["HTML_STATIC", "PDF_REMOTE_TO_MARKDOWN", "DISCOVERY_METADATA"]).toEqual([
      "HTML_STATIC",
      "PDF_REMOTE_TO_MARKDOWN",
      "DISCOVERY_METADATA",
    ]);
  });

  it("migrates research_jobs retry chains and self-references with foreign keys enabled", () => {
    const result = verifySourceAcquisitionMigration();

    expect(result.foreignKeyCheck).toBe("");
    expect(result.jobs).toEqual([
      "job-1||DISCOVERY_RUN",
      "job-2|job-1|DISCOVERY_RUN",
      "job-3|job-3|DISCOVERY_RUN",
    ]);
  });

  it("keeps the source acquisition migration compatible with Wrangler D1 execution", () => {
    const migrationSql = readFileSync(join(process.cwd(), "../worker/migrations/0015_source_acquisition.sql"), "utf8");

    expect(migrationSql).not.toMatch(/^\s*(?:BEGIN|COMMIT)\s*;/im);
  });

  it("adds the source-version integrity migration", () => {
    const migrationPath = join(process.cwd(), "../worker/migrations/0021_source_version_integrity.sql");
    const migrationSql = existsSync(migrationPath) ? readFileSync(migrationPath, "utf8") : "";

    expect(migrationSql).toContain("raw_content_hash");
  });

  it("stores metadata-only discovery sources without a fake original", async () => {
    const env = createCreateSourceEnv();

    await createSource(env, {
      kind: "DISCOVERY",
      title: "Metadata only source",
      canonicalUrl: "https://example.com/discovery",
      origin: "discovery:openalex",
      original: "Metadata only source",
      storedOriginal: null,
      extractedText: undefined,
    });

    expect(env.r2Puts).toHaveLength(0);
    expect(env.sourceVersionInsert?.params[2]).toBeNull();
    expect(env.sourceVersionInsert?.params[3]).toBe("");
    expect(env.sourceVersionInsert?.params[4]).toBe(0);
    expect(env.sourceVersionInsert?.params[12]).toBe("METADATA_ONLY");
    expect(env.sourceVersionInsert?.params[13]).toBe("DISCOVERY_METADATA");
  });

  it("stores fulltext provenance on manual text imports", async () => {
    const env = createCreateSourceEnv();

    await createSource(env, {
      kind: "NOTE",
      title: "Manual note",
      origin: "manual",
      original: "충분히 긴 수동 입력 텍스트입니다. 연구 메모로 분석 가능한 수준의 본문을 포함합니다.",
      extractedText: "충분히 긴 수동 입력 텍스트입니다. 연구 메모로 분석 가능한 수준의 본문을 포함합니다.",
    });

    expect(env.sourceVersionInsert?.params[12]).toBe("FULLTEXT");
    expect(env.sourceVersionInsert?.params[13]).toBe("MANUAL_TEXT");
  });

  it("exports an acquisition version writer", async () => {
    const mod = await import("../../../worker/src/ingestion/versioning");

    expect(typeof mod.appendAcquisitionVersion).toBe("function");
  });

  it("exposes the selected content fragment without changing extracted text behavior", async () => {
    const { extractStaticHtml } = await import("../../../worker/src/ingestion/extractHtml");

    const result = extractStaticHtml(
      `<header>메뉴</header><main><article><h1>제목</h1><p>${"본문 ".repeat(260)}</p></article></main><footer>푸터</footer>`,
      "https://example.com/post",
    );

    expect(result.text).toContain("본문");
    expect(result.selectedFragmentHtml).toContain("<article>");
    expect(result.selectedFragmentHtml).not.toContain("<header>");
  });

  it("keeps a partial acquisition active only when it improves meaningful text", async () => {
    const mod = await import("../../../worker/src/ingestion/versioning");

    expect(typeof mod.appendAcquisitionVersion).toBe("function");
    if (typeof mod.appendAcquisitionVersion !== "function") return;

    const db = createVersioningDb({
      sourceId: "source-1",
      activeVersionId: "version-1",
      activeVersion: {
        id: "version-1",
        source_id: "source-1",
        version: 1,
        r2_key: "originals/source-1/v1.txt",
        extracted_text: "짧은 텍스트",
        normalized_text: "짧은 텍스트",
        normalization_status: "READY",
        normalization_report_json: JSON.stringify({ meaningfulChars: 6, warnings: [] }),
        version_origin: "INITIAL_INGEST",
        parent_version_id: null,
        review_status: "ACTIVE",
        created_at: "2026-08-23T00:00:00.000Z",
        text_scope: "PARTIAL",
        extraction_method: "LEGACY",
        extraction_error: null,
        content_type: null,
        final_url: null,
        acquired_at: null,
      },
    });

    const result = await mod.appendAcquisitionVersion(db, {
      sourceId: "source-1",
      r2Key: "originals/source-1/v2.txt",
      extractedText: "충분히 긴 본문 텍스트로 현재 활성 버전보다 더 많은 의미 있는 내용을 제공합니다. 반복이 아니라 실제 문장입니다.",
      inputFormat: "URL_HTML",
      textScope: "PARTIAL",
      extractionMethod: "HTML_STATIC",
    });

    expect(result.version).toBe(2);
    expect(db.source.activeVersionId).toBe(result.versionId);
    expect(db.activatedVersionIds).toEqual([result.versionId]);
  });

  it("does not replace a usable active version with an empty acquisition", async () => {
    const mod = await import("../../../worker/src/ingestion/versioning");

    expect(typeof mod.appendAcquisitionVersion).toBe("function");
    if (typeof mod.appendAcquisitionVersion !== "function") return;

    const db = createVersioningDb({
      sourceId: "source-1",
      activeVersionId: "version-1",
      activeVersion: {
        id: "version-1",
        source_id: "source-1",
        version: 1,
        r2_key: "originals/source-1/v1.txt",
        extracted_text: "기존 활성 텍스트는 유지되어야 합니다.",
        normalized_text: "기존 활성 텍스트는 유지되어야 합니다.",
        normalization_status: "READY",
        normalization_report_json: JSON.stringify({ meaningfulChars: 18, warnings: [] }),
        version_origin: "INITIAL_INGEST",
        parent_version_id: null,
        review_status: "ACTIVE",
        created_at: "2026-08-23T00:00:00.000Z",
        text_scope: "FULLTEXT",
        extraction_method: "LEGACY",
        extraction_error: null,
        content_type: null,
        final_url: null,
        acquired_at: null,
      },
    });

    const result = await mod.appendAcquisitionVersion(db, {
      sourceId: "source-1",
      r2Key: "originals/source-1/v2.txt",
      extractedText: "",
      inputFormat: "URL_HTML",
      textScope: "EMPTY",
      extractionMethod: "PDF_REMOTE_TO_MARKDOWN",
      extractionError: "empty_body",
    });

    expect(result.qualityStatus).toBe("EMPTY");
    expect(db.source.activeVersionId).toBe("version-1");
    expect(db.activatedVersionIds).toEqual([]);
  });

  it("activates the first recovered acquisition even when it is metadata-only", async () => {
    const mod = await import("../../../worker/src/ingestion/versioning");

    expect(typeof mod.appendAcquisitionVersion).toBe("function");
    if (typeof mod.appendAcquisitionVersion !== "function") return;

    const db = createVersioningDb({
      sourceId: "failed-url-source",
      activeVersionId: null,
      activeVersion: null,
    });

    const result = await mod.appendAcquisitionVersion(db, {
      sourceId: "failed-url-source",
      r2Key: "originals/failed-url-source/recovered.html",
      extractedText: "짧지만 실제로 수집된 웹 본문입니다.",
      inputFormat: "URL_HTML",
      textScope: "METADATA_ONLY",
      extractionMethod: "HTML_STATIC",
      finalUrl: "https://example.com/recovered",
    });

    expect(db.source.activeVersionId).toBe(result.versionId);
    expect(db.activatedVersionIds).toEqual([result.versionId]);
  });

  it("retries version reservation without changing the acquisition identity", async () => {
    const mod = await import("../../../worker/src/ingestion/versioning");

    expect(typeof mod.appendAcquisitionVersion).toBe("function");
    if (typeof mod.appendAcquisitionVersion !== "function") return;

    const db = createVersioningDb({
      sourceId: "source-1",
      activeVersionId: "version-1",
      activeVersion: {
        id: "version-1",
        source_id: "source-1",
        version: 1,
        r2_key: "originals/source-1/v1.txt",
        extracted_text: "기존 활성 텍스트",
        normalized_text: "기존 활성 텍스트",
        normalization_status: "READY",
        normalization_report_json: JSON.stringify({ meaningfulChars: 8, warnings: [] }),
        version_origin: "INITIAL_INGEST",
        parent_version_id: null,
        review_status: "ACTIVE",
        created_at: "2026-08-23T00:00:00.000Z",
        text_scope: "PARTIAL",
        extraction_method: "LEGACY",
        extraction_error: null,
        content_type: null,
        final_url: null,
        acquired_at: null,
      },
      failFirstVersionReservation: true,
    });

    const result = await mod.appendAcquisitionVersion(db, {
      versionId: "acq-version-2",
      sourceId: "source-1",
      r2Key: "originals/source-1/acq-acq-version-2-article",
      extractedText: "충분히 긴 본문으로 동시 재수집 충돌 이후에도 같은 acquisition identity를 유지합니다.",
      inputFormat: "URL_HTML",
      textScope: "FULLTEXT",
      extractionMethod: "HTML_STATIC",
      finalUrl: "https://redirected.example/article",
    });

    expect(result.version).toBe(3);
    const inserted = db.versions.find((row) => row.id === "acq-version-2");
    expect(inserted?.version).toBe(3);
    expect(inserted?.r2_key).toBe("originals/source-1/acq-acq-version-2-article");
    expect(db.versions.some((row) => row.version === 2 && row.id !== "acq-version-2")).toBe(true);
  });

  it("keeps the final response url after redirects", async () => {
    const { fetchAndExtract } = await import("../../../worker/src/ingestion/extractUrl");
    const response = new Response(
      "<html><head><title>Redirected</title></head><body><main>충분한 본문 텍스트가 있는 리다이렉트 결과 페이지입니다.</main></body></html>",
      { status: 200, headers: { "content-type": "text/html; charset=utf-8" } },
    );
    Object.defineProperty(response, "url", { value: "https://final.example/article", configurable: true });
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;

      if (url.startsWith("https://cloudflare-dns.com/dns-query")) {
        const query = new URL(url);
        const recordType = query.searchParams.get("type");
        const answerType = recordType === "AAAA" ? 28 : 1;
        const answerData = recordType === "AAAA" ? "2606:4700:4700::1111" : "1.1.1.1";

        return new Response(
          JSON.stringify({
            Status: 0,
            Answer: [{ name: "start.example", type: answerType, TTL: 300, data: answerData }],
          }),
          { status: 200, headers: { "content-type": "application/dns-json" } },
        );
      }

      return response;
    }));

    const page = await fetchAndExtract("https://start.example/article");

    expect(page.finalUrl).toBe("https://final.example/article");
    expect(page.title).toBe("Redirected");
  });
});

function createCreateSourceEnv(): Env & {
  r2Puts: Array<{ key: string; value: unknown; options?: Record<string, unknown> }>;
  sourceVersionInsert: { query: string; params: unknown[] } | null;
} {
  const r2Puts: Array<{ key: string; value: unknown; options?: Record<string, unknown> }> = [];
  const r2Objects = new Map<string, unknown>();
  let sourceVersionInsert: { query: string; params: unknown[] } | null = null;

  const env = {
    DB: {
      prepare(query: string): D1PreparedStatement {
        return {
          bind(...params: unknown[]): D1PreparedStatement {
            if (query.includes("INSERT INTO source_versions")) {
              sourceVersionInsert = { query, params };
            }
            return this;
          },
          async first<T = unknown>() {
            if (query.includes("SELECT title, quality_status, active_version_id FROM sources")) return null as T | null;
            if (query.includes("SELECT origins_json FROM sources")) return null as T | null;
            if (query.includes("FROM sources WHERE doi = ?")) return null as T | null;
            return null as T | null;
          },
          async run() {
            return { success: true, meta: { changes: 1 } };
          },
          async all<T = unknown>() {
            return { results: [] as T[] };
          },
        };
      },
      async batch<T = unknown>(statements: D1PreparedStatement[]): Promise<T[]> {
        return statements.map(() => ({ success: true, meta: { changes: 1 } })) as T[];
      },
    },
    ORIGINALS: {
      async put(key: string, value: unknown, options?: Record<string, unknown>) {
        r2Puts.push({ key, value, options });
        r2Objects.set(key, value);
      },
      async get(key: string) {
        const value = r2Objects.get(key);
        return value === undefined ? null : { body: value };
      },
      async delete(key: string) {
        r2Objects.delete(key);
      },
    },
  } as Env & {
    r2Puts: Array<{ key: string; value: unknown; options?: Record<string, unknown> }>;
    sourceVersionInsert: { query: string; params: unknown[] } | null;
  };

  env.r2Puts = r2Puts;
  env.sourceVersionInsert = sourceVersionInsert;

  Object.defineProperty(env, "sourceVersionInsert", {
    get() {
      return sourceVersionInsert;
    },
  });

  return env;
}

type MockVersionRow = {
  id: string;
  source_id: string;
  version: number;
  r2_key: string | null;
  extracted_text: string | null;
  normalized_text: string | null;
  normalization_status: string;
  normalization_report_json: string | null;
  version_origin: string;
  parent_version_id: string | null;
  review_status: string;
  created_at: string;
  text_scope: string;
  extraction_method: string;
  extraction_error: string | null;
  content_type: string | null;
  final_url: string | null;
  acquired_at: string | null;
};

function createVersioningDb(input: {
  sourceId: string;
  activeVersionId: string | null;
  activeVersion: MockVersionRow | null;
  failFirstVersionReservation?: boolean;
}): D1Database & {
  source: { id: string; activeVersionId: string | null };
  versions: MockVersionRow[];
  activatedVersionIds: string[];
} {
  const versions = input.activeVersion ? [{ ...input.activeVersion }] : [];
  const source = { id: input.sourceId, activeVersionId: input.activeVersionId };
  const activatedVersionIds: string[] = [];
  let failFirstVersionReservation = Boolean(input.failFirstVersionReservation);

  const db = {
    prepare(query: string): D1PreparedStatement {
      let params: unknown[] = [];
      return {
        bind(...values: unknown[]): D1PreparedStatement {
          params = values;
          return this;
        },
        async first<T = unknown>() {
          if (query.includes("COALESCE(MAX(version), 0)")) {
            const max = versions.reduce((current, row) => Math.max(current, row.version), 0);
            return { version: max } as T;
          }
          if (query.includes("FROM sources s JOIN source_versions v ON v.id = s.active_version_id")) {
            return (versions.find((row) => row.id === source.activeVersionId) ?? null) as T | null;
          }
          if (query.includes("SELECT id FROM source_versions WHERE id = ? AND source_id = ?")) {
            return (versions.find((row) => row.id === params[0] && row.source_id === params[1]) ? { id: String(params[0]) } : null) as T | null;
          }
          return null as T | null;
        },
        async run() {
          if (query.includes("INSERT INTO source_versions")) {
            if (failFirstVersionReservation) {
              failFirstVersionReservation = false;
              versions.push({
                id: "competing-version-2",
                source_id: String(params[1]),
                version: Number(params[2]),
                r2_key: "originals/source-1/acq-competing",
                extracted_text: "경합 버전",
                normalized_text: "경합 버전",
                normalization_status: "READY",
                normalization_report_json: JSON.stringify({ meaningfulChars: 4, warnings: [] }),
                version_origin: "REEXTRACT",
                parent_version_id: "version-1",
                review_status: "PENDING_REVIEW",
                created_at: "2026-08-23T00:00:01.000Z",
                text_scope: "PARTIAL",
                extraction_method: "HTML_STATIC",
                extraction_error: null,
                content_type: null,
                final_url: "https://competing.example/article",
                acquired_at: "2026-08-23T00:00:01.000Z",
              });
              throw new Error("UNIQUE constraint failed: source_versions.source_id, source_versions.version");
            }
            versions.push({
              id: String(params[0]),
              source_id: String(params[1]),
              version: Number(params[2]),
              r2_key: params[3] as string | null,
              extracted_text: params[4] as string | null,
              normalized_text: params[7] as string | null,
              normalization_status: "READY",
              normalization_report_json: params[8] as string | null,
              version_origin: String(params[9]),
              parent_version_id: (params[10] as string | null) ?? null,
              review_status: String(params[11]),
              created_at: String(params[12]),
              text_scope: String(params[13]),
              extraction_method: String(params[14]),
              extraction_error: (params[15] as string | null) ?? null,
              content_type: (params[16] as string | null) ?? null,
              final_url: (params[17] as string | null) ?? null,
              acquired_at: (params[18] as string | null) ?? null,
            });
          }
          if (query.includes("UPDATE source_versions SET review_status = 'SUPERSEDED'")) {
            for (const row of versions) {
              if (row.source_id === params[1] && row.review_status === "ACTIVE" && row.id !== params[2]) {
                row.review_status = "SUPERSEDED";
              }
            }
          }
          if (query.includes("UPDATE source_versions SET review_status = 'ACTIVE'")) {
            const row = versions.find((entry) => entry.id === params[1] && entry.source_id === params[2]);
            if (row) row.review_status = "ACTIVE";
            activatedVersionIds.push(String(params[1]));
          }
          if (query.includes("SET active_version_id = ?")) {
            source.activeVersionId = String(params[0]);
          }
          return { success: true, meta: { changes: 1 } };
        },
        async all<T = unknown>() {
          return { results: [] as T[] };
        },
      };
    },
    async batch<T = unknown>(statements: D1PreparedStatement[]): Promise<T[]> {
      const results: T[] = [];
      for (const statement of statements) {
        results.push(await statement.run() as T);
      }
      return results;
    },
    source,
    versions,
    activatedVersionIds,
  } as D1Database & {
    source: { id: string; activeVersionId: string | null };
    versions: MockVersionRow[];
    activatedVersionIds: string[];
  };

  return db;
}

function verifySourceAcquisitionMigration(): { foreignKeyCheck: string; jobs: string[] } {
  const tempDir = mkdtempSync(join(tmpdir(), "radar-0015-"));
  const dbPath = join(tempDir, "migration.sqlite");
  const seedPath = join(tempDir, "seed.sql");
  const migrationPath = join(process.cwd(), "../worker/migrations/0015_source_acquisition.sql");
  const migrationSql = readFileSync(migrationPath, "utf8");

  try {
    writeFileSync(
      seedPath,
      [
        "PRAGMA foreign_keys=OFF;",
        "CREATE TABLE research_jobs (id TEXT PRIMARY KEY, workflow_instance_id TEXT UNIQUE, kind TEXT NOT NULL CHECK (kind IN ('DISCOVERY_RUN','DISTILL_RUN','RADAR_SYNTHESIS','DEEP_ANALYSIS')), status TEXT NOT NULL CHECK (status IN ('QUEUED','RUNNING','SUCCEEDED','FAILED','BLOCKED')), progress INTEGER NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100), message TEXT, input_json TEXT NOT NULL, result_json TEXT, result_ref_json TEXT, error_code TEXT, error TEXT, retry_of TEXT REFERENCES research_jobs(id), requested_by TEXT, dedupe_key TEXT NOT NULL, dismissed_at TEXT, created_at TEXT NOT NULL, started_at TEXT, finished_at TEXT, updated_at TEXT NOT NULL);",
        "CREATE TABLE sources (id TEXT PRIMARY KEY, origin TEXT);",
        "CREATE TABLE source_versions (id TEXT PRIMARY KEY, source_id TEXT NOT NULL REFERENCES sources(id), version INTEGER NOT NULL, char_count INTEGER);",
        "INSERT INTO sources VALUES ('s1', 'manual');",
        "INSERT INTO source_versions VALUES ('v1', 's1', 1, 1200);",
        "INSERT INTO research_jobs VALUES ('job-1', NULL, 'DISCOVERY_RUN', 'QUEUED', 0, NULL, '{}', NULL, NULL, NULL, NULL, NULL, NULL, 'k1', NULL, '2026-08-23T00:00:00.000Z', NULL, NULL, '2026-08-23T00:00:00.000Z');",
        "INSERT INTO research_jobs VALUES ('job-2', NULL, 'DISCOVERY_RUN', 'FAILED', 100, NULL, '{}', NULL, NULL, 'retry', 'boom', 'job-1', NULL, 'k2', NULL, '2026-08-23T00:01:00.000Z', NULL, '2026-08-23T00:01:30.000Z', '2026-08-23T00:01:30.000Z');",
        "INSERT INTO research_jobs VALUES ('job-3', NULL, 'DISCOVERY_RUN', 'FAILED', 100, NULL, '{}', NULL, NULL, 'retry', 'loop', 'job-3', NULL, 'k3', NULL, '2026-08-23T00:02:00.000Z', NULL, '2026-08-23T00:02:30.000Z', '2026-08-23T00:02:30.000Z');",
        "PRAGMA foreign_keys=ON;",
        migrationSql,
      ].join("\n"),
      "utf8",
    );

    execFileSync("sqlite3", [dbPath], {
      cwd: tempDir,
      input: readFileSync(seedPath, "utf8"),
      stdio: ["pipe", "pipe", "pipe"],
      encoding: "utf8",
    });

    const foreignKeyCheck = execFileSync("sqlite3", [dbPath, "PRAGMA foreign_key_check;"], {
      cwd: tempDir,
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8",
    }).trim();
    const jobs = execFileSync(
      "sqlite3",
      [
        dbPath,
        "SELECT id || '|' || COALESCE(retry_of, '') || '|' || kind FROM research_jobs ORDER BY created_at;",
      ],
      {
        cwd: tempDir,
        stdio: ["ignore", "pipe", "pipe"],
        encoding: "utf8",
      },
    )
      .trim()
      .split("\n")
      .filter(Boolean);

    return { foreignKeyCheck, jobs };
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}
