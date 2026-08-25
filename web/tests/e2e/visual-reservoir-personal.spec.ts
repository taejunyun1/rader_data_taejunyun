import { expect, test, type Page } from "@playwright/test";

interface VisualAnalysisPayload {
  observation: {
    subject: string[];
    composition: string[];
    color: string[];
    texture: string[];
    spatialRelation: string[];
    material: string[];
    lighting: string[];
    visibleText: string[];
  };
  formal: {
    shapes: string[];
    lines: string[];
    planes: string[];
    rhythm: string[];
    scale: string[];
    density: string[];
    edges: string[];
    contrast: string[];
    perspective: string[];
  };
  context: {
    medium: string[];
    process: string[];
    relationToPhotography: string[];
    culturalReferences: string[];
  };
  propositions: string[];
  uncertainty: string[];
  visualKind: "PHOTO" | "OTHER";
  confidence: number | null;
}

interface VisualAnalysisSummary {
  id: string;
  payload: VisualAnalysisPayload;
  provenanceClass: "INTERPRETATION";
  confidence: number | null;
  reviewStatus: "PENDING" | "ACCEPTED" | "EDITED";
  modelId: string | null;
  promptVersion: string | null;
  createdAt: string;
}

interface VisualAssetSummary {
  id: string;
  parentSourceId: string | null;
  parentVersionId: string | null;
  originKind: "PERSONAL_UPLOAD";
  sourceUrl: string | null;
  pageNumber: number | null;
  figureLabel: string | null;
  caption: string | null;
  visualKind: "PHOTO" | "OTHER";
  selectionStatus: "SELECTED" | "REVIEW";
  selectionReason: string | null;
  rightsStatus: "PERSONAL" | "PERMITTED";
  storageState: "ARCHIVAL" | "CAPSULE" | "TEXT_ONLY";
  pendingStorageState: null;
  processingStatus: "FAILED" | "READY";
  perceptualHash: string | null;
  capsuleVersionId: string | null;
  thumbnailUrl: string | null;
  analysis: VisualAnalysisSummary | null;
  createdAt: string;
  updatedAt: string;
}

interface VisualAssetDetail extends VisualAssetSummary {
  candidateKey: string | null;
  bbox: null;
  nearbyText: string | null;
  rightsBasis: string | null;
  rightsReviewedAt: string | null;
  autoSuggestion: VisualAnalysisSummary | null;
  userVerified: VisualAnalysisSummary | null;
  relations: Array<{
    id: string;
    relationKind: string;
    createdBy: "SYSTEM" | "USER";
    description: string | null;
    toVisualAssetId: string | null;
    relatedSourceId: string | null;
    relatedThreadId: string | null;
    createdAt: string;
  }>;
  extractionRun: null;
}

interface ReservoirSourceDetail {
  source: {
    id: string;
    title: string;
    authors: string;
    kind: string;
    reliability: string;
    status: string;
    origin: string;
    year: number;
    canonicalUrl: string | null;
    provenanceClass: "SOURCE";
    createdAt: string;
    markedForNextResearch: number;
    decisionStatus: null;
    inputFormat: "URL_HTML";
    activeVersionId: string;
  };
  acquisition: {
    textScope: "FULLTEXT";
    extractionMethod: "HTML_STATIC";
    qualityStatus: "READY";
    charCount: number;
    acquisitionLabel: string;
    canDeepAnalyze: boolean;
    originalTextUrl: string | null;
  };
  analysis: {
    summary: string;
    keywords: string[];
    questions: string[];
    important_fragments: string[];
  } | null;
  deepAnalysis: null;
  deepAnalysisHistory: Array<{
    id: string;
    model?: string;
    createdAt: string;
    costUsd?: number;
  }>;
  keywords: Array<{ keyword: string; weight: number }>;
  questions: Array<{ question: string; status: string }>;
  fragments: Array<{ text: string }>;
  versions: Array<{ version: number; char_count: number; created_at: string }>;
  signals: Array<{ action: string; created_at: string }>;
  visuals: VisualAssetSummary[];
}

