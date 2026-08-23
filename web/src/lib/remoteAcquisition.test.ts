import { afterEach, describe, expect, it, vi } from "vitest";
import type { ResearchJobKind, ResearchJobResultRef } from "@radar/shared/discovery";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.resetModules();
});

describe("remote acquisition job metadata", () => {
  it("exposes the source acquisition job kind", () => {
    const kind: ResearchJobKind = "SOURCE_ACQUISITION";

    expect(kind).toBe("SOURCE_ACQUISITION");
  });

  it("uses the reservoir acquisition result ref", () => {
    const resultRef: ResearchJobResultRef = {
      view: "RESERVOIR",
      sourceId: "source-123",
      acquisition: true,
    };

    expect(resultRef).toEqual({
      view: "RESERVOIR",
      sourceId: "source-123",
      acquisition: true,
    });
  });
});

describe("static HTML extraction", () => {
  it("selects article text and excludes site chrome", async () => {
    const { extractStaticHtml } = await import("../../../worker/src/ingestion/extractHtml");

    const result = extractStaticHtml(
      `<header>메뉴</header><main><article><h1>제목</h1><p>${"본문 ".repeat(500)}</p></article></main><footer>쿠키</footer>`,
      "https://example.com/article",
    );

    expect(result.text).toContain("본문");
    expect(result.text).not.toContain("쿠키");
    expect(result.method).toBe("HTML_STATIC");
    expect(result.scope).toBe("FULLTEXT");
  });

  it("removes nested cookie, consent, share, and ad blocks inside content containers", async () => {
    const { extractStaticHtml } = await import("../../../worker/src/ingestion/extractHtml");

    const result = extractStaticHtml(
      `<main><article><h1>제목</h1><p>${"본문 ".repeat(260)}</p><div class="cookie-banner">쿠키 동의</div><section aria-label="Share this article">공유하기</section><aside id="consent-panel">개인정보 동의</aside><div class="ad-slot">광고 배너</div></article></main>`,
      "https://example.com/article",
    );

    expect(result.text).toContain("본문");
    expect(result.text).not.toContain("쿠키 동의");
    expect(result.text).not.toContain("공유하기");
    expect(result.text).not.toContain("개인정보 동의");
    expect(result.text).not.toContain("광고 배너");
  });

  it("falls back to the body when no strong content container exists", async () => {
    const { extractStaticHtml } = await import("../../../worker/src/ingestion/extractHtml");

    const bodyText = "문장 ".repeat(120);
    const result = extractStaticHtml(`<html><body><div>${bodyText}</div></body></html>`, "https://example.com/note");

    expect(result.text).toContain("문장");
    expect(result.warnings).toContain("fallback_body");
  });

  it("flags a JavaScript shell as partial or empty", async () => {
    const { extractStaticHtml } = await import("../../../worker/src/ingestion/extractHtml");

    const result = extractStaticHtml(
      `<html><head><title>App</title></head><body><div id="root"></div><script src="app.js"></script></body></html>`,
      "https://example.com/app",
    );

    expect(["PARTIAL", "EMPTY"]).toContain(result.scope);
    expect(result.warnings).toContain("js_shell");
  });
});

