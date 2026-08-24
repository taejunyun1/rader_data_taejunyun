import { expect, test, type Page } from "@playwright/test";

async function installWorkspaceFixture(page: Page) {
  const items = Array.from({ length: 40 }, (_, index) => ({
    id: `source-${index + 1}`,
    title: `자료 ${index + 1}`,
    kind: "PAPER_ACADEMIC",
    reliability: "PRIMARY",
    status: "indexed",
    origin: "upload",
    year: 2026,
    canonicalUrl: index === 0 ? null : `https://example.com/${index + 1}`,
    createdAt: "2026-08-24T00:00:00.000Z",
    topics: "[]",
    keywordCount: 0,
    signalCount: 0,
    markedForNextResearch: 0,
    decisionStatus: null,
  }));

  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/usage/summary") return route.fulfill({ json: { usedUsd: 1, budgetUsd: 10, usedPct: 10, blocked: false } });
    if (url.pathname === "/api/jobs") return route.fulfill({ json: { jobs: [] } });
    if (url.pathname === "/api/radar/stats") return route.fulfill({ json: { stats: { newSources: 0, newKeywords: [], newQuestions: [], signalCounts: {}, topKeptSources: [], distillRuns: 0, gapsRaised: 0, readingQueueSize: 0, kindBreakdown: {} } } });
    if (url.pathname === "/api/radar/snapshots") return route.fulfill({ json: { snapshots: [] } });
    if (url.pathname === "/api/distill/sessions") return route.fulfill({ json: { sessions: [] } });
    if (url.pathname === "/api/reservoir/topics") return route.fulfill({ json: { topics: [] } });
    if (url.pathname === "/api/reservoir") return route.fulfill({ json: { items, nextResearch: { markedCount: 0, lastResearchAt: null } } });
    if (/^\/api\/reservoir\/source-\d+$/.test(url.pathname)) {
      const item = items.find((entry) => url.pathname.endsWith(entry.id)) ?? items[0]!;
      return route.fulfill({ json: {
        source: { ...item, provenanceClass: "SOURCE" },
        acquisition: { textScope: "FULLTEXT", extractionMethod: "HTML_STATIC", qualityStatus: "READY", charCount: 2400, acquisitionLabel: "원문 저장됨 · 2,400자", canDeepAnalyze: true, originalTextUrl: `${url.pathname}/original-text` },
        analysis: { summary: `${item.title} 요약`, keywords: ["사진"], questions: ["어떻게 읽을까"], important_fragments: ["핵심 문장"] },
        deepAnalysis: null,
        deepAnalysisHistory: [],
        keywords: [],
        questions: [],
        fragments: [],
        versions: [],
        signals: [],
      } });
    }
    if (url.pathname === "/api/signals") return route.fulfill({ json: { ok: true } });
    return route.fulfill({ status: 404, json: { error: "fixture_route_missing" } });
  });
}

async function openReservoir(page: Page) {
  await page.getByRole("navigation").getByRole("button", { name: /저장소/ }).click();
}

test("reservoir preserves both panes while the list scrolls", async ({ page }) => {
  await installWorkspaceFixture(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await openReservoir(page);

  const listPane = page.getByRole("region", { name: "자료 목록" });
  const readingPane = page.getByRole("region", { name: "자료 읽기" });
  await listPane.evaluate((element) => { element.scrollTop = element.scrollHeight; });

  await expect(readingPane.getByText("읽을 자료를 선택하세요")).toBeVisible();
  await expect(listPane).toHaveCSS("overflow-y", "auto");
  await expect(readingPane).toHaveCSS("overflow-y", "auto");
});

test("sticky header is opaque", async ({ page }) => {
  await installWorkspaceFixture(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await openReservoir(page);

  await expect(page.locator(".page-header")).toHaveCSS("background-color", "rgb(255, 255, 255)");
});

test("mobile filter controls keep a single scrollable row", async ({ page }) => {
  await installWorkspaceFixture(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await openReservoir(page);

  await expect(page.locator(".filter-strip").first()).toHaveCSS("flex-wrap", "nowrap");
  await expect(page.locator(".filter-button").first()).toHaveCSS("min-height", "44px");
});

test("mobile switches between list and reading without stacking both panes", async ({ page }) => {
  await installWorkspaceFixture(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await openReservoir(page);
  await expect(page.getByRole("region", { name: "자료 목록" })).toBeVisible();
  await expect(page.getByRole("region", { name: "자료 읽기" })).toBeHidden();

  await page.getByRole("region", { name: "자료 목록" }).getByRole("button", { name: /자료 1 · 접근 경로 확인 필요/ }).click();
  await expect(page.getByRole("region", { name: "자료 읽기" })).toBeVisible();
  await expect(page.getByRole("region", { name: "자료 목록" })).toBeHidden();
  await expect(page.getByRole("dialog", { name: "읽은 뒤 판단" })).toHaveCount(0);

  await page.getByRole("button", { name: "목록으로" }).click();
  await expect(page.getByRole("region", { name: "자료 목록" })).toBeVisible();
});
