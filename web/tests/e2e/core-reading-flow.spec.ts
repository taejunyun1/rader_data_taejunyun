import { expect, test, type Page } from "@playwright/test";

interface AcquisitionFixture {
  candidateId: string;
  sourceId: string;
  jobId: string;
  title: string;
  externalUrl: string;
  textScope: "FULLTEXT" | "METADATA_ONLY";
  extractionMethod: "HTML_STATIC" | "PDF_REMOTE_TO_MARKDOWN" | "DISCOVERY_METADATA";
  qualityStatus: "READY" | "REVIEW";
  charCount: number;
  originalText: string | null;
  jobStatus: "SUCCEEDED" | "FAILED";
  errorCode?: string;
  jobError?: string;
}

async function installAcquisitionFixture(page: Page, fixture: AcquisitionFixture) {
  await page.unroute("**/api/**");
  let kept = false;

  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    const method = route.request().method();
    const candidate = {
      id: fixture.candidateId,
      openalexId: null,
      title: fixture.title,
      authors: "Fixture Author",
      year: 2026,
      relevanceScore: 0.92,
      status: kept ? "KEPT" : "CANDIDATE",
      queryUsed: "photography",
      provider: "rss",
      externalUrl: fixture.externalUrl,
      accessStatus: "FREE_FULLTEXT",
      sourceId: kept ? fixture.sourceId : null,
    };
    const reservoirItem = {
      id: fixture.sourceId,
      title: fixture.title,
      kind: "DISCOVERY",
      reliability: "DISCOVERY",
      status: "indexed",
      origin: "discovery:rss",
      year: 2026,
      canonicalUrl: fixture.externalUrl,
      createdAt: "2026-08-23T00:00:00.000Z",
      topics: "[]",
      keywordCount: 0,
      signalCount: 0,
    };

    if (url.pathname === "/api/usage/summary") return route.fulfill({ json: { usedUsd: 1, budgetUsd: 10, usedPct: 10, blocked: false } });
    if (url.pathname === "/api/radar/stats") return route.fulfill({ json: { stats: { newSources: 0, newKeywords: [], newQuestions: [], signalCounts: {}, topKeptSources: [], distillRuns: 0, gapsRaised: 0, readingQueueSize: 0, kindBreakdown: {} } } });
    if (url.pathname === "/api/radar/snapshots") return route.fulfill({ json: { snapshots: [] } });
    if (url.pathname === "/api/distill/sessions") return route.fulfill({ json: { sessions: [] } });
    if (url.pathname === "/api/jobs" && kept) {
      return route.fulfill({ json: { jobs: [{
        id: fixture.jobId,
        workflowInstanceId: "workflow-fixture",
        kind: "SOURCE_ACQUISITION",
        status: fixture.jobStatus,
        progress: 100,
        message: fixture.jobStatus === "SUCCEEDED" ? "완료" : "작업에 실패했습니다.",
        input: { sourceId: fixture.sourceId, url: fixture.externalUrl },
        result: fixture.jobStatus === "SUCCEEDED" ? { sourceId: fixture.sourceId, textScope: fixture.textScope, charCount: fixture.charCount } : null,
        resultRef: fixture.jobStatus === "SUCCEEDED" ? { view: "RESERVOIR", sourceId: fixture.sourceId, acquisition: true } : null,
        errorCode: fixture.errorCode ?? null,
        error: fixture.jobError ?? null,
        retryOf: null,
        requestedBy: "fixture",
        dedupeKey: `source-acquisition:${fixture.sourceId}:${fixture.externalUrl}`,
        dismissedAt: null,
        createdAt: "2026-08-23T00:00:00.000Z",
        startedAt: "2026-08-23T00:00:01.000Z",
        finishedAt: "2026-08-23T00:00:02.000Z",
        updatedAt: "2026-08-23T00:00:02.000Z",
      }] } });
    }
    if (url.pathname === "/api/jobs") return route.fulfill({ json: { jobs: [] } });
    if (url.pathname === `/api/discover/candidates/${fixture.candidateId}/keep` && method === "POST") {
      kept = true;
      return route.fulfill({ status: 202, json: { ok: true, status: "KEPT", sourceId: fixture.sourceId, jobId: fixture.jobId, acquisitionStatus: "QUEUED" } });
    }
    if (url.pathname === "/api/discover/candidates") {
      const status = url.searchParams.get("status") ?? "CANDIDATE";
      const visible = (!kept && status === "CANDIDATE") || (kept && status === "KEPT");
      return route.fulfill({ json: { items: visible ? [candidate] : [] } });
    }
    if (url.pathname === "/api/discover/signals") return route.fulfill({ json: { items: [] } });
    if (url.pathname === "/api/discover/profile") return route.fulfill({ json: { profile: { original: { keywords: [], strength: 70 }, counter: { keywords: [], strength: 30 }, updatedAt: "" } } });
    if (url.pathname === "/api/discover/recommendations") return route.fulfill({ json: { recommendations: { original: [], counter: [] } } });
    if (url.pathname === "/api/discover/queries") return route.fulfill({ json: { queries: [] } });
    if (url.pathname === "/api/discover/feeds") return route.fulfill({ json: { feeds: [] } });
    if (url.pathname === "/api/settings/homepage") return route.fulfill({ json: { projects: [] } });
    if (url.pathname === "/api/reservoir/topics") return route.fulfill({ json: { topics: [] } });
    if (url.pathname === "/api/reservoir") return route.fulfill({ json: { items: [reservoirItem], nextResearch: { markedCount: 0, lastResearchAt: null } } });
    if (url.pathname === `/api/reservoir/${fixture.sourceId}`) {
      return route.fulfill({ json: {
        source: { ...reservoirItem, provenanceClass: "SOURCE", markedForNextResearch: 0 },
        acquisition: {
          textScope: fixture.textScope,
          extractionMethod: fixture.extractionMethod,
          qualityStatus: fixture.qualityStatus,
          charCount: fixture.charCount,
          acquisitionLabel: fixture.textScope === "FULLTEXT" ? `원문 저장됨 · ${fixture.charCount.toLocaleString("ko-KR")}자` : "메타데이터만 저장됨",
          canDeepAnalyze: fixture.textScope === "FULLTEXT" && fixture.qualityStatus === "READY" && fixture.charCount >= 1_000,
          originalTextUrl: fixture.originalText ? `/api/reservoir/${fixture.sourceId}/original-text` : null,
        },
        analysis: null,
        deepAnalysis: null,
        deepAnalysisHistory: [],
        keywords: [],
        questions: [],
        fragments: [],
        versions: [],
        signals: [],
      } });
    }
    if (url.pathname === `/api/reservoir/${fixture.sourceId}/original-text` && fixture.originalText) {
      return route.fulfill({ body: fixture.originalText, contentType: "text/plain; charset=utf-8" });
    }
    if (url.pathname === "/api/signals" && method === "POST") return route.fulfill({ json: { ok: true } });
    return route.fulfill({ json: { items: [] } });
  });
}