function buildAnalysis(seed: string, reviewStatus: VisualAnalysisSummary["reviewStatus"]): VisualAnalysisSummary {
  return {
    id: `analysis-${seed}-${reviewStatus.toLowerCase()}`,
    payload: {
      observation: {
        subject: [`${seed} 피사체`],
        composition: [`${seed} 구도`],
        color: [],
        texture: [],
        spatialRelation: [],
        material: [],
        lighting: [],
        visibleText: [],
      },
      formal: {
        shapes: [`${seed} 형태`],
        lines: [],
        planes: [],
        rhythm: [],
        scale: [],
        density: [],
        edges: [],
        contrast: [],
        perspective: [],
      },
      context: {
        medium: [`${seed} 매체`],
        process: [],
        relationToPhotography: [`${seed} 사진 맥락`],
        culturalReferences: [],
      },
      propositions: [`${seed} 제안`],
      uncertainty: [`${seed} 불확실성`],
      visualKind: "PHOTO",
      confidence: reviewStatus === "PENDING" ? 0.8 : null,
    },
    provenanceClass: "INTERPRETATION",
    confidence: reviewStatus === "PENDING" ? 0.8 : null,
    reviewStatus,
    modelId: reviewStatus === "PENDING" ? "vision-low" : null,
    promptVersion: reviewStatus === "PENDING" ? "visual-v1" : null,
    createdAt: "2026-08-25T11:05:00.000Z",
  };
}

function pngFixture(): Buffer {
  return Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wn0c4kAAAAASUVORK5CYII=",
    "base64",
  );
}

function readingApiDefaults(pathname: string) {
  if (pathname === "/api/usage/summary") {
    return { usedUsd: 1, budgetUsd: 10, usedPct: 10, blocked: false };
  }
  if (pathname === "/api/jobs") return { jobs: [] };
  if (pathname === "/api/radar/stats") {
    return {
      stats: {
        newSources: 0,
        newKeywords: [],
        newQuestions: [],
        signalCounts: {},
        topKeptSources: [],
        distillRuns: 0,
        gapsRaised: 0,
        readingQueueSize: 0,
        kindBreakdown: {},
      },
    };
  }
  if (pathname === "/api/radar/snapshots") return { snapshots: [] };
  if (pathname === "/api/distill/sessions") return { sessions: [] };
  if (pathname === "/api/reservoir/topics") return { topics: [] };
  return null;
}