describe("remote acquisition", () => {
  describe("fetchRemoteDocument", () => {
    it("blocks direct private network targets before issuing a request", async () => {
      const { fetchRemoteDocument } = await import("../../../worker/src/ingestion/fetchRemoteDocument");
      const fetchSpy = vi.fn();
      vi.stubGlobal("fetch", fetchSpy);

      await expect(fetchRemoteDocument("http://127.0.0.1/private"))
        .rejects.toThrow("REDIRECT_BLOCKED");
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("blocks redirects into private networks", async () => {
      const { fetchRemoteDocument } = await import("../../../worker/src/ingestion/fetchRemoteDocument");
      const fetchSpy = vi.fn().mockResolvedValue(new Response(null, {
        status: 302,
        headers: { location: "http://169.254.169.254/latest" },
      }));
      vi.stubGlobal("fetch", fetchSpy);

      await expect(fetchRemoteDocument("https://public.example/start", {
        resolveDns: allowPublicDnsResolution,
        fetchImpl: fetchSpy,
      })).rejects.toThrow("REDIRECT_BLOCKED");
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    it("rejects bodies larger than 20 MiB while streaming", async () => {
      const { fetchRemoteDocument } = await import("../../../worker/src/ingestion/fetchRemoteDocument");
      const oversized = makeStreamResponse([
        new Uint8Array(20 * 1024 * 1024),
        new Uint8Array(1),
      ], {
        "content-type": "text/html; charset=utf-8",
      });

      await expect(fetchRemoteDocument("https://public.example/large", {
        resolveDns: allowPublicDnsResolution,
        fetchImpl: vi.fn().mockResolvedValue(oversized),
      })).rejects.toThrow("SIZE_LIMIT");
    });

    it("maps body-read aborts to FETCH_TIMEOUT", async () => {
      const { fetchRemoteDocument } = await import("../../../worker/src/ingestion/fetchRemoteDocument");
      vi.useFakeTimers();

      const hanging = new Response(new ReadableStream({
        start() {
          // keep pending until abort
        },
        cancel() {
          return undefined;
        },
      }), {
        status: 200,
        headers: { "content-type": "text/html" },
      });
      const response = withResponseUrl(hanging, "https://public.example/slow");

      const promise = fetchRemoteDocument("https://public.example/slow", {
        resolveDns: allowPublicDnsResolution,
        fetchImpl: vi.fn((_url: string, init?: RequestInit) => {
          init?.signal?.addEventListener("abort", () => {
            // noop: stream cancellation surfaces the abort
          }, { once: true });
          return Promise.resolve(response);
        }),
      });
      const outcome = promise.then(
        () => "resolved",
        (error: unknown) => error instanceof Error ? error.message : String(error),
      );

      await vi.advanceTimersByTimeAsync(20_000);

      await expect(outcome).resolves.toBe("FETCH_TIMEOUT");
    });

    it("returns raw HTML with normalized content type and final URL", async () => {
      const { fetchRemoteDocument } = await import("../../../worker/src/ingestion/fetchRemoteDocument");
      const body = "<html><body><article>본문</article></body></html>";
      const response = withResponseUrl(new Response(body, {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      }), "https://public.example/final");

      const result = await fetchRemoteDocument("https://public.example/start", {
        resolveDns: allowPublicDnsResolution,
        fetchImpl: vi.fn().mockResolvedValue(response),
      });

      expect(result.kind).toBe("HTML");
      expect(result.contentType).toBe("text/html");
      expect(result.finalUrl).toBe("https://public.example/final");
      expect(new TextDecoder().decode(result.body)).toContain("본문");
    });
  });

  it("converts DNS resolution timeout into FETCH_TIMEOUT within the 20-second acquisition boundary", async () => {
    vi.useFakeTimers();
    const { acquireRemoteSource } = await import("../../../worker/src/ingestion/acquireRemoteSource");
    const env = makeAcquisitionEnv();
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const acquisitionPromise = acquireRemoteSource(
      env,
      { sourceId: "source-1", url: "https://slow.example/article", version: 2 },
      {
        resolveDns: async (_hostname, _recordType, signal?: AbortSignal) => new Promise<string[]>((_, reject) => {
          signal?.addEventListener(
            "abort",
            () => reject(new DOMException("The operation was aborted.", "AbortError")),
            { once: true },
          );
        }),
      },
    );
    let settled = false;
    const outcomePromise = acquisitionPromise.then(
      () => "resolved",
      (error: unknown) => error instanceof Error ? error.message : String(error),
    ).finally(() => {
      settled = true;
    });

    await vi.advanceTimersByTimeAsync(20_000);
    await Promise.resolve();

    expect(settled).toBe(true);
    await expect(outcomePromise).resolves.toBe("FETCH_TIMEOUT");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("fetches HTML, stores the raw response, and returns extracted provenance", async () => {
    const { acquireRemoteSource } = await import("../../../worker/src/ingestion/acquireRemoteSource");
    const env = makeAcquisitionEnv();
    const response = withResponseUrl(
      new Response(
        `<html><head><title>Redirected</title><meta name="description" content="설명"></head><body><main><article><p>${"본문 ".repeat(320)}</p></article></main></body></html>`,
        { status: 200, headers: { "content-type": "text/html; charset=utf-8" } },
      ),
      "https://final.example/article",
    );
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));

    const result = await acquireRemoteSource(env, {
      sourceId: "source-1",
      url: "https://start.example/article",
      version: 2,
    }, {
      resolveDns: allowPublicDnsResolution,
    });

    expect(result).toMatchObject({
      kind: "HTML",
      r2Key: "originals/source-1/v2.html",
      title: "Redirected",
      contentType: "text/html",
      finalUrl: "https://final.example/article",
      extractionMethod: "HTML_STATIC",
    });
    expect(result.extractedText).toContain("본문");
    expect(env.__fixture.objects.has("originals/source-1/v2.html")).toBe(true);
  });

  it("blocks private network targets before issuing a request", async () => {
    const { acquireRemoteSource } = await import("../../../worker/src/ingestion/acquireRemoteSource");
    const env = makeAcquisitionEnv();
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    await expect(acquireRemoteSource(env, { sourceId: "source-1", url: "http://127.0.0.1/secret", version: 2 }))
      .rejects.toThrow("REDIRECT_BLOCKED");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("blocks hostnames that resolve to loopback or private addresses before issuing the request", async () => {
    const { acquireRemoteSource } = await import("../../../worker/src/ingestion/acquireRemoteSource");
    const env = makeAcquisitionEnv();
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    await expect(acquireRemoteSource(
      env,
      { sourceId: "source-1", url: "https://public.example/article", version: 2 },
      {
        resolveDns: async (hostname, recordType) => {
          expect(hostname).toBe("public.example");
          return recordType === "A" ? ["127.0.0.1", "10.0.0.9"] : [];
        },
      },
    )).rejects.toThrow("REDIRECT_BLOCKED");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects unsupported content types with a stable error code", async () => {
    const { acquireRemoteSource } = await import("../../../worker/src/ingestion/acquireRemoteSource");
    const env = makeAcquisitionEnv();
    const response = withResponseUrl(
      new Response(new Uint8Array([1, 2, 3]).buffer, { status: 200, headers: { "content-type": "image/png" } }),
      "https://example.com/file.png",
    );
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));

    await expect(acquireRemoteSource(env, { sourceId: "source-1", url: "https://example.com/file.png", version: 2 }, {
      resolveDns: allowPublicDnsResolution,
    }))
      .rejects.toThrow("UNSUPPORTED_CONTENT_TYPE");
  });

  it("converts a remote PDF through Workers AI and preserves the method", async () => {
    const { acquireRemoteSource } = await import("../../../worker/src/ingestion/acquireRemoteSource");
    const env = makeAcquisitionEnv({
      contentType: "application/pdf",
      body: makePdfBuffer(),
      toMarkdown: async () => [{ name: "paper.md", blob: new Blob([`${"본문 ".repeat(600)}`]) }],
    });
    const response = withResponseUrl(
      new Response(env.__fixture.body.slice(0), { status: 200, headers: { "content-type": env.__fixture.contentType } }),
      "https://arxiv.org/pdf/1234",
    );
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));

    const result = await acquireRemoteSource(env, {
      sourceId: "s1",
      url: "https://arxiv.org/pdf/1234",
      version: 2,
    }, {
      resolveDns: allowPublicDnsResolution,
    });

    expect(result.kind).toBe("PDF");
    expect(result.extractionMethod).toBe("PDF_REMOTE_TO_MARKDOWN");
    expect(result.textScope).toBe("FULLTEXT");
  });

  it("keeps long low-signal PDF markdown below the fulltext gate", async () => {
    const { acquireRemoteSource } = await import("../../../worker/src/ingestion/acquireRemoteSource");
    const env = makeAcquisitionEnv({
      contentType: "application/pdf",
      body: makePdfBuffer(),
      toMarkdown: async () => [{ name: "paper.md", blob: new Blob([`${"* ".repeat(800)}${"A".repeat(400)}`]) }],
    });
    const response = withResponseUrl(
      new Response(env.__fixture.body.slice(0), { status: 200, headers: { "content-type": env.__fixture.contentType } }),
      "https://arxiv.org/pdf/5678",
    );
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));

    const result = await acquireRemoteSource(env, {
      sourceId: "s1",
      url: "https://arxiv.org/pdf/5678",
      version: 2,
    }, {
      resolveDns: allowPublicDnsResolution,
    });

    expect(result.textScope).toBe("PARTIAL");
  });

  it("reports a conversion failure without treating the binary as text", async () => {
    const { acquireRemoteSource } = await import("../../../worker/src/ingestion/acquireRemoteSource");
    const env = makeAcquisitionEnv({
      contentType: "application/pdf",
      body: makePdfBuffer(),
      toMarkdown: async () => {
        throw new Error("conversion_failed");
      },
    });
    const response = withResponseUrl(
      new Response(env.__fixture.body.slice(0), { status: 200, headers: { "content-type": env.__fixture.contentType } }),
      "https://arxiv.org/pdf/1234",
    );
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));

    await expect(acquireRemoteSource(env, {
      sourceId: "s1",
      url: "https://arxiv.org/pdf/1234",
      version: 2,
    }, {
      resolveDns: allowPublicDnsResolution,
    })).rejects.toThrow("PDF_CONVERSION_FAILED");
  });

  it("treats a .pdf URL with HTML content as HTML and skips PDF conversion", async () => {
    const { acquireRemoteSource } = await import("../../../worker/src/ingestion/acquireRemoteSource");
    const env = makeAcquisitionEnv();
    const response = withResponseUrl(
      new Response(
        `<html><head><title>HTML fallback</title></head><body><main><article><p>${"본문 ".repeat(260)}</p></article></main></body></html>`,
        { status: 200, headers: { "content-type": "text/html; charset=utf-8" } },
      ),
      "https://example.com/file.pdf",
    );
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
    const toMarkdownSpy = vi.spyOn(env.AI, "toMarkdown");

    const result = await acquireRemoteSource(env, {
      sourceId: "source-html-pdf-url",
      url: "https://example.com/file.pdf",
      version: 2,
    }, {
      resolveDns: allowPublicDnsResolution,
    });

    expect(result.kind).toBe("HTML");
    expect(result.r2Key).toBe("originals/source-html-pdf-url/v2.html");
    expect(result.extractionMethod).toBe("HTML_STATIC");
    expect(toMarkdownSpy).not.toHaveBeenCalled();
  });

  it("stores invalid claimed PDFs before surfacing PDF_SIGNATURE_INVALID", async () => {
    const { acquireRemoteSource } = await import("../../../worker/src/ingestion/acquireRemoteSource");
    const env = makeAcquisitionEnv({
      contentType: "application/pdf",
      body: new TextEncoder().encode("not-a-pdf").buffer,
    });
    const response = withResponseUrl(
      new Response(env.__fixture.body.slice(0), {
        status: 200,
        headers: { "content-type": "application/pdf" },
      }),
      "https://example.com/paper.pdf",
    );
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));

    await expect(acquireRemoteSource(env, {
      sourceId: "source-invalid-pdf",
      url: "https://example.com/paper.pdf",
      version: 2,
    }, {
      resolveDns: allowPublicDnsResolution,
    })).rejects.toThrow("PDF_SIGNATURE_INVALID");

    expect(env.__fixture.objects.has("originals/source-invalid-pdf/v2.pdf")).toBe(true);
  });

  it("maps invalid-PDF raw storage failures to HTTP_5XX", async () => {
    const { acquireRemoteSource } = await import("../../../worker/src/ingestion/acquireRemoteSource");
    const env = makeAcquisitionEnv({
      contentType: "application/pdf",
      body: new TextEncoder().encode("not-a-pdf").buffer,
      put: async () => {
        throw new Error("r2_put_failed");
      },
    });
    const response = withResponseUrl(
      new Response(env.__fixture.body.slice(0), {
        status: 200,
        headers: { "content-type": "application/pdf" },
      }),
      "https://example.com/paper.pdf",
    );
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));

    await expect(acquireRemoteSource(env, {
      sourceId: "source-invalid-pdf-put-failure",
      url: "https://example.com/paper.pdf",
      version: 2,
    }, {
      resolveDns: allowPublicDnsResolution,
    })).rejects.toThrow("HTTP_5XX");

    expect(env.__fixture.objects.has("originals/source-invalid-pdf-put-failure/v2.pdf")).toBe(false);
  });
});