async function keepFixtureCandidate(page: Page, fixture: AcquisitionFixture) {
  await page.goto("/");
  await page.getByRole("button", { name: "발견", exact: true }).click();
  await page.getByRole("button", { name: new RegExp(fixture.title) }).click();
  await page.getByRole("button", { name: "판단하기" }).click();
  await page.getByRole("button", { name: "보관하기" }).click();
}

test.beforeEach(async ({ page }) => {
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/usage/summary") return route.fulfill({ json: { usedUsd: 1, budgetUsd: 10, usedPct: 10, blocked: false } });
    if (url.pathname === "/api/radar/stats") return route.fulfill({ json: { stats: { newSources: 2, newKeywords: [{ keyword: "photography", count: 2 }], newQuestions: ["무엇을 읽을까"], signalCounts: { develop: 2, keep: 1, import: 8, view: 4 }, topKeptSources: [], distillRuns: 1, gapsRaised: 1, readingQueueSize: 1, kindBreakdown: { NOTE: 2, PAPER_ACADEMIC: 1 } } } });
    if (url.pathname === "/api/reservoir/topics") return route.fulfill({ json: { topics: [] } });
    if (url.pathname === "/api/radar/snapshots") return route.fulfill({ json: { snapshots: [] } });
    if (url.pathname === "/api/distill/sessions") return route.fulfill({ json: { sessions: [] } });
    if (url.pathname === "/api/discover/candidates") return route.fulfill({ json: { items: [{ id: "candidate-1", openalexId: "https://openalex.org/W1", title: "발견 후보", authors: "저자", year: 2026, relevanceScore: 0.9, status: "CANDIDATE", queryUsed: "사진", provider: "openalex", externalUrl: "https://example.com/read" }] } });
    if (url.pathname === "/api/discover/signals") return route.fulfill({ json: { items: [{
      id: "signal-1",
      sourceId: "caa-news",
      sourceName: "CAA News",
      externalUrl: "https://www.collegeart.org/news/cfp-photography",
      title: "Call for Papers: Photography and Visual Culture",
      summary: "A conference on photography and image politics.",
      signalType: "CALL_FOR_PAPERS",
      publishedAt: "2026-08-20T00:00:00.000Z",
      eventAt: "2026-09-12T00:00:00.000Z",
      deadlineAt: "2026-08-31T00:00:00.000Z",
      matchedTerms: ["photography"],
      relevanceScore: 0.85,
      status: "NEW",
      createdAt: "2026-08-23T00:00:00.000Z",
      updatedAt: "2026-08-23T00:00:00.000Z",
    }] } });
    if (url.pathname === "/api/discover/queries") return route.fulfill({ json: { queries: [] } });
    if (url.pathname === "/api/discover/feeds") return route.fulfill({ json: { feeds: [] } });
    if (url.pathname === "/api/settings/homepage") return route.fulfill({ json: { projects: [] } });
    return route.fulfill({ json: { items: [], topics: [], sessions: [] } });
  });
});

