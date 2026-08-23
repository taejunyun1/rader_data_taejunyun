import { afterEach, describe, expect, it, vi } from "vitest";
import type { ResearchJobKind, ResearchJobResultRef } from "@radar/shared/discovery";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
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

  it("rejects unsupported content types with a stable error code", async () => {
    const { acquireRemoteSource } = await import("../../../worker/src/ingestion/acquireRemoteSource");
    const env = makeAcquisitionEnv();
    const response = withResponseUrl(
      new Response(new Uint8Array([1, 2, 3]).buffer, { status: 200, headers: { "content-type": "image/png" } }),
      "https://example.com/file.png",
    );
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));

    await expect(acquireRemoteSource(env, { sourceId: "source-1", url: "https://example.com/file.png", version: 2 }))
      .rejects.toThrow("UNSUPPORTED_CONTENT_TYPE");
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

function makeAcquisitionEnv() {
  const objects = new Map<string, ArrayBuffer>();
  return {
    ORIGINALS: {
      put: async (key: string, value: ArrayBuffer | Blob | string) => {
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
    __fixture: { objects },
  } as unknown as Env & { __fixture: { objects: Map<string, ArrayBuffer> } };
}

function withResponseUrl(response: Response, url: string): Response {
  Object.defineProperty(response, "url", { value: url, configurable: true });
  return response;
}