describe("source acquisition workflow", () => {
  it("uses one job-derived acquisition identity for storage and version reuse", async () => {
    const fixture = setupResearchJobWorkflowFixture();
    fixture.acquireRemoteSource.mockResolvedValue({
      kind: "HTML",
      r2Key: "originals/source-1/acq-job-123.html",
      extractedText: "충분히 긴 본문 텍스트입니다. 연구 대상 본문으로 재사용할 수 있습니다.",
      title: "Title",
      contentType: "text/html",
      finalUrl: "https://example.com/article",
      warnings: [],
      textScope: "FULLTEXT",
      extractionMethod: "HTML_STATIC",
    });
    fixture.appendAcquisitionVersion.mockResolvedValue({
      versionId: "acq-job-123",
      version: 2,
      qualityStatus: "READY",
    });

    const { executeSourceAcquisitionJob, db } = await loadSourceAcquisitionRunner(fixture);
    await executeSourceAcquisitionJob({
      env: { DB: db } as Env,
      job: {
        id: "job-123",
        input: { sourceId: "source-1", url: "https://example.com/article" },
      },
      updateProgress: fixture.updateJobProgress,
    });

    expect(fixture.acquireRemoteSource).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        sourceId: "source-1",
        url: "https://example.com/article",
        versionId: "acq-job-123",
      }),
    );
    expect(fixture.appendAcquisitionVersion).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        sourceId: "source-1",
        versionId: "acq-job-123",
        r2Key: "originals/source-1/acq-job-123.html",
      }),
    );
  });

  it("marks the ingest job failed before rethrowing append errors", async () => {
    const fixture = setupResearchJobWorkflowFixture();
    fixture.acquireRemoteSource.mockResolvedValue({
      kind: "HTML",
      r2Key: "originals/source-1/acq-job-999.html",
      extractedText: "충분히 긴 본문 텍스트입니다. 저장 직전 실패를 재현합니다.",
      title: "Title",
      contentType: "text/html",
      finalUrl: "https://example.com/article",
      warnings: [],
      textScope: "FULLTEXT",
      extractionMethod: "HTML_STATIC",
    });
    fixture.appendAcquisitionVersion.mockRejectedValue(new Error("insert_failed"));

    const { executeSourceAcquisitionJob, db } = await loadSourceAcquisitionRunner(fixture);

    await expect(executeSourceAcquisitionJob({
      env: { DB: db } as Env,
      job: {
        id: "job-999",
        input: { sourceId: "source-1", url: "https://example.com/article" },
      },
      updateProgress: fixture.updateJobProgress,
    })).rejects.toThrow("insert_failed");

    expect(fixture.updateIngestJob).toHaveBeenNthCalledWith(1, db, "source-1", "received", null);
    expect(fixture.updateIngestJob).toHaveBeenNthCalledWith(2, db, "source-1", "failed", "source_version_store_failed");
  });

  it("preserves the acquisition error when the failed ingest update rejects", async () => {
    const fixture = setupResearchJobWorkflowFixture();
    const acquisitionError = new Error("acquire_failed");
    fixture.acquireRemoteSource.mockRejectedValue(acquisitionError);
    fixture.updateIngestJob
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("failed_status_update_failed"));

    const { executeSourceAcquisitionJob, db } = await loadSourceAcquisitionRunner(fixture);

    await expect(executeSourceAcquisitionJob({
      env: { DB: db } as Env,
      job: {
        id: "job-acquire-failure",
        input: { sourceId: "source-1", url: "https://example.com/article" },
      },
      updateProgress: fixture.updateJobProgress,
    })).rejects.toBe(acquisitionError);

    expect(fixture.updateIngestJob).toHaveBeenNthCalledWith(1, db, "source-1", "received", null);
    expect(fixture.updateIngestJob).toHaveBeenNthCalledWith(2, db, "source-1", "failed", "acquire_failed");
  });

  it("preserves the append error when the failed ingest update rejects", async () => {
    const fixture = setupResearchJobWorkflowFixture();
    const appendError = new Error("append_failed");
    fixture.acquireRemoteSource.mockResolvedValue({
      kind: "HTML",
      r2Key: "originals/source-1/acq-job-append-failure.html",
      extractedText: "충분히 긴 본문 텍스트입니다. 저장 상태 업데이트 실패를 재현합니다.",
      title: "Title",
      contentType: "text/html",
      finalUrl: "https://example.com/article",
      warnings: [],
      textScope: "FULLTEXT",
      extractionMethod: "HTML_STATIC",
    });
    fixture.appendAcquisitionVersion.mockRejectedValue(appendError);
    fixture.updateIngestJob
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("failed_status_update_failed"));

    const { executeSourceAcquisitionJob, db } = await loadSourceAcquisitionRunner(fixture);

    await expect(executeSourceAcquisitionJob({
      env: { DB: db } as Env,
      job: {
        id: "job-append-failure",
        input: { sourceId: "source-1", url: "https://example.com/article" },
      },
      updateProgress: fixture.updateJobProgress,
    })).rejects.toBe(appendError);

    expect(fixture.updateIngestJob).toHaveBeenNthCalledWith(1, db, "source-1", "received", null);
    expect(fixture.updateIngestJob).toHaveBeenNthCalledWith(2, db, "source-1", "failed", "source_version_store_failed");
  });
});