test("dashboard to discover preserves the reading-first flow", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "레이더", exact: true })).toBeVisible();
  const overview = page.getByRole("region", { name: "이번 주 정량 요약" });
  await expect(overview).toBeVisible();
  await expect(overview.getByRole("heading", { name: "관심 신호" })).toBeVisible();
  await expect(overview.getByRole("heading", { name: "판단 분포" })).toBeVisible();
  await expect(overview.getByRole("heading", { name: "저장소 구성" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "상승 신호" })).toHaveCount(0);
  await page.getByRole("button", { name: "발견", exact: true }).click();
  await expect(page.getByRole("heading", { name: "발견", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /발견 후보/ })).toBeVisible();
  await page.getByRole("button", { name: /발견 후보/ }).click();
  await expect(page.getByText("분석 내용 없음")).toBeVisible();
  const decisionDialog = page.getByRole("dialog", { name: "읽은 뒤 판단" });
  await expect(decisionDialog).toHaveCount(0);
  await page.getByRole("button", { name: "판단하기" }).click();
  await expect(decisionDialog).toBeVisible();
  await expect(decisionDialog.getByRole("button", { name: "발전시키기" })).toBeVisible();
});

test("discover separates reading candidates from field signals", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "발견", exact: true }).click();
  await expect(page.getByRole("button", { name: /발견 후보/ })).toBeVisible();
  await page.getByRole("tab", { name: "현장 신호" }).click();
  await expect(page.getByRole("heading", { name: "Call for Papers: Photography and Visual Culture" })).toBeVisible();
  await expect(page.getByText("CAA News", { exact: true })).toBeVisible();
  await page.getByRole("tab", { name: "읽을거리" }).click();
  await expect(page.getByRole("button", { name: /발견 후보/ })).toBeVisible();
});

test("Discovery Keep acquires an HTML fixture before enabling deep analysis", async ({ page }) => {
  const fixture: AcquisitionFixture = {
    candidateId: "candidate-html",
    sourceId: "source-html",
    jobId: "job-html",
    title: "Static HTML acquisition fixture",
    externalUrl: "https://fixtures.example/article",
    textScope: "FULLTEXT",
    extractionMethod: "HTML_STATIC",
    qualityStatus: "READY",
    charCount: 2_400,
    originalText: "Fixture article body preserved as normalized plain text.",
    jobStatus: "SUCCEEDED",
  };
  await installAcquisitionFixture(page, fixture);
  await keepFixtureCandidate(page, fixture);

  await expect(page.getByText("원문 수집 · 완료")).toBeVisible();
  await expect(page.getByRole("heading", { name: "저장소", exact: true })).toBeVisible();
  await expect(page.getByText("원문 저장됨 · 2,400자")).toBeVisible();
  await expect(page.getByText("원문 범위 FULLTEXT · 수집 방식 HTML_STATIC · 품질 READY")).toBeVisible();
  await expect(page.getByRole("button", { name: "심층 정리하기" })).toBeEnabled();
  await page.getByText("저장된 원문 보기").click();
  await expect(page.getByText("Fixture article body preserved as normalized plain text.")).toBeVisible();
});

