import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/usage/summary") return route.fulfill({ json: { usedUsd: 1, budgetUsd: 10, usedPct: 10, blocked: false } });
    if (url.pathname === "/api/radar/stats") return route.fulfill({ json: { stats: { newSources: 2, newKeywords: [{ keyword: "사진", count: 2 }], newQuestions: ["무엇을 읽을까"], signalCounts: { develop: 1 }, topKeptSources: [], distillRuns: 1, gapsRaised: 1, readingQueueSize: 1, kindBreakdown: { NOTE: 2 } } } });
    if (url.pathname === "/api/reservoir/topics") return route.fulfill({ json: { topics: [] } });
    if (url.pathname === "/api/radar/snapshots") return route.fulfill({ json: { snapshots: [] } });
    if (url.pathname === "/api/distill/sessions") return route.fulfill({ json: { sessions: [] } });
    if (url.pathname === "/api/discover/candidates") return route.fulfill({ json: { items: [{ id: "candidate-1", openalexId: "https://openalex.org/W1", title: "발견 후보", authors: "저자", year: 2026, relevanceScore: 0.9, status: "CANDIDATE", queryUsed: "사진", provider: "openalex", externalUrl: "https://example.com/read" }] } });
    if (url.pathname === "/api/discover/queries") return route.fulfill({ json: { queries: [] } });
    if (url.pathname === "/api/discover/feeds") return route.fulfill({ json: { feeds: [] } });
    if (url.pathname === "/api/settings/homepage") return route.fulfill({ json: { projects: [] } });
    return route.fulfill({ json: { items: [], topics: [], sessions: [] } });
  });
});

test("dashboard to discover preserves the reading-first flow", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "레이더", exact: true })).toBeVisible();
  await expect(page.getByText("상승 신호")).toBeVisible();
  await page.getByRole("button", { name: "발견", exact: true }).click();
  await expect(page.getByRole("heading", { name: "발견", exact: true })).toBeVisible();
  await expect(page.getByRole("option", { name: /발견 후보/ })).toBeVisible();
  await page.getByRole("option", { name: /발견 후보/ }).click();
  await expect(page.getByText("분석 내용 없음")).toBeVisible();
  await expect(page.getByRole("button", { name: "발전시키기" })).toBeVisible();
});