describe("manual URL extraction compatibility", () => {
  it("preserves legacy fields while exposing new extraction metadata", async () => {
    const { fetchAndExtract } = await import("../../../worker/src/ingestion/extractUrl");
    const response = withResponseUrl(
      new Response(
        `<html><head><title>제목 &amp; 테스트</title><meta property="og:site_name" content="Example"></head><body><main><article><p>${"본문 ".repeat(620)}</p></article></main></body></html>`,
        { status: 200, headers: { "content-type": "text/html; charset=utf-8" } },
      ),
      "https://final.example/post",
    );
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));

    const page = await fetchAndExtract("https://start.example/post");

    expect(page.html).toContain("<article>");
    expect(page.title).toBe("제목 & 테스트");
    expect(page.text).toContain("본문");
    expect(page.siteName).toBe("Example");
    expect(page.description).toBeNull();
    expect(page.finalUrl).toBe("https://final.example/post");
    expect(page.method).toBe("HTML_STATIC");
    expect(page.scope).toBe("FULLTEXT");
  });
});

function makeAcquisitionEnv(input: {
  contentType?: string;
  body?: ArrayBuffer;
  toMarkdown?: (files: unknown[]) => Promise<{ name: string; blob: Blob }[]>;
  put?: (key: string, value: ArrayBuffer | Blob | string) => Promise<void>;
} = {}) {
  const objects = new Map<string, ArrayBuffer>();
  const contentType = input.contentType ?? "text/html";
  const body = input.body ?? new TextEncoder().encode("<html></html>").buffer;
  return {
    ORIGINALS: {
      put: async (key: string, value: ArrayBuffer | Blob | string) => {
        if (input.put) return input.put(key, value);
        if (value instanceof ArrayBuffer) {
          objects.set(key, value);
          return;
        }
        if (value instanceof Blob) {
          objects.set(key, await value.arrayBuffer());
          return;
        }
        objects.set(key, new TextEncoder().encode(value).buffer);
      },
    },
    AI: {
      toMarkdown: async (filesOrRequest: unknown[] | { files: unknown[] }) => (input.toMarkdown
        ? input.toMarkdown(Array.isArray(filesOrRequest) ? filesOrRequest : filesOrRequest.files)
        : [{ name: "document.md", blob: new Blob([]) }]),
    },
    __fixture: { contentType, body, objects },
  } as unknown as Env & {
    __fixture: {
      contentType: string;
      body: ArrayBuffer;
      objects: Map<string, ArrayBuffer>;
    };
  };
}