test("Discovery Keep exposes remote PDF toMarkdown provenance", async ({ page }) => {
  const fixture: AcquisitionFixture = {
    candidateId: "candidate-pdf",
    sourceId: "source-pdf",
    jobId: "job-pdf",
    title: "Remote PDF acquisition fixture",
    externalUrl: "https://fixtures.example/paper.pdf",
    textScope: "FULLTEXT",
    extractionMethod: "PDF_REMOTE_TO_MARKDOWN",
    qualityStatus: "READY",
    charCount: 4_200,
    originalText: "Fixture PDF converted to normalized Markdown text.",
    jobStatus: "SUCCEEDED",
  };
  await installAcquisitionFixture(page, fixture);
  await keepFixtureCandidate(page, fixture);

  await expect(page.getByText("원문 수집 · 완료")).toBeVisible();
  await expect(page.getByRole("heading", { name: "저장소", exact: true })).toBeVisible();
  await expect(page.getByText("원문 범위 FULLTEXT · 수집 방식 PDF_REMOTE_TO_MARKDOWN · 품질 READY")).toBeVisible();
  await expect(page.getByRole("button", { name: "심층 정리하기" })).toBeEnabled();
  await page.getByText("저장된 원문 보기").click();
  await expect(page.getByText("Fixture PDF converted to normalized Markdown text.")).toBeVisible();
});

test("a JS-shell acquisition failure leaves the metadata-only source blocked from deep analysis", async ({ page }) => {
  const fixture: AcquisitionFixture = {
    candidateId: "candidate-shell",
    sourceId: "source-shell",
    jobId: "job-shell",
    title: "JavaScript shell fixture",
    externalUrl: "https://fixtures.example/js-shell",
    textScope: "METADATA_ONLY",
    extractionMethod: "DISCOVERY_METADATA",
    qualityStatus: "REVIEW",
    charCount: 0,
    originalText: null,
    jobStatus: "FAILED",
    errorCode: "workflow_runtime_failed",
    jobError: "EXTRACTION_EMPTY",
  };
  await installAcquisitionFixture(page, fixture);
  await keepFixtureCandidate(page, fixture);

  const jobCenter = page.getByLabel("백그라운드 작업");
  await expect(jobCenter.getByText("원문 수집 · 실패")).toBeVisible();
  await expect(jobCenter.getByText("EXTRACTION_EMPTY")).toBeVisible();
  await page.getByRole("button", { name: "저장소", exact: true }).click();
  await page.getByRole("button", { name: new RegExp(fixture.title) }).click();
  const readingPane = page.getByRole("region", { name: "자료 읽기" });
  await expect(readingPane.getByText("원문 범위 METADATA_ONLY · 수집 방식 DISCOVERY_METADATA · 품질 REVIEW")).toBeVisible();
  await expect(readingPane.getByText("메타데이터만 저장됨", { exact: true })).not.toHaveAttribute("title", /.+/);
  await expect(readingPane.getByText("저장된 원문 보기")).toHaveCount(0);
  await page.getByRole("button", { name: "판단하기" }).click();
  const decisionDialog = page.getByRole("dialog", { name: "읽은 뒤 판단" });
  await expect(decisionDialog.getByRole("button", { name: "다시 가져오기" })).toBeEnabled();
  await decisionDialog.getByRole("button", { name: "닫기", exact: true }).click();
  await expect(readingPane.getByRole("heading", { name: "원문 수집 후 시각 자료 확인" })).toBeVisible();
  const acquisitionButtons = readingPane.getByRole("button", { name: "원문 다시 가져오기" });
  await expect(acquisitionButtons).toHaveCount(2);
  await expect(acquisitionButtons.nth(0)).toBeEnabled();
  await expect(acquisitionButtons.nth(1)).toBeEnabled();
  await expect(page.getByText(/메타데이터만 저장되어 심층 정리를 시작할 수 없습니다/)).toBeVisible();
});