async function installPersonalFixture(page: Page) {
  let uploadCount = 0;
  let rightsCalls = 0;
  let storageCalls = 0;
  let assignmentCalls = 0;
  let retryCalls = 0;
  let analysisAcceptCalls = 0;

  const sourceVisuals: VisualAssetSummary[] = [];
  const baseSummary: VisualAssetSummary = {
    id: "asset-uploaded",
    parentSourceId: null,
    parentVersionId: null,
    originKind: "PERSONAL_UPLOAD",
    sourceUrl: null,
    pageNumber: null,
    figureLabel: null,
    caption: "개인 업로드 이미지",
    visualKind: "PHOTO",
    selectionStatus: "REVIEW",
    selectionReason: "visual-filter-v1:retry_pending",
    rightsStatus: "PERSONAL",
    storageState: "ARCHIVAL",
    pendingStorageState: null,
    processingStatus: "FAILED",
    perceptualHash: "hash-personal",
    capsuleVersionId: "capsule-1",
    thumbnailUrl: "/fixtures/personal-thumb.png",
    analysis: buildAnalysis("개인 AI", "PENDING"),
    createdAt: "2026-08-25T11:00:00.000Z",
    updatedAt: "2026-08-25T11:00:00.000Z",
  };
  const state = {
    unassignedVisible: false,
    summary: { ...baseSummary },
    detail: {
      ...baseSummary,
      candidateKey: null,
      bbox: null,
      nearbyText: null,
      rightsBasis: "개인 작업 업로드",
      rightsReviewedAt: "2026-08-25T11:01:00.000Z",
      autoSuggestion: buildAnalysis("개인 AI", "PENDING"),
      userVerified: null,
      relations: [],
      extractionRun: null,
    } as VisualAssetDetail,
  };

  function sourceDetail(): ReservoirSourceDetail {
    return {
      source: {
        id: "source-a",
        title: "자료 A",
        authors: "Fixture Author",
        kind: "NOTE",
        reliability: "PRIMARY",
        status: "indexed",
        origin: "upload",
        year: 2026,
        canonicalUrl: "https://example.com/note",
        provenanceClass: "SOURCE",
        createdAt: "2026-08-25T10:50:00.000Z",
        markedForNextResearch: 0,
        decisionStatus: null,
        inputFormat: "URL_HTML",
        activeVersionId: "version-source-a",
      },
      acquisition: {
        textScope: "FULLTEXT",
        extractionMethod: "HTML_STATIC",
        qualityStatus: "READY",
        charCount: 1800,
        acquisitionLabel: "원문 저장됨 · 1,800자",
        canDeepAnalyze: true,
        originalTextUrl: "/api/reservoir/source-a/original-text",
      },
      analysis: {
        summary: "자료 A의 읽기 요약",
        keywords: ["assignment"],
        questions: ["Which personal image belongs here?"],
        important_fragments: ["The source stays selected while the image is reassigned."],
      },
      deepAnalysis: null,
      deepAnalysisHistory: [],
      keywords: [],
      questions: [],
      fragments: [],
      versions: [],
      signals: [],
      visuals: sourceVisuals.slice(),
    };
  }

  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const defaults = readingApiDefaults(url.pathname);
    if (defaults) {
      await route.fulfill({ json: defaults });
      return;
    }
    if (url.pathname === "/api/inbox") {
      await route.fulfill({ json: { items: [] } });
      return;
    }
    if (url.pathname === "/api/visual-assets" && request.method() === "POST") {
      uploadCount += 1;
      state.unassignedVisible = true;
      await route.fulfill({
        status: 202,
        json: {
          ok: true,
          asset: state.summary,
          originalVersionId: "original-1",
          jobId: "job-visual-transform",
        },
      });
      return;
    }
    if (url.pathname === "/api/visual-assets" && url.searchParams.get("unassigned") === "1") {
      await route.fulfill({ json: { items: state.unassignedVisible ? [state.summary] : [] } });
      return;
    }
    if (url.pathname === "/api/reservoir") {
      await route.fulfill({
        json: {
          items: [{
            id: "source-a",
            title: "자료 A",
            kind: "NOTE",
            reliability: "PRIMARY",
            status: "indexed",
            origin: "upload",
            year: 2026,
            canonicalUrl: "https://example.com/note",
            activeVersionId: "version-source-a",
            createdAt: "2026-08-25T10:50:00.000Z",
            topics: "[]",
            keywordCount: 0,
            signalCount: 0,
            markedForNextResearch: 0,
            decisionStatus: null,
          }],
          nextResearch: { markedCount: 0, lastResearchAt: null },
        },
      });
      return;
    }
    if (url.pathname === "/api/reservoir/source-a") {
      await route.fulfill({ json: sourceDetail() });
      return;
    }
    if (url.pathname === "/api/reservoir/source-a/original-text") {
      await route.fulfill({ body: "자료 A의 정규화 원문", contentType: "text/plain; charset=utf-8" });
      return;
    }
    if (url.pathname === "/api/signals" && request.method() === "POST") {
      await route.fulfill({ json: { ok: true } });
      return;
    }
    if (url.pathname === "/api/visual-assets/asset-uploaded") {
      await route.fulfill({ json: { asset: state.detail } });
      return;
    }
    if (url.pathname === "/api/visual-assets/asset-uploaded/retry" && request.method() === "POST") {
      retryCalls += 1;
      state.summary = {
        ...state.summary,
        processingStatus: "READY",
        updatedAt: "2026-08-25T11:06:00.000Z",
      };
      state.detail = {
        ...state.detail,
        processingStatus: "READY",
        updatedAt: "2026-08-25T11:06:00.000Z",
      };
      await route.fulfill({ status: 202, json: { ok: true } });
      return;
    }
    if (url.pathname === "/api/visual-assets/asset-uploaded/analysis" && request.method() === "PATCH") {
      const body = JSON.parse(request.postData() ?? "{}") as { action?: string };
      if (body.action === "accept") {
        analysisAcceptCalls += 1;
        const verified = buildAnalysis("개인 검증", "ACCEPTED");
        state.summary = {
          ...state.summary,
          processingStatus: "READY",
          analysis: verified,
          updatedAt: "2026-08-25T11:07:00.000Z",
        };
        state.detail = {
          ...state.detail,
          processingStatus: "READY",
          analysis: verified,
          autoSuggestion: state.detail.autoSuggestion,
          userVerified: verified,
          updatedAt: "2026-08-25T11:07:00.000Z",
        };
      }
      await route.fulfill({ json: { asset: state.summary } });
      return;
    }
    if (url.pathname === "/api/visual-assets/asset-uploaded/rights" && request.method() === "PATCH") {
      rightsCalls += 1;
      state.summary = {
        ...state.summary,
        rightsStatus: "PERMITTED",
        updatedAt: "2026-08-25T11:08:00.000Z",
      };
      state.detail = {
        ...state.detail,
        rightsStatus: "PERMITTED",
        rightsBasis: "Author email permission",
        rightsReviewedAt: "2026-08-25T11:08:00.000Z",
        updatedAt: "2026-08-25T11:08:00.000Z",
      };
      await route.fulfill({ json: { asset: state.summary } });
      return;
    }
    if (url.pathname === "/api/visual-assets/asset-uploaded/storage-transition" && request.method() === "POST") {
      storageCalls += 1;
      const body = JSON.parse(request.postData() ?? "{}") as { target?: string };
      if (body.target === "CAPSULE") {
        state.summary = {
          ...state.summary,
          storageState: "CAPSULE",
          updatedAt: "2026-08-25T11:09:00.000Z",
        };
        state.detail = {
          ...state.detail,
          storageState: "CAPSULE",
          updatedAt: "2026-08-25T11:09:00.000Z",
        };
      } else if (body.target === "TEXT_ONLY") {
        state.summary = {
          ...state.summary,
          storageState: "TEXT_ONLY",
          thumbnailUrl: null,
          updatedAt: "2026-08-25T11:10:00.000Z",
        };
        state.detail = {
          ...state.detail,
          storageState: "TEXT_ONLY",
          thumbnailUrl: null,
          updatedAt: "2026-08-25T11:10:00.000Z",
        };
      }
      await route.fulfill({ json: { asset: state.summary } });
      return;
    }
    if (url.pathname === "/api/visual-assets/asset-uploaded/assignment" && request.method() === "PATCH") {
      assignmentCalls += 1;
      state.unassignedVisible = false;
      state.summary = {
        ...state.summary,
        parentSourceId: "source-a",
        parentVersionId: "version-source-a",
        updatedAt: "2026-08-25T11:11:00.000Z",
      };
      state.detail = {
        ...state.detail,
        parentSourceId: "source-a",
        parentVersionId: "version-source-a",
        updatedAt: "2026-08-25T11:11:00.000Z",
      };
      sourceVisuals.splice(0, sourceVisuals.length, state.summary);
      await route.fulfill({ json: { asset: state.summary } });
      return;
    }
    await route.fulfill({ status: 404, json: { error: `unhandled:${url.pathname}` } });
  });

  return {
    counts: () => ({
      uploadCount,
      rightsCalls,
      storageCalls,
      assignmentCalls,
      retryCalls,
      analysisAcceptCalls,
    }),
  };
}