function withResponseUrl(response: Response, url: string): Response {
  Object.defineProperty(response, "url", { value: url, configurable: true });
  return response;
}

function makeStreamResponse(chunks: Uint8Array[], headers: HeadersInit, url = "https://public.example/stream"): Response {
  const response = new Response(new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  }), {
    status: 200,
    headers,
  });

  return withResponseUrl(response, url);
}

function makePdfBuffer(prefix = "%PDF-1.7\nmock pdf body"): ArrayBuffer {
  return new TextEncoder().encode(prefix).buffer;
}

async function allowPublicDnsResolution(_hostname: string, recordType: "A" | "AAAA"): Promise<string[]> {
  return recordType === "A" ? ["93.184.216.34"] : ["2606:2800:220:1:248:1893:25c8:1946"];
}

function setupResearchJobWorkflowFixture() {
  return {
    getActiveVersion: vi.fn().mockResolvedValue(null),
    acquireRemoteSource: vi.fn(),
    appendAcquisitionVersion: vi.fn(),
    updateIngestJob: vi.fn(),
    updateJobProgress: vi.fn(),
  };
}

async function loadSourceAcquisitionRunner(fixture: ReturnType<typeof setupResearchJobWorkflowFixture>) {
  vi.doMock("../../../worker/src/ingestion/acquireRemoteSource", async (importOriginal) => ({
    ...await importOriginal<typeof import("../../../worker/src/ingestion/acquireRemoteSource")>(),
    acquireRemoteSource: fixture.acquireRemoteSource,
  }));
  vi.doMock("../../../worker/src/ingestion/store", () => ({
    updateIngestJob: fixture.updateIngestJob,
  }));
  vi.doMock("../../../worker/src/ingestion/versioning", () => ({
    appendAcquisitionVersion: fixture.appendAcquisitionVersion,
    getActiveVersion: fixture.getActiveVersion,
  }));
  const db = {
    prepare() {
      return {
        bind() {
          return this;
        },
        async first() {
          return null;
        },
      };
    },
  } as unknown as D1Database;

  const mod = await import("../../../worker/src/workflows/sourceAcquisition");

  return { executeSourceAcquisitionJob: mod.executeSourceAcquisitionJob, db };
}
