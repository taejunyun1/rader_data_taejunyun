import { expect, test, type Page } from "@playwright/test";

async function installWorkspaceFixture(page: Page) {
  const detailParagraph = "사진의 물질성과 유통 경로를 함께 읽기 위한 고정 길이의 분석 문장입니다. ";
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
    if (url.pathname === "/api/reservoir/topics") return route.fulfill({ json: { topics: Array.from({ length: 14 }, (_, index) => ({ topic: `장기 연구 주제 ${index + 1}`, count: index + 1 })) } });
    if (url.pathname === "/api/reservoir") return route.fulfill({ json: { items, nextResearch: { markedCount: 0, lastResearchAt: null } } });
    if (/^\/api\/reservoir\/source-\d+$/.test(url.pathname)) {
      const item = items.find((entry) => url.pathname.endsWith(entry.id)) ?? items[0]!;
      return route.fulfill({ json: {
        source: { ...item, provenanceClass: "SOURCE" },
        acquisition: { textScope: "FULLTEXT", extractionMethod: "HTML_STATIC", qualityStatus: "READY", charCount: 2400, acquisitionLabel: "원문 저장됨 · 2,400자", canDeepAnalyze: true, originalTextUrl: `${url.pathname}/original-text` },
        analysis: {
          summary: `${item.title} 요약 ${detailParagraph.repeat(12)}`,
          keywords: ["사진", "물질성", "유통"],
          questions: Array.from({ length: 12 }, (_, index) => `${index + 1}. ${detailParagraph.repeat(2)}`),
          important_fragments: Array.from({ length: 16 }, (_, index) => `${index + 1}. ${detailParagraph.repeat(3)}`),
        },
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

test("reservoir keeps the desktop workspace within the viewport while each pane scrolls independently", async ({ page }) => {
  await installWorkspaceFixture(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await openReservoir(page);

  const listPane = page.getByRole("region", { name: "자료 목록" });
  const readingPane = page.getByRole("region", { name: "자료 읽기" });
  await listPane.getByRole("button", { name: /자료 1 · 접근 경로 확인 필요/ }).click();
  await expect(readingPane.getByRole("heading", { name: "자료 1" })).toBeVisible();
  const workspace = page.getByTestId("split-workspace");
  const viewport = page.viewportSize();
  const workspaceBox = await workspace.boundingBox();
  expect(viewport).not.toBeNull();
  expect(workspaceBox).not.toBeNull();
  expect(workspaceBox!.y).toBeGreaterThan(72);
  expect(workspaceBox!.y + workspaceBox!.height).toBeLessThanOrEqual(viewport!.height + 1);

  await listPane.hover();
  await page.mouse.wheel(0, 700);
  await expect.poll(() => listPane.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  await expect.poll(() => readingPane.evaluate((element) => element.scrollTop)).toBe(0);

  const listScrollTop = await listPane.evaluate((element) => element.scrollTop);
  await readingPane.hover();
  await page.mouse.wheel(0, 700);
  await expect.poll(() => readingPane.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  await expect.poll(() => listPane.evaluate((element) => element.scrollTop)).toBe(listScrollTop);
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

test("mobile keeps the header sticky and filter controls horizontally scrollable", async ({ page }) => {
  await installWorkspaceFixture(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await openReservoir(page);

  await expect(page.locator(".page-header")).toHaveCSS("position", "sticky");
  await expect(page.locator(".filter-strip").first()).toHaveCSS("flex-wrap", "nowrap");
  await expect(page.locator(".filter-strip").first()).toHaveCSS("overflow-x", "auto");
  await expect(page.locator(".topic-strip")).toHaveCSS("flex-wrap", "nowrap");
  await expect(page.locator(".topic-strip")).toHaveCSS("overflow-x", "auto");
  await expect(page.locator(".filter-button").first()).toHaveCSS("min-height", "44px");
  await expect(page.locator(".topic-strip > .topic-chip").first()).toHaveCSS("min-height", "44px");
  await expect(page.locator(".reservoir-search")).toHaveCSS("min-height", "44px");

  await page.getByRole("region", { name: "자료 목록" }).getByRole("button", { name: /자료 1 · 접근 경로 확인 필요/ }).click();
  await expect(page.getByRole("combobox", { name: "심층 정리 품질" })).toHaveCSS("min-height", "44px");
  await expect(page.getByRole("button", { name: "심층 정리하기" })).toHaveCSS("min-height", "44px");
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
