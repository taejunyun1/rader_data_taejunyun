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
  visualKind: "PHOTO" | "GRAPHIC" | "DOCUMENT_SCAN" | "OTHER";
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
  originKind: "WEB_EMBED" | "PDF_PAGE_CROP";
  sourceUrl: string | null;
  pageNumber: number | null;
  figureLabel: string | null;
  caption: string | null;
  visualKind: "PHOTO" | "GRAPHIC" | "DOCUMENT_SCAN" | "OTHER";
  selectionStatus: "SELECTED" | "REVIEW" | "DECORATIVE" | "DUPLICATE" | "UNAVAILABLE";
  selectionReason: string | null;
  rightsStatus: "PERSONAL" | "PERMITTED" | "PUBLIC_LINK" | "UNKNOWN" | "RESTRICTED";
  storageState: "ARCHIVAL" | "CAPSULE" | "TEXT_ONLY" | "LINK_ONLY";
  pendingStorageState: null;
  processingStatus: "READY" | "FAILED";
  perceptualHash: string | null;
  capsuleVersionId: string | null;
  thumbnailUrl: string | null;
  analysis: VisualAnalysisSummary | null;
  createdAt: string;
  updatedAt: string;
}

interface VisualAssetDetail extends VisualAssetSummary {
  candidateKey: string | null;
  bbox: { x: number; y: number; width: number; height: number; page?: number | null } | null;
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
  extractionRun: {
    id: string;
    parentSourceId: string;
    parentVersionId: string;
    originKind: "WEB_EMBED" | "PDF_PAGE_CROP";
    status: "SUCCEEDED" | "PARTIAL" | "QUEUED";
    totalUnits: number;
    uploadedUnits: number;
    processedUnits: number;
    selectedCount: number;
    reviewCount: number;
    filteredCount: number;
    unavailableCount: number;
    errorCode: string | null;
    error: string | null;
    createdAt: string;
    updatedAt: string;
    finishedAt: string | null;
  } | null;
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
    inputFormat: "URL_HTML" | "PDF_TEXT";
    activeVersionId: string;
  };
  acquisition: {
    textScope: "FULLTEXT";
    extractionMethod: "HTML_STATIC" | "PDF_REMOTE_TO_MARKDOWN";
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
  visualExtractionRun: VisualAssetDetail["extractionRun"];
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
        visibleText: [`${seed} 텍스트`],
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
      confidence: reviewStatus === "PENDING" ? 0.72 : null,
    },
    provenanceClass: "INTERPRETATION",
    confidence: reviewStatus === "PENDING" ? 0.72 : null,
    reviewStatus,
    modelId: reviewStatus === "PENDING" ? "vision-low" : null,
    promptVersion: reviewStatus === "PENDING" ? "visual-v1" : null,
    createdAt: "2026-08-25T09:30:00.000Z",
  };
}

