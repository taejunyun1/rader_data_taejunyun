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

  it("keeps article text nested in an unthinking photography grid", async () => {
    const { extractStaticHtml } = await import("../../../worker/src/ingestion/extractHtml");
    const { readFile } = await import("node:fs/promises");
    const sourceHtml = await readFile("src/lib/fixtures/unthinking-photography-grid.html", "utf8");
    const result = extractStaticHtml(
      sourceHtml,
      "https://unthinking.photography/imgexhaust/how-photography-was-reinvented-43-times",
    );

    expect(result.text).toContain("A timeline built by Lev Manovich");
    expect(result.text).toContain("Trust in the image becomes cryptographic");
  });

  it("extracts deterministic visual candidates from stored article HTML and records rejection signals", async () => {
    const { readFile } = await import("node:fs/promises");
    const { extractStaticHtml } = await import("../../../worker/src/ingestion/extractHtml");
    const { inspectHtmlVisualCandidates } = await import("../../../worker/src/visual/extraction/html");
    const sourceHtml = await readFile("tests/fixtures/visual/article-with-figures.html", "utf8");

    const extracted = extractStaticHtml(sourceHtml, "https://example.com/articles/visuals?ref=feed");
    const result = inspectHtmlVisualCandidates(
      sourceHtml,
      "https://example.com/articles/visuals?ref=feed",
      extracted.selectedFragmentHtml,
    );

    expect(result.candidates).toHaveLength(3);
    expect(result.candidates).toEqual([
      expect.objectContaining({
        sourceUrl: "https://example.com/images/infrared-floor-1600.jpg?size=large",
        sourceSetUrls: [
          "https://example.com/images/infrared-floor-800.jpg?size=medium",
          "https://example.com/images/infrared-floor-1600.jpg?size=large",
        ],
        alt: "Infrared installation view",
        figureLabel: "Figure 1",
        caption: "Infrared installation view from the exhibition floor.",
        declaredWidth: 320,
        declaredHeight: 213,
        signals: expect.arrayContaining(["private_source_url"]),
      }),
      expect.objectContaining({
        sourceUrl: "https://cdn.example.com/images/detail-crop.jpg?size=medium",
        sourceSetUrls: [],
        alt: "Printed wall label",
        figureLabel: "Figure 2",
        caption: "Printed wall label beside the projection.",
        declaredWidth: 120,
        declaredHeight: 90,
        signals: expect.arrayContaining(["review_small_context"]),
      }),
      expect.objectContaining({
        sourceUrl: "https://example.com/images/museum-glyph.png",
        alt: "Museum glyph",
        figureLabel: "Figure 3",
        caption: "Museum glyph used as a curatorial marker.",
        declaredWidth: 24,
        declaredHeight: 24,
        signals: expect.arrayContaining(["review_small_context"]),
      }),
    ]);
    expect(result.candidates[0]?.nearbyText).toContain("floor projection");
    expect(result.candidates[2]?.signals).not.toContain("decorative_icon");
    expect(result.candidates.map((candidate) => candidate.sourceUrl)).not.toContain("https://example.com/images/sidebar-plain-photo.jpg");
    expect(result.rejected).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sourceUrl: "https://example.com/assets/logo-mark.svg",
          signals: expect.arrayContaining(["container:header", "repeated_logo"]),
        }),
        expect.objectContaining({
          sourceUrl: "https://example.com/assets/share-x.png",
          signals: expect.arrayContaining(["container:nav", "decorative_icon"]),
        }),
        expect.objectContaining({
          sourceUrl: "https://tracker.example/pixel.gif?open=1",
          signals: expect.arrayContaining(["tracker_pixel"]),
        }),
        expect.objectContaining({
          sourceUrl: "https://ads.example.com/banner.jpg",
          signals: expect.arrayContaining(["container:aside", "ad_related"]),
        }),
        expect.objectContaining({
          sourceUrl: "https://example.com/images/sidebar-plain-photo.jpg",
          signals: expect.arrayContaining(["container:aside"]),
        }),
      ]),
    );
  });

  it("keeps aside images rejected even when the selected fragment still contains the aside block", async () => {
    const { readFile } = await import("node:fs/promises");
    const { inspectHtmlVisualCandidates } = await import("../../../worker/src/visual/extraction/html");
    const sourceHtml = await readFile("tests/fixtures/visual/article-with-figures.html", "utf8");
    const selectedArticleFragment = sourceHtml.match(/<article\b[^>]*>[\s\S]*<\/article>/i)?.[0];

    expect(selectedArticleFragment).toContain("<aside");

    const result = inspectHtmlVisualCandidates(
      sourceHtml,
      "https://example.com/articles/visuals?ref=feed",
      selectedArticleFragment,
    );

    expect(result.candidates.map((candidate) => candidate.sourceUrl)).not.toContain("https://example.com/images/sidebar-plain-photo.jpg");
    expect(result.rejected).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sourceUrl: "https://example.com/images/sidebar-plain-photo.jpg",
          signals: expect.arrayContaining(["container:aside"]),
        }),
      ]),
    );
  });

  it.each([
    ["data:image/png;base64,abc", "blocked_source_scheme"],
    ["blob:https://example.com/blob-id", "blocked_source_scheme"],
    ["javascript:alert(1)", "blocked_source_scheme"],
    ["http://127.0.0.1/private.png", "private_source_url"],
    ["http://[fd00::1]/private.png", "private_source_url"],
    ["http://[fe80::1]/private.png", "private_source_url"],
    ["http://[fe90::1]/private.png", "private_source_url"],
    ["http://[::ffff:127.0.0.1]/private.png", "private_source_url"],
  ] satisfies Array<[string, string]>)("rejects direct candidate urls for %s", async (src, expectedSignal) => {
    const { extractStaticHtml } = await import("../../../worker/src/ingestion/extractHtml");
    const { inspectHtmlVisualCandidates } = await import("../../../worker/src/visual/extraction/html");
    const html = `<main><article><figure><img src="${src}" alt="Blocked candidate" width="400" height="300" /><figcaption>Figure 1. Blocked image.</figcaption></figure><p>Supporting text around the blocked candidate.</p></article></main>`;

    const extracted = extractStaticHtml(html, "https://example.com/post");
    const result = inspectHtmlVisualCandidates(html, "https://example.com/post", extracted.selectedFragmentHtml);

    expect(result.candidates).toHaveLength(0);
    expect(result.rejected).toEqual([
      expect.objectContaining({
        sourceUrl: null,
        signals: expect.arrayContaining([expectedSignal]),
      }),
    ]);
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

  describe("fetchRemoteImage", () => {
    it("blocks direct private network image targets before issuing a request", async () => {
      const { fetchRemoteImage } = await import("../../../worker/src/visual/extraction/fetchImage");
      const fetchSpy = vi.fn();
      vi.stubGlobal("fetch", fetchSpy);

      await expect(fetchRemoteImage("http://127.0.0.1/private.png"))
        .rejects.toThrow("IMAGE_URL_BLOCKED");
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("rejects content-type and magic mismatches with IMAGE_TYPE_INVALID", async () => {
      const { fetchRemoteImage } = await import("../../../worker/src/visual/extraction/fetchImage");
      const response = withResponseUrl(new Response("<html>not-an-image</html>", {
        status: 200,
        headers: { "content-type": "image/png" },
      }), "https://public.example/not-image.png");

      await expect(fetchRemoteImage("https://public.example/not-image.png", {
        resolveDns: allowPublicDnsResolution,
        fetchImpl: vi.fn().mockResolvedValue(response),
      })).rejects.toThrow("IMAGE_TYPE_INVALID");
    });

    it("rejects bodies larger than 10 MiB while streaming", async () => {
      const { fetchRemoteImage } = await import("../../../worker/src/visual/extraction/fetchImage");
      const oversized = makeStreamResponse([
        new Uint8Array(10 * 1024 * 1024),
        new Uint8Array(1),
      ], {
        "content-type": "image/png",
      });

      await expect(fetchRemoteImage("https://public.example/large.png", {
        resolveDns: allowPublicDnsResolution,
        fetchImpl: vi.fn().mockResolvedValue(oversized),
      })).rejects.toThrow("IMAGE_SIZE_LIMIT");
    });

    it("returns a safe SVG image with the final URL and stable content hash", async () => {
      const { fetchRemoteImage } = await import("../../../worker/src/visual/extraction/fetchImage");
      const body = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10" /></svg>`;
      const response = withResponseUrl(new Response(body, {
        status: 200,
        headers: { "content-type": "image/svg+xml; charset=utf-8" },
      }), "https://public.example/final.svg");

      const result = await fetchRemoteImage("https://public.example/start.svg", {
        resolveDns: allowPublicDnsResolution,
        fetchImpl: vi.fn().mockResolvedValue(response),
      });

      expect(result.contentType).toBe("image/svg+xml");
      expect(result.finalUrl).toBe("https://public.example/final.svg");
      expect(result.contentHash).toMatch(/^[0-9a-f]{64}$/);
      expect(result.byteSize).toBe(new TextEncoder().encode(body).byteLength);
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

  it("enqueues visual extraction only after the acquired version becomes active", async () => {
    const fixture = setupResearchJobWorkflowFixture();
    fixture.acquireRemoteSource.mockResolvedValue({
      kind: "HTML",
      r2Key: "originals/source-1/acq-job-visual.html",
      extractedText: "충분히 긴 본문 텍스트입니다. 시각 후보 추출을 이어서 진행할 수 있습니다.",
      title: "Title",
      contentType: "text/html",
      finalUrl: "https://example.com/article",
      warnings: [],
      textScope: "FULLTEXT",
      extractionMethod: "HTML_STATIC",
    });
    fixture.appendAcquisitionVersion.mockResolvedValue({
      versionId: "acq-job-visual",
      version: 2,
      qualityStatus: "READY",
    });
    fixture.getActiveVersion
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: "acq-job-visual", version: 2 });

    const { executeSourceAcquisitionJob, db } = await loadSourceAcquisitionRunner(fixture);
    const result = await executeSourceAcquisitionJob({
      env: { DB: db } as Env,
      job: {
        id: "job-visual",
        input: { sourceId: "source-1", url: "https://example.com/article" },
      },
      updateProgress: fixture.updateJobProgress,
    });

    expect(fixture.enqueueResearchJob).toHaveBeenCalledWith(
      expect.objectContaining({ DB: db }),
      { kind: "VISUAL_EXTRACTION", input: { sourceId: "source-1", sourceVersionId: "acq-job-visual" } },
      "system:source-acquisition",
    );
    expect(result.result.versionId).toBe("acq-job-visual");
  });

  it("keeps acquisition successful when visual extraction enqueue fails and records a warning", async () => {
    const fixture = setupResearchJobWorkflowFixture();
    fixture.acquireRemoteSource.mockResolvedValue({
      kind: "HTML",
      r2Key: "originals/source-1/acq-job-warning.html",
      extractedText: "충분히 긴 본문 텍스트입니다. 후속 시각 추출 enqueue 실패를 재현합니다.",
      title: "Title",
      contentType: "text/html",
      finalUrl: "https://example.com/article",
      warnings: [],
      textScope: "FULLTEXT",
      extractionMethod: "HTML_STATIC",
    });
    fixture.appendAcquisitionVersion.mockResolvedValue({
      versionId: "acq-job-warning",
      version: 2,
      qualityStatus: "READY",
    });
    fixture.getActiveVersion
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: "acq-job-warning", version: 2 });
    fixture.enqueueResearchJob.mockRejectedValue(new Error("visual_enqueue_failed"));

    const { executeSourceAcquisitionJob, db } = await loadSourceAcquisitionRunner(fixture);
    const result = await executeSourceAcquisitionJob({
      env: { DB: db } as Env,
      job: {
        id: "job-warning",
        input: { sourceId: "source-1", url: "https://example.com/article" },
      },
      updateProgress: fixture.updateJobProgress,
    });

    expect(fixture.updateIngestJob).toHaveBeenNthCalledWith(2, db, "source-1", "extracted", null);
    expect(result.result).toMatchObject({
      sourceId: "source-1",
      versionId: "acq-job-warning",
      warnings: ["visual_extraction_enqueue_failed:visual_enqueue_failed"],
    });
  });

  it("does not enqueue visual extraction when the acquired version is not active", async () => {
    const fixture = setupResearchJobWorkflowFixture();
    fixture.acquireRemoteSource.mockResolvedValue({
      kind: "HTML",
      r2Key: "originals/source-1/acq-job-review.html",
      extractedText: "짧지만 실제로 수집된 텍스트입니다.",
      title: "Title",
      contentType: "text/html",
      finalUrl: "https://example.com/article",
      warnings: [],
      textScope: "PARTIAL",
      extractionMethod: "HTML_STATIC",
    });
    fixture.appendAcquisitionVersion.mockResolvedValue({
      versionId: "acq-job-review",
      version: 2,
      qualityStatus: "REVIEW",
    });
    fixture.getActiveVersion
      .mockResolvedValueOnce({ id: "version-1", version: 1 })
      .mockResolvedValueOnce({ id: "version-1", version: 1 });

    const { executeSourceAcquisitionJob, db } = await loadSourceAcquisitionRunner(fixture);
    await executeSourceAcquisitionJob({
      env: { DB: db } as Env,
      job: {
        id: "job-review",
        input: { sourceId: "source-1", url: "https://example.com/article" },
      },
      updateProgress: fixture.updateJobProgress,
    });

    expect(fixture.enqueueResearchJob).not.toHaveBeenCalled();
  });

  it("does not enqueue visual extraction on a reusable active version when an extraction run already exists", async () => {
    const fixture = setupResearchJobWorkflowFixture();
    fixture.findReusableAcquisitionVersion.mockResolvedValue({
      versionId: "acq-job-existing",
      charCount: 2400,
      textScope: "FULLTEXT",
      qualityStatus: "READY",
    });
    fixture.getActiveVersion.mockResolvedValue({ id: "acq-job-existing", version: 2 });
    fixture.hasVisualExtractionRunForVersion.mockResolvedValue(true);

    const { executeSourceAcquisitionJob, db } = await loadSourceAcquisitionRunner(fixture);
    const result = await executeSourceAcquisitionJob({
      env: { DB: db } as Env,
      job: {
        id: "job-existing",
        input: { sourceId: "source-1", url: "https://example.com/article" },
      },
      updateProgress: fixture.updateJobProgress,
    });

    expect(fixture.updateIngestJob).toHaveBeenCalledWith(db, "source-1", "extracted", null);
    expect(fixture.hasVisualExtractionRunForVersion).toHaveBeenCalledWith("acq-job-existing");
    expect(fixture.enqueueResearchJob).not.toHaveBeenCalled();
    expect(result.result.versionId).toBe("acq-job-existing");
  });

  it("retries visual extraction on a reusable active version when no extraction run exists yet", async () => {
    const fixture = setupResearchJobWorkflowFixture();
    fixture.findReusableAcquisitionVersion.mockResolvedValue({
      versionId: "acq-job-retry",
      charCount: 2400,
      textScope: "FULLTEXT",
      qualityStatus: "READY",
    });
    fixture.getActiveVersion.mockResolvedValue({ id: "acq-job-retry", version: 2 });
    fixture.hasVisualExtractionRunForVersion.mockResolvedValue(false);

    const { executeSourceAcquisitionJob, db } = await loadSourceAcquisitionRunner(fixture);
    await executeSourceAcquisitionJob({
      env: { DB: db } as Env,
      job: {
        id: "job-retry",
        input: { sourceId: "source-1", url: "https://example.com/article" },
      },
      updateProgress: fixture.updateJobProgress,
    });

    expect(fixture.hasVisualExtractionRunForVersion).toHaveBeenCalledWith("acq-job-retry");
    expect(fixture.enqueueResearchJob).toHaveBeenCalledWith(
      expect.objectContaining({ DB: db }),
      { kind: "VISUAL_EXTRACTION", input: { sourceId: "source-1", sourceVersionId: "acq-job-retry" } },
      "system:source-acquisition",
    );
  });
});

describe("manual URL extraction compatibility", () => {
  it("blocks direct private network targets before issuing a request", async () => {
    const { fetchAndExtract } = await import("../../../worker/src/ingestion/extractUrl");
    const fetchSpy = vi.fn().mockRejectedValue(new Error("raw_fetch_called"));
    vi.stubGlobal("fetch", fetchSpy);

    await expect(fetchAndExtract("http://127.0.0.1/")).rejects.toThrow("REDIRECT_BLOCKED");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("preserves legacy fields while exposing new extraction metadata", async () => {
    const { fetchAndExtract } = await import("../../../worker/src/ingestion/extractUrl");
    const response = withResponseUrl(
      new Response(
        `<html><head><title>제목 &amp; 테스트</title><meta property="og:site_name" content="Example"></head><body><main><article><p>${"본문 ".repeat(620)}</p></article></main></body></html>`,
        { status: 200, headers: { "content-type": "text/html; charset=utf-8" } },
      ),
      "https://final.example/post",
    );
    vi.stubGlobal("fetch", createSafeFetchStub(response));

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

  it("treats HTML served from a .pdf URL as static HTML text", async () => {
    const { fetchAndExtract } = await import("../../../worker/src/ingestion/extractUrl");
    const response = withResponseUrl(
      new Response(
        `<html><head><title>HTML Landing</title></head><body><main><article><p>${"본문 ".repeat(620)}</p></article></main></body></html>`,
        { status: 200, headers: { "content-type": "text/html; charset=utf-8" } },
      ),
      "https://example.com/paper.pdf",
    );
    vi.stubGlobal("fetch", createSafeFetchStub(response));

    const page = await fetchAndExtract("https://example.com/paper.pdf");

    expect(page.finalUrl).toBe("https://example.com/paper.pdf");
    expect(page.method).toBe("HTML_STATIC");
    expect(page.scope).toBe("FULLTEXT");
    expect(page.text).toContain("본문");
  });

  it("fails oversized HTML bodies with SIZE_LIMIT before calling response.text()", async () => {
    const { fetchAndExtract } = await import("../../../worker/src/ingestion/extractUrl");
    const response = makeStreamResponse([
      new Uint8Array(20 * 1024 * 1024),
      new Uint8Array(1),
    ], {
      "content-type": "text/html; charset=utf-8",
    }, "https://public.example/oversized");
    const textSpy = vi.spyOn(response, "text").mockRejectedValue(new Error("raw_text_called"));
    vi.stubGlobal("fetch", createSafeFetchStub(response));

    await expect(fetchAndExtract("https://public.example/oversized")).rejects.toThrow("SIZE_LIMIT");
    expect(textSpy).not.toHaveBeenCalled();
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

function createSafeFetchStub(documentResponse: Response) {
  return vi.fn((input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url.startsWith("https://cloudflare-dns.com/dns-query")) {
      const recordType = new URL(url).searchParams.get("type");
      const answer = recordType === "AAAA"
        ? [{ type: 28, data: "2606:2800:220:1:248:1893:25c8:1946" }]
        : [{ type: 1, data: "93.184.216.34" }];
      return Promise.resolve(new Response(JSON.stringify({ Status: 0, Answer: answer }), {
        status: 200,
        headers: { "content-type": "application/dns-json" },
      }));
    }
    return Promise.resolve(documentResponse);
  });
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
    findReusableAcquisitionVersion: vi.fn().mockResolvedValue(null),
    getActiveVersion: vi.fn().mockResolvedValue(null),
    hasVisualExtractionRunForVersion: vi.fn().mockResolvedValue(false),
    acquireRemoteSource: vi.fn(),
    appendAcquisitionVersion: vi.fn(),
    updateIngestJob: vi.fn(),
    updateJobProgress: vi.fn(),
    enqueueResearchJob: vi.fn().mockResolvedValue({ job: { id: "visual-job" }, reused: false }),
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
  vi.doMock("../../../worker/src/jobs/enqueue", () => ({
    enqueueResearchJob: fixture.enqueueResearchJob,
  }));
  const db = {
    prepare(query: string) {
      let params: unknown[] = [];
      return {
        bind(...values: unknown[]) {
          params = values;
          return this;
        },
        async first() {
          if (query.includes("FROM source_versions v")) return fixture.findReusableAcquisitionVersion(...params);
          if (query.includes("FROM visual_extraction_runs")) {
            return await fixture.hasVisualExtractionRunForVersion(...params) ? { id: "run-1" } : null;
          }
          return null;
        },
      };
    },
  } as unknown as D1Database;

  const mod = await import("../../../worker/src/workflows/sourceAcquisition");

  return { executeSourceAcquisitionJob: mod.executeSourceAcquisitionJob, db };
}