async function openReservoir(page: Page) {
  await page.getByRole("navigation").getByRole("button", { name: "저장소", exact: true }).click();
  await page.getByRole("region", { name: "자료 목록" }).getByRole("button", { name: /자료 A/ }).click();
}

test("personal visual flow covers upload, retry, verified analysis, rights and storage transitions, and assignment", async ({ page }) => {
  const fixture = await installPersonalFixture(page);

  await page.goto("/");
  await page.getByRole("navigation").getByRole("button", { name: "받은 자료", exact: true }).click();
  await page.getByRole("tab", { name: "이미지" }).click();
  await page.setInputFiles('input[aria-label="이미지 파일"]', {
    name: "personal-visual.png",
    mimeType: "image/png",
    buffer: pngFixture(),
  });
  await expect(page.getByText("1개 업로드 완료")).toBeVisible();
  expect(fixture.counts().uploadCount).toBe(1);

  await openReservoir(page);
  const unassignedSection = page.getByRole("region", { name: "연결되지 않은 시각 자료" });
  await expect(unassignedSection).toBeVisible();
  await unassignedSection.getByRole("button", { name: /개인 업로드 이미지/ }).click();

  let inspector = page.getByRole("complementary", { name: "시각 자료 상세" });
  await expect(inspector).toContainText("FAILED");
  await inspector.getByRole("button", { name: "다시 처리" }).click();
  expect(fixture.counts().retryCalls).toBe(1);
  await inspector.getByRole("button", { name: "닫기" }).click();

  await expect(unassignedSection.getByRole("button", { name: /개인 업로드 이미지/ })).toBeVisible();
  await unassignedSection.getByRole("button", { name: "제안 채택" }).click();
  expect(fixture.counts().analysisAcceptCalls).toBe(1);
  await unassignedSection.getByRole("button", { name: /개인 업로드 이미지/ }).click();

  inspector = page.getByRole("complementary", { name: "시각 자료 상세" });
  await expect(inspector.getByRole("tab", { name: "사용자 검증" })).toHaveAttribute("aria-selected", "true");
  await expect(inspector).toContainText("개인 검증 피사체");

  const rightsResponse = await page.evaluate(async () => {
    const response = await fetch("/api/visual-assets/asset-uploaded/rights", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rightsStatus: "PERMITTED", rightsBasis: "Author email permission" }),
    });
    return { status: response.status, body: await response.json() };
  });
  expect(rightsResponse.status).toBe(200);
  expect(fixture.counts().rightsCalls).toBe(1);

  const capsuleResponse = await page.evaluate(async () => {
    const response = await fetch("/api/visual-assets/asset-uploaded/storage-transition", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ target: "CAPSULE", confirmation: "DELETE_ORIGINAL" }),
    });
    return { status: response.status, body: await response.json() };
  });
  expect(capsuleResponse.status).toBe(200);

  const textOnlyResponse = await page.evaluate(async () => {
    const response = await fetch("/api/visual-assets/asset-uploaded/storage-transition", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ target: "TEXT_ONLY", confirmation: "DELETE_CAPSULE", secondConfirmation: "TEXT_ONLY" }),
    });
    return { status: response.status, body: await response.json() };
  });
  expect(textOnlyResponse.status).toBe(200);
  expect(fixture.counts().storageCalls).toBe(2);

  await inspector.getByRole("button", { name: "닫기" }).click();
  await unassignedSection.getByRole("button", { name: /개인 업로드 이미지/ }).click();
  inspector = page.getByRole("complementary", { name: "시각 자료 상세" });
  await expect(inspector).toContainText("PERMITTED");
  await expect(inspector).toContainText("TEXT_ONLY");
  await expect(inspector).toContainText("권리 근거 · Author email permission");

  await page.getByRole("combobox", { name: "연결할 자료 검색" }).fill("자료 A");
  await page.getByRole("button", { name: "자료 A에 연결" }).click();
  await page.getByRole("button", { name: "이 자료에 연결" }).click();
  expect(fixture.counts().assignmentCalls).toBe(1);

  await expect(page.getByRole("region", { name: "연결되지 않은 시각 자료" })).toHaveCount(0);
  const linkedSection = page.getByRole("region", { name: "시각 자료" });
  await expect(linkedSection.getByRole("button", { name: /개인 업로드 이미지/ })).toBeVisible();
});