function buildMultiPagePdf(pageCount: number): Buffer {
  const objects: string[] = [];
  const kids: string[] = [];
  const fontObjectNumber = pageCount * 2 + 3;

  objects.push("1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj");
  for (let pageIndex = 0; pageIndex < pageCount; pageIndex += 1) {
    const pageObjectNumber = 3 + pageIndex * 2;
    const contentObjectNumber = pageObjectNumber + 1;
    kids.push(`${pageObjectNumber} 0 R`);
    objects.push(
      `${pageObjectNumber} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 400] /Contents ${contentObjectNumber} 0 R /Resources << /Font << /F1 ${fontObjectNumber} 0 R >> >> >>\nendobj`,
    );
    const stream = `BT /F1 12 Tf 36 360 Td (Page ${pageIndex + 1}) Tj ET`;
    objects.push(
      `${contentObjectNumber} 0 obj\n<< /Length ${Buffer.byteLength(stream, "utf8")} >>\nstream\n${stream}\nendstream\nendobj`,
    );
  }
  objects.splice(1, 0, `2 0 obj\n<< /Type /Pages /Kids [${kids.join(" ")}] /Count ${pageCount} >>\nendobj`);
  objects.push(`${fontObjectNumber} 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj`);

  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (const object of objects) {
    offsets.push(Buffer.byteLength(pdf, "utf8"));
    pdf += `${object}\n`;
  }
  const xrefOffset = Buffer.byteLength(pdf, "utf8");
  pdf += `xref\n0 ${objects.length + 1}\n`;
  pdf += "0000000000 65535 f \n";
  for (let index = 1; index <= objects.length; index += 1) {
    pdf += `${String(offsets[index]).padStart(10, "0")} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;
  return Buffer.from(pdf, "utf8");
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

interface WebPdfFixtureOptions {
  pdfPageCount?: number;
  initialPdfCleanupError?: string | null;
}

interface PdfRequestTrace {
  method: string;
  pathname: string;
  body: unknown;
}

async function installWebPdfFixture(page: Page, options: WebPdfFixtureOptions = {}) {
  const pdfPageCount = options.pdfPageCount ?? 41;
  const initialPdfCleanupError = Object.prototype.hasOwnProperty.call(options, "initialPdfCleanupError")
    ? options.initialPdfCleanupError ?? null
    : "cleanup_retry_pending";
  const pdfBytes = buildMultiPagePdf(pdfPageCount);
  let htmlLogoRecovered = false;
  let deepAnalysisBlocked = false;
  let pdfRunId = "run-pdf-1";
  const pdfUploadedPages = new Set<number>();
  let pdfFinalized = false;
  let secondPageUploadAttempt = 0;
  let abortSecondPageUpload = false;
  let releaseSecondPageUpload: (() => void) | null = null;
  let resolveSecondPageUploadSeen: (() => void) | null = null;
  const secondPageUploadSeen = new Promise<void>((resolve) => {
    resolveSecondPageUploadSeen = resolve;
  });
  const pdfTrace: PdfRequestTrace[] = [];

  const htmlVisibleAsset: VisualAssetSummary = {
    id: "asset-html-link",
    parentSourceId: "source-html",
    parentVersionId: "version-source-html",
    originKind: "WEB_EMBED",
    sourceUrl: "https://example.com/articles/visuals#figure-1",
    pageNumber: null,
    figureLabel: "Figure 1",
    caption: "Infrared installation view",
    visualKind: "PHOTO",
    selectionStatus: "SELECTED",
    selectionReason: "visual-filter-v1:selected_contextual_figure",
    rightsStatus: "UNKNOWN",
    storageState: "LINK_ONLY",
    pendingStorageState: null,
    processingStatus: "READY",
    perceptualHash: "hash-html-visible",
    capsuleVersionId: null,
    thumbnailUrl: null,
    analysis: buildAnalysis("AI", "PENDING"),
    createdAt: "2026-08-25T09:30:00.000Z",
    updatedAt: "2026-08-25T09:30:00.000Z",
  };
  const htmlRecoveredAsset: VisualAssetSummary = {
    id: "asset-html-logo",
    parentSourceId: "source-html",
    parentVersionId: "version-source-html",
    originKind: "WEB_EMBED",
    sourceUrl: "https://example.com/assets/logo-mark.svg",
    pageNumber: null,
    figureLabel: "Figure 3",
    caption: "사이트 로고",
    visualKind: "GRAPHIC",
    selectionStatus: "DECORATIVE",
    selectionReason: "visual-filter-v1:decorative_logo",
    rightsStatus: "PUBLIC_LINK",
    storageState: "LINK_ONLY",
    pendingStorageState: null,
    processingStatus: "READY",
    perceptualHash: "hash-html-logo",
    capsuleVersionId: null,
    thumbnailUrl: null,
    analysis: null,
    createdAt: "2026-08-25T09:31:00.000Z",
    updatedAt: "2026-08-25T09:31:00.000Z",
  };
  const htmlUnavailableAsset: VisualAssetSummary = {
    id: "asset-html-unavailable",
    parentSourceId: "source-html",
    parentVersionId: "version-source-html",
    originKind: "WEB_EMBED",
    sourceUrl: "https://ads.example.com/banner.jpg",
    pageNumber: null,
    figureLabel: null,
    caption: "열 수 없는 배너",
    visualKind: "GRAPHIC",
    selectionStatus: "UNAVAILABLE",
    selectionReason: "visual-filter-v1:unavailable_fetch_timeout",
    rightsStatus: "PUBLIC_LINK",
    storageState: "LINK_ONLY",
    pendingStorageState: null,
    processingStatus: "FAILED",
    perceptualHash: null,
    capsuleVersionId: null,
    thumbnailUrl: null,
    analysis: null,
    createdAt: "2026-08-25T09:31:30.000Z",
    updatedAt: "2026-08-25T09:31:30.000Z",
  };
  const htmlDetail: VisualAssetDetail = {
    ...htmlVisibleAsset,
    candidateKey: "figure-1",
    bbox: null,
    nearbyText: "The floor projection sits beside a wall text about circulation and image politics.",
    rightsBasis: "external_image_requires_rights_review",
    rightsReviewedAt: "2026-08-25T09:35:00.000Z",
    autoSuggestion: buildAnalysis("AI", "PENDING"),
    userVerified: buildAnalysis("검증", "EDITED"),
    relations: [
      {
        id: "relation-html-1",
        relationKind: "DUPLICATE_OF",
        createdBy: "SYSTEM",
        description: "반복 로고는 별도 후보로 남김",
        toVisualAssetId: "asset-html-logo",
        relatedSourceId: "source-html",
        relatedThreadId: null,
        createdAt: "2026-08-25T09:36:00.000Z",
      },
    ],
    extractionRun: {
      id: "run-html-1",
      parentSourceId: "source-html",
      parentVersionId: "version-source-html",
      originKind: "WEB_EMBED",
      status: "SUCCEEDED",
      totalUnits: 5,
      uploadedUnits: 5,
      processedUnits: 5,
      selectedCount: 1,
      reviewCount: 0,
      filteredCount: 3,
      unavailableCount: 1,
      errorCode: null,
      error: null,
      createdAt: "2026-08-25T09:32:00.000Z",
      updatedAt: "2026-08-25T09:33:00.000Z",
      finishedAt: "2026-08-25T09:33:00.000Z",
    },
  };
  const pdfVisibleAsset: VisualAssetSummary = {
    id: "asset-pdf-17",
    parentSourceId: "source-pdf",
    parentVersionId: "version-source-pdf",
    originKind: "PDF_PAGE_CROP",
    sourceUrl: "https://fixtures.example/paper.pdf#page=17",
    pageNumber: 17,
    figureLabel: "Figure 17",
    caption: "BBox crop from page 17",
    visualKind: "DOCUMENT_SCAN",
    selectionStatus: "REVIEW",
    selectionReason: "visual-filter-v1:needs_context_review",
    rightsStatus: "UNKNOWN",
    storageState: "LINK_ONLY",
    pendingStorageState: null,
    processingStatus: "READY",
    perceptualHash: "hash-pdf-17",
    capsuleVersionId: null,
    thumbnailUrl: null,
    analysis: buildAnalysis("PDF AI", "PENDING"),
    createdAt: "2026-08-25T10:00:00.000Z",
    updatedAt: "2026-08-25T10:00:00.000Z",
  };
  const pdfDetail: VisualAssetDetail = {
    ...pdfVisibleAsset,
    candidateKey: "page-17-bbox-1",
    bbox: { x: 0.12, y: 0.18, width: 0.44, height: 0.31, page: 17 },
    nearbyText: "Page checkpoint 17 keeps the figure caption and nearby paragraph for provenance.",
    rightsBasis: "pdf_rights_unknown_requires_link_only",
    rightsReviewedAt: "2026-08-25T10:02:00.000Z",
    autoSuggestion: buildAnalysis("PDF AI", "PENDING"),
    userVerified: buildAnalysis("PDF 검증", "EDITED"),
    relations: [],
    extractionRun: {
      id: pdfRunId,
      parentSourceId: "source-pdf",
      parentVersionId: "version-source-pdf",
      originKind: "PDF_PAGE_CROP",
      status: "PARTIAL",
      totalUnits: pdfPageCount,
      uploadedUnits: pdfPageCount,
      processedUnits: 40,
      selectedCount: 0,
      reviewCount: 1,
      filteredCount: Math.max(pdfPageCount - 2, 0),
      unavailableCount: 1,
      errorCode: initialPdfCleanupError,
      error: initialPdfCleanupError,
      createdAt: "2026-08-25T10:01:00.000Z",
      updatedAt: "2026-08-25T10:06:00.000Z",
      finishedAt: null,
    },
  };

  pdfDetail.extractionRun = {
    ...pdfDetail.extractionRun,
    totalUnits: pdfPageCount,
    uploadedUnits: pdfPageCount,
    processedUnits: Math.max(pdfPageCount - 1, 0),
    filteredCount: Math.max(pdfPageCount - 2, 0),
    errorCode: initialPdfCleanupError,
    error: initialPdfCleanupError,
  };

  function htmlAssets(): VisualAssetSummary[] {
    return [htmlVisibleAsset, htmlUnavailableAsset, htmlLogoRecovered ? { ...htmlRecoveredAsset, selectionStatus: "REVIEW", selectionReason: "사용자가 필터링된 이미지를 검토 목록으로 복구함" } : htmlRecoveredAsset];
  }

  function reservoirItems() {
    return [
      {
        id: "source-html",
        title: "Stored HTML article",
        kind: "WEB",
        reliability: "DISCOVERY",
        status: "indexed",
        origin: "discovery:rss",
        year: 2026,
        canonicalUrl: "https://example.com/articles/visuals",
        activeVersionId: "version-source-html",
        createdAt: "2026-08-25T09:20:00.000Z",
        topics: "[]",
        keywordCount: 0,
        signalCount: 0,
        markedForNextResearch: 0,
        decisionStatus: null,
      },
      {
        id: "source-pdf",
        title: "Stored PDF paper",
        kind: "PAPER_ACADEMIC",
        reliability: "PRIMARY",
        status: "indexed",
        origin: "upload",
        year: 2026,
        canonicalUrl: "https://fixtures.example/paper.pdf",
        activeVersionId: "version-source-pdf",
        createdAt: "2026-08-25T09:50:00.000Z",
        topics: "[]",
        keywordCount: 0,
        signalCount: 0,
        markedForNextResearch: 0,
        decisionStatus: null,
      },
      {
        id: "source-empty",
        title: "No-image web source",
        kind: "WEB",
        reliability: "DISCOVERY",
        status: "indexed",
        origin: "discovery:rss",
        year: 2026,
        canonicalUrl: "https://example.com/empty",
        activeVersionId: "version-source-empty",
        createdAt: "2026-08-25T09:10:00.000Z",
        topics: "[]",
        keywordCount: 0,
        signalCount: 0,
        markedForNextResearch: 0,
        decisionStatus: null,
      },
    ];
  }

  function reservoirDetail(sourceId: string): ReservoirSourceDetail {
    if (sourceId === "source-html") {
      return {
        source: {
          id: "source-html",
          title: "Stored HTML article",
          authors: "Fixture Author",
          kind: "WEB",
          reliability: "DISCOVERY",
          status: "indexed",
          origin: "discovery:rss",
          year: 2026,
          canonicalUrl: "https://example.com/articles/visuals",
          provenanceClass: "SOURCE",
          createdAt: "2026-08-25T09:20:00.000Z",
          markedForNextResearch: 0,
          decisionStatus: null,
          inputFormat: "URL_HTML",
          activeVersionId: "version-source-html",
        },
        acquisition: {
          textScope: "FULLTEXT",
          extractionMethod: "HTML_STATIC",
          qualityStatus: "READY",
          charCount: 2400,
          acquisitionLabel: "원문 저장됨 · 2,400자",
          canDeepAnalyze: true,
          originalTextUrl: "/api/reservoir/source-html/original-text",
        },
        analysis: {
          summary: "Stored HTML article summary",
          keywords: ["visual extraction"],
          questions: ["How are the figures contextualized?"],
          important_fragments: ["The article keeps captions beside the main image."],
        },
        deepAnalysis: null,
        deepAnalysisHistory: [],
        keywords: [],
        questions: [],
        fragments: [],
        versions: [],
        signals: [],
        visuals: htmlAssets(),
        visualExtractionRun: htmlDetail.extractionRun,
      };
    }
    if (sourceId === "source-pdf") {
      return {
        source: {
          id: "source-pdf",
          title: "Stored PDF paper",
          authors: "Fixture Author",
          kind: "PAPER_ACADEMIC",
          reliability: "PRIMARY",
          status: "indexed",
          origin: "upload",
          year: 2026,
          canonicalUrl: "https://fixtures.example/paper.pdf",
          provenanceClass: "SOURCE",
          createdAt: "2026-08-25T09:50:00.000Z",
          markedForNextResearch: 0,
          decisionStatus: null,
          inputFormat: "PDF_TEXT",
          activeVersionId: "version-source-pdf",
        },
        visualExtractionCapability: {
          state: "READY",
          canStart: true,
          sourceId: "source-pdf",
          sourceVersionId: "version-source-pdf",
          originalUrl: "/api/reservoir/source-pdf/original?version=version-source-pdf",
          reasonCode: null,
        },
        acquisition: {
          textScope: "FULLTEXT",
          extractionMethod: "PDF_REMOTE_TO_MARKDOWN",
          qualityStatus: "READY",
          charCount: 4200,
          acquisitionLabel: "원문 저장됨 · 4,200자",
          canDeepAnalyze: true,
          originalTextUrl: "/api/reservoir/source-pdf/original-text",
        },
        analysis: {
          summary: "Stored PDF paper summary",
          keywords: ["bbox", "pdf"],
          questions: ["Which page checkpoints need review?"],
          important_fragments: ["The crop stays link-only until rights are reviewed."],
        },
        deepAnalysis: null,
        deepAnalysisHistory: [],
        keywords: [],
        questions: [],
        fragments: [],
        versions: [],
        signals: [],
        visuals: [pdfVisibleAsset],
        visualExtractionRun: pdfDetail.extractionRun,
      };
    }
    return {
      source: {
        id: "source-empty",
        title: "No-image web source",
        authors: "Fixture Author",
        kind: "WEB",
        reliability: "DISCOVERY",
        status: "indexed",
        origin: "discovery:rss",
        year: 2026,
        canonicalUrl: "https://example.com/empty",
        provenanceClass: "SOURCE",
        createdAt: "2026-08-25T09:10:00.000Z",
        markedForNextResearch: 0,
        decisionStatus: null,
        inputFormat: "URL_HTML",
        activeVersionId: "version-source-empty",
      },
      acquisition: {
        textScope: "FULLTEXT",
        extractionMethod: "HTML_STATIC",
        qualityStatus: "READY",
        charCount: 1800,
        acquisitionLabel: "원문 저장됨 · 1,800자",
        canDeepAnalyze: true,
        originalTextUrl: "/api/reservoir/source-empty/original-text",
      },
      analysis: {
        summary: "No-image source summary",
        keywords: ["empty state"],
        questions: ["What should the empty extraction run say?"],
        important_fragments: ["This source does not contain any figures."],
      },
      deepAnalysis: null,
      deepAnalysisHistory: [],
      keywords: [],
      questions: [],
      fragments: [],
      versions: [],
      signals: [],
      visuals: [],
      visualExtractionRun: {
        id: "run-empty-1",
        parentSourceId: "source-empty",
        parentVersionId: "version-source-empty",
        originKind: "WEB_EMBED",
        status: "SUCCEEDED",
        totalUnits: 0,
        uploadedUnits: 0,
        processedUnits: 0,
        selectedCount: 0,
        reviewCount: 0,
        filteredCount: 0,
        unavailableCount: 0,
        errorCode: null,
        error: null,
        createdAt: "2026-08-25T08:50:00.000Z",
        updatedAt: "2026-08-25T08:51:00.000Z",
        finishedAt: "2026-08-25T08:51:00.000Z",
      },
    };
  }

  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === "/api/reservoir/source-pdf/original" || url.pathname.startsWith("/api/visual-extraction/pdf/")) {
      let body: unknown = null;
      try {
        body = request.postDataJSON();
      } catch {
        body = request.postData() ?? null;
      }
      pdfTrace.push({ method: request.method(), pathname: url.pathname, body });
    }
    const defaults = readingApiDefaults(url.pathname);
    if (defaults) {
      await route.fulfill({ json: defaults });
      return;
    }
    if (url.pathname === "/api/reservoir") {
      await route.fulfill({ json: { items: reservoirItems(), nextResearch: { markedCount: 0, lastResearchAt: null } } });
      return;
    }
    if (url.pathname === "/api/visual-assets" && url.searchParams.get("unassigned") === "1") {
      await route.fulfill({ json: { items: [] } });
      return;
    }
    if (url.pathname === "/api/reservoir/source-html") {
      await route.fulfill({ json: reservoirDetail("source-html") });
      return;
    }
    if (url.pathname === "/api/reservoir/source-pdf") {
      await route.fulfill({ json: reservoirDetail("source-pdf") });
      return;
    }
    if (url.pathname === "/api/reservoir/source-empty") {
      await route.fulfill({ json: reservoirDetail("source-empty") });
      return;
    }
    if (url.pathname === "/api/reservoir/source-html/original-text") {
      await route.fulfill({ body: "Stored HTML normalized text for deep reading.", contentType: "text/plain; charset=utf-8" });
      return;
    }
    if (url.pathname === "/api/reservoir/source-pdf/original-text") {
      await route.fulfill({ body: "Stored PDF normalized text for deep reading.", contentType: "text/plain; charset=utf-8" });
      return;
    }
    if (url.pathname === "/api/reservoir/source-empty/original-text") {
      await route.fulfill({ body: "This source intentionally contains no images.", contentType: "text/plain; charset=utf-8" });
      return;
    }
    if (url.pathname === "/api/reservoir/source-html/deep-analysis" && request.method() === "POST") {
      deepAnalysisBlocked = true;
      await route.fulfill({ status: 429, json: { error: "monthly_budget_exhausted" } });
      return;
    }
    if (url.pathname === "/api/signals" && request.method() === "POST") {
      await route.fulfill({ json: { ok: true } });
      return;
    }
    if (url.pathname === "/api/visual-assets/asset-html-link") {
      await route.fulfill({ json: { asset: htmlDetail } });
      return;
    }
    if (url.pathname === "/api/visual-assets/asset-pdf-17") {
      await route.fulfill({ json: { asset: pdfDetail } });
      return;
    }
    if (url.pathname === "/api/visual-assets/asset-html-logo/selection" && request.method() === "PATCH") {
      htmlLogoRecovered = true;
      await route.fulfill({
        json: {
          asset: {
            ...htmlRecoveredAsset,
            selectionStatus: "REVIEW",
            selectionReason: "사용자가 필터링된 이미지를 검토 목록으로 복구함",
            updatedAt: "2026-08-25T09:40:00.000Z",
          },
        },
      });
      return;
    }
    if (url.pathname === "/api/reservoir/source-pdf/original" && url.searchParams.get("version") === "version-source-pdf") {
      await route.fulfill({ body: pdfBytes, contentType: "application/pdf" });
      return;
    }
    if (url.pathname === "/api/visual-extraction/pdf/runs" && request.method() === "POST") {
      const uploadedPages = [...pdfUploadedPages].sort((left, right) => left - right);
      const nextPageNumber = Array.from({ length: pdfPageCount }, (_, index) => index + 1).find((pageNumber) => !pdfUploadedPages.has(pageNumber)) ?? null;
      await route.fulfill({
        json: {
          run: {
            id: pdfRunId,
            status: uploadedPages.length > 0 ? "UPLOADING" : "RUNNING",
            totalUnits: pdfPageCount,
            uploadedUnits: uploadedPages.length,
          },
          checkpoint: {
            uploadedPages,
            totalPages: pdfPageCount,
            remainingPages: pdfPageCount - uploadedPages.length,
            nextPageNumber,
          },
        },
      });
      return;
    }
    const uploadMatch = url.pathname.match(/^\/api\/visual-extraction\/pdf\/runs\/([^/]+)\/pages\/(\d+)$/);
    if (uploadMatch && request.method() === "PUT") {
      const pageNumber = Number(uploadMatch[2]);
      if (pageNumber === 2 && secondPageUploadAttempt === 0) {
        secondPageUploadAttempt += 1;
        resolveSecondPageUploadSeen?.();
        await new Promise<void>((resolve) => {
          releaseSecondPageUpload = resolve;
        });
        releaseSecondPageUpload = null;
        if (abortSecondPageUpload) {
          await route.abort().catch(() => undefined);
          return;
        }
      }
      pdfUploadedPages.add(pageNumber);
      await route.fulfill({
        json: {
          run: {
            id: pdfRunId,
            status: "UPLOADING",
            totalUnits: pdfPageCount,
            uploadedUnits: pdfUploadedPages.size,
          },
          checkpoint: {
            uploadedPages: [...pdfUploadedPages].sort((left, right) => left - right),
            totalPages: pdfPageCount,
            remainingPages: Math.max(pdfPageCount - pdfUploadedPages.size, 0),
            nextPageNumber: Array.from({ length: pdfPageCount }, (_, index) => index + 1).find((candidate) => !pdfUploadedPages.has(candidate)) ?? null,
          },
        },
      });
      return;
    }
    const finalizeMatch = url.pathname.match(/^\/api\/visual-extraction\/pdf\/runs\/([^/]+)\/finalize$/);
    if (finalizeMatch && request.method() === "POST") {
      pdfFinalized = true;
      pdfDetail.extractionRun = {
        ...pdfDetail.extractionRun,
        status: "PARTIAL",
        totalUnits: pdfPageCount,
        uploadedUnits: pdfUploadedPages.size,
        processedUnits: Math.max(pdfUploadedPages.size - 1, 0),
        filteredCount: Math.max(pdfPageCount - 2, 0),
        errorCode: "cleanup_retry_pending",
        error: "cleanup_retry_pending",
      };
      await route.fulfill({
        status: 202,
        json: {
          queued: true,
          reused: false,
          job: { id: "job-pdf-visual", kind: "VISUAL_EXTRACTION", status: "QUEUED" },
          run: {
            id: pdfRunId,
            status: "QUEUED",
            totalUnits: pdfPageCount,
            uploadedUnits: pdfPageCount,
          },
          checkpoint: {
            uploadedPages: Array.from({ length: pdfPageCount }, (_, index) => index + 1),
            totalPages: pdfPageCount,
            remainingPages: 0,
            nextPageNumber: null,
          },
        },
      });
      return;
    }
    if (url.pathname === `/api/visual-extraction/runs/${pdfRunId}/cancel` && request.method() === "POST") {
      await route.fulfill({ json: { ok: true } });
      return;
    }
    await route.fulfill({ status: 404, json: { error: `unhandled:${url.pathname}` } });
  });

  return {
    didBlockDeepAnalysis: () => deepAnalysisBlocked,
    waitForSecondPageUpload: () => secondPageUploadSeen,
    abortSecondPageUpload: () => {
      abortSecondPageUpload = true;
      releaseSecondPageUpload?.();
    },
    getPdfTrace: () => pdfTrace,
    wasPdfFinalized: () => pdfFinalized,
  };
}

async function openReservoirSource(page: Page, title: string) {
  await page.getByRole("navigation").getByRole("button", { name: "저장소", exact: true }).click();
  await page.getByRole("region", { name: "자료 목록" }).getByRole("button", { name: new RegExp(title) }).click();
}

test.describe("visual extraction web and pdf coverage", () => {
  test("keeps filtered HTML assets out of the default list, allows recovery, and blocks deep analysis when budget is exhausted", async ({ page }) => {
    const fixture = await installWebPdfFixture(page);

    await page.goto("/");
    await openReservoirSource(page, "Stored HTML article");

    await expect(page.getByRole("region", { name: "시각 자료", exact: true })).toContainText("3개");
    await expect(page.getByRole("button", { name: /Infrared installation view/ })).toBeVisible();
    await expect(page.getByRole("button", { name: /사이트 로고/ })).toHaveCount(0);

    await page.getByRole("button", { name: "필터링된 이미지 2개" }).click();
    await expect(page.getByText("장식/광고 1개")).toBeVisible();
    await expect(page.getByText("열 수 없음 1개")).toBeVisible();
    await page.getByRole("button", { name: "사이트 로고 검토 목록으로 복구" }).click();
    await expect(page.getByRole("button", { name: "필터링된 이미지 1개" })).toBeVisible();
    await expect(page.getByRole("region", { name: "시각 자료", exact: true })).toContainText("사이트 로고");

    await page.getByRole("button", { name: /Infrared installation view/ }).click();
    const inspector = page.getByRole("complementary", { name: "시각 자료 상세" });
    await expect(inspector).toBeVisible();
    await expect(inspector.getByRole("tab", { name: "사용자 검증" })).toHaveAttribute("aria-selected", "true");
    await expect(inspector.getByText("검증 피사체")).toBeVisible();
    await expect(inspector.getByText("원문 주소 · https://example.com/articles/visuals#figure-1")).toBeVisible();
    await expect(inspector.getByText("권리 근거 · external_image_requires_rights_review")).toBeVisible();
    await expect(inspector.getByRole("link", { name: "원문에서 보기" })).toHaveAttribute("href", "https://example.com/articles/visuals#figure-1");

    await page.getByRole("button", { name: "심층 정리하기" }).click();
    await expect(page.getByRole("status")).toContainText("이번 달 AI 사용량 한도에 도달했습니다.");
    expect(fixture.didBlockDeepAnalysis()).toBe(true);
  });

  test("shows the zero-image web state and keeps mobile pdf progress, inspector, and decision sheet separate", async ({ page }) => {
    await installWebPdfFixture(page);

    await page.goto("/");
    await page.getByRole("navigation").getByRole("button", { name: "저장소", exact: true }).click();
    await page.setViewportSize({ width: 390, height: 844 });

    await page.getByRole("region", { name: "자료 목록" }).getByRole("button", { name: /No-image web source/ }).click();
    await expect(page.getByText("이미지 없음")).toBeVisible();
    await page.getByRole("button", { name: "목록으로" }).click();

    await page.getByRole("region", { name: "자료 목록" }).getByRole("button", { name: /Stored PDF paper/ }).click();
    await page.getByRole("button", { name: "시각 자료 찾기" }).click();
    await expect(page.getByRole("dialog", { name: "PDF 시각 자료 추출" })).toBeVisible();
    await expect(page.getByRole("dialog", { name: "읽은 뒤 판단" })).toHaveCount(0);
    await expect(page.getByRole("dialog", { name: "시각 자료 상세" })).toHaveCount(0);
    await page.getByRole("dialog", { name: "PDF 시각 자료 추출" }).getByRole("button", { name: "닫기", exact: true }).click();

    await page.getByRole("button", { name: /BBox crop from page 17/ }).click();
    const inspector = page.getByRole("dialog", { name: "시각 자료 상세" });
    await expect(inspector).toBeVisible();
    const cropPreview = inspector.getByRole("img", { name: "PDF 잘라보기 미리보기" });
    await expect(cropPreview).toBeVisible();
    await expect(cropPreview).toHaveAttribute("src", /^blob:/);
    await expect.poll(async () => cropPreview.evaluate((image) => image.complete && image.naturalWidth > 0)).toBe(true);
    await expect(inspector).toContainText("페이지 · 17");
    await expect(inspector).toContainText("후보 키 · page-17-bbox-1");
    await expect(inspector).toContainText("선정 · 0 · 검토 · 1 · 제외 · 39 · 사용 불가 · 1");
    await expect(inspector).toContainText("실행 오류 · cleanup_retry_pending");
    await expect(page.getByRole("dialog", { name: "PDF 시각 자료 추출" })).toHaveCount(0);
    await expect(page.getByRole("dialog", { name: "읽은 뒤 판단" })).toHaveCount(0);

    await inspector.getByRole("button", { name: "닫기", exact: true }).click();
    await page.getByRole("button", { name: "판단하기" }).click();
    await expect(page.getByRole("dialog", { name: "읽은 뒤 판단" })).toBeVisible();
    await expect(page.getByRole("dialog", { name: "PDF 시각 자료 추출" })).toHaveCount(0);
  });

  test("pauses after a page checkpoint, resumes from the server checkpoint, and exposes finalize cleanup diagnostics", async ({ page }) => {
    const fixture = await installWebPdfFixture(page, { pdfPageCount: 2, initialPdfCleanupError: null });

    await page.goto("/");
    await openReservoirSource(page, "Stored PDF paper");

    const firstRunResponse = page.waitForResponse((response) => (
      response.url().includes("/api/visual-extraction/pdf/runs")
      && response.request().method() === "POST"
      && response.status() === 200
    ));
    const firstPageUploadResponse = page.waitForResponse((response) => (
      response.url().includes("/api/visual-extraction/pdf/runs/run-pdf-1/pages/1")
      && response.request().method() === "PUT"
      && response.status() === 200
    ));
    await page.getByRole("button", { name: "시각 자료 찾기" }).click();
    const firstRun = await firstRunResponse;
    expect(firstRun.url()).toContain("/api/visual-extraction/pdf/runs");
    expect(await firstRun.json()).toMatchObject({
      run: { id: "run-pdf-1", status: "RUNNING", totalUnits: 2, uploadedUnits: 0 },
      checkpoint: { uploadedPages: [], totalPages: 2, remainingPages: 2, nextPageNumber: 1 },
    });
    const firstPageUpload = await firstPageUploadResponse;
    expect(firstPageUpload.url()).toContain("/pages/1");
    expect(await firstPageUpload.json()).toMatchObject({
      checkpoint: { uploadedPages: [1], totalPages: 2, remainingPages: 1, nextPageNumber: 2 },
    });
    await fixture.waitForSecondPageUpload();
    const readingWorkspace = page.getByTestId("split-workspace");
    await expect(readingWorkspace.getByRole("button", { name: "중지" })).toBeVisible();

    await readingWorkspace.getByRole("button", { name: "중지" }).click();
    fixture.abortSecondPageUpload();
    await expect(page.getByText("1 / 2페이지 업로드됨", { exact: true })).toBeVisible();
    await expect(readingWorkspace.getByRole("button", { name: "계속" })).toBeVisible();

    const traceAfterPause = fixture.getPdfTrace();
    expect(traceAfterPause.filter((entry) => entry.pathname.endsWith("/pages/1"))).toHaveLength(1);
    expect(traceAfterPause.filter((entry) => entry.pathname.endsWith("/pages/2"))).toHaveLength(1);

    const resumeRunResponse = page.waitForResponse((response) => (
      response.url().endsWith("/api/visual-extraction/pdf/runs")
      && response.request().method() === "POST"
      && response.status() === 200
    ));
    const resumedPageUploadResponse = page.waitForResponse((response) => (
      response.url().includes("/api/visual-extraction/pdf/runs/run-pdf-1/pages/2")
      && response.request().method() === "PUT"
      && response.status() === 200
    ));
    const finalizeResponse = page.waitForResponse((response) => (
      response.url().endsWith("/api/visual-extraction/pdf/runs/run-pdf-1/finalize")
      && response.request().method() === "POST"
      && response.status() === 202
    ));
    await readingWorkspace.getByRole("button", { name: "계속" }).click();

    const resumedRun = await resumeRunResponse;
    expect(resumedRun.url()).toContain("/api/visual-extraction/pdf/runs");
    expect(await resumedRun.json()).toMatchObject({
      run: { id: "run-pdf-1", status: "UPLOADING", totalUnits: 2, uploadedUnits: 1 },
      checkpoint: { uploadedPages: [1], totalPages: 2, remainingPages: 1, nextPageNumber: 2 },
    });
    const resumeRunBody = traceAfterPause;
    expect(resumeRunBody.find((entry) => entry.pathname === "/api/visual-extraction/pdf/runs" && entry.method === "POST")?.body).toEqual({
      sourceId: "source-pdf",
      versionId: "version-source-pdf",
      pageCount: 2,
    });
    const resumedUpload = await resumedPageUploadResponse;
    expect(await resumedUpload.json()).toMatchObject({
      checkpoint: { uploadedPages: [1, 2], totalPages: 2, remainingPages: 0, nextPageNumber: null },
    });
    const finalized = await finalizeResponse;
    expect(await finalized.json()).toMatchObject({
      queued: true,
      job: { id: "job-pdf-visual", kind: "VISUAL_EXTRACTION", status: "QUEUED" },
      checkpoint: { uploadedPages: [1, 2], totalPages: 2, remainingPages: 0, nextPageNumber: null },
    });
    expect(fixture.getPdfTrace().at(-1)?.body).toEqual({ sourceId: "source-pdf", versionId: "version-source-pdf" });
    expect(fixture.wasPdfFinalized()).toBe(true);
    await expect(page.getByText("2 / 2페이지 업로드됨", { exact: true })).toBeVisible();
    await expect(page.getByText("모든 페이지 업로드를 마쳤습니다.")).toBeVisible();

    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole("button", { name: "목록으로" }).click();
    await page.getByRole("region", { name: "자료 목록" }).getByRole("button", { name: /Stored PDF paper/ }).click();
    await page.getByRole("button", { name: /BBox crop from page 17/ }).click();
    await expect(page.getByRole("dialog", { name: "시각 자료 상세" })).toContainText("실행 오류 · cleanup_retry_pending");
  });
});
