import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PdfVisualExtractionResult } from "../lib/pdfVisualExtraction";
import type { VisualAssetDetail, VisualAssetSummary, VisualExtractionRunSummary } from "@radar/shared";
import type { ResearchJob } from "@radar/shared/discovery";
import { resetPdfVisualExtractionManagerForTests } from "../lib/pdfVisualExtractionManager";

const pdfExtractionMocks = vi.hoisted(() => ({
  startOrResumePdfVisualExtraction: vi.fn(),
  cancelPdfVisualExtraction: vi.fn(),
}));

vi.mock("../lib/pdfVisualExtraction", () => ({
  startOrResumePdfVisualExtraction: pdfExtractionMocks.startOrResumePdfVisualExtraction,
  cancelPdfVisualExtraction: pdfExtractionMocks.cancelPdfVisualExtraction,
}));

import ReservoirView from "./ReservoirView";

function setViewport(width: number) {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
  window.dispatchEvent(new Event("resize"));
}

const sourceDetail = {
  source: { id: "source-1", title: "자료 A", authors: "저자", kind: "PAPER_ACADEMIC", reliability: "PRIMARY", origin: "upload", year: 2025, canonicalUrl: "https://example.com/paper" as string | null, provenanceClass: "SOURCE", createdAt: "2026-08-21", markedForNextResearch: 1, inputFormat: "PDF_TEXT", activeVersionId: "version-source-1" },
  deletion: {
    sourceId: "source-1",
    title: "자료 A",
    mergeRole: "NONE" as const,
    mergeMemberCount: 1,
  },
  visualExtractionCapability: { state: "READY" as const, canStart: true, sourceId: "source-1", sourceVersionId: "version-source-1", originalUrl: "/api/reservoir/source-1/original?version=version-source-1", reasonCode: null },
  acquisition: { textScope: "FULLTEXT" as const, extractionMethod: "HTML_STATIC", qualityStatus: "READY", charCount: 2_400, acquisitionLabel: "원문 수집 완료", canDeepAnalyze: true, originalTextUrl: "/api/reservoir/source-1/original-text" as string | null },
  analysis: { summary: "시스템이 정리한 내용", keywords: ["사진"], questions: ["어떻게 읽을까"], important_fragments: ["원문 문장"] },
  deepAnalysis: null,
  deepAnalysisHistory: [],
  keywords: [],
  questions: [],
  fragments: [],
  versions: [],
  signals: [],
};
const sourceDetailB = {
  ...sourceDetail,
  source: { ...sourceDetail.source, id: "source-2", title: "자료 B", activeVersionId: "version-source-2" },
  acquisition: { ...sourceDetail.acquisition, originalTextUrl: "/api/reservoir/source-2/original-text" },
  analysis: { ...sourceDetail.analysis, summary: "두 번째 자료 분석" },
};

const visualSummary: VisualAssetSummary = {
  id: "asset-1",
  parentSourceId: "source-1",
  parentVersionId: "version-source-1",
  originKind: "WEB_EMBED",
  sourceUrl: "https://example.com/figure-1",
  pageNumber: null,
  figureLabel: "Figure 1",
  caption: "도판 1",
  visualKind: "PHOTO",
  selectionStatus: "REVIEW",
  selectionReason: "visual-filter-v1:needs_review",
  rightsStatus: "UNKNOWN",
  storageState: "LINK_ONLY",
  pendingStorageState: null,
  processingStatus: "READY",
  perceptualHash: "hash-1",
  capsuleVersionId: null,
  thumbnailUrl: null,
  analysis: {
    id: "analysis-auto",
    payload: {
      observation: { subject: ["AI 피사체"], composition: [], color: [], texture: [], spatialRelation: [], material: [], lighting: [], visibleText: [] },
      formal: { shapes: ["AI 형태"], lines: [], planes: [], rhythm: [], scale: [], density: [], edges: [], contrast: [], perspective: [] },
      context: { medium: ["AI 매체"], process: [], relationToPhotography: [], culturalReferences: [] },
      propositions: ["AI 제안"],
      uncertainty: ["AI 불확실성"],
      visualKind: "PHOTO",
      confidence: 0.7,
    },
    provenanceClass: "INTERPRETATION",
    confidence: 0.7,
    reviewStatus: "PENDING",
    modelId: "vision-low",
    promptVersion: "visual-v1",
    createdAt: "2026-08-25T10:00:00.000Z",
  },
  createdAt: "2026-08-25T10:00:00.000Z",
  updatedAt: "2026-08-25T10:00:00.000Z",
};

const visualDetail: VisualAssetDetail = {
  ...visualSummary,
  nearbyText: "원문 첫 문단 옆에서 이 이미지를 설명합니다.",
  candidateKey: "figure-1",
  bbox: null,
  rightsBasis: "권리 검토 대기",
  rightsReviewedAt: "2026-08-25T10:05:00.000Z",
  autoSuggestion: visualSummary.analysis,
  userVerified: {
    id: "analysis-user",
    payload: {
      observation: { subject: ["검증 피사체"], composition: [], color: [], texture: [], spatialRelation: [], material: [], lighting: [], visibleText: [] },
      formal: { shapes: ["검증 형태"], lines: [], planes: [], rhythm: [], scale: [], density: [], edges: [], contrast: [], perspective: [] },
      context: { medium: ["검증 매체"], process: [], relationToPhotography: [], culturalReferences: [] },
      propositions: ["검증 제안"],
      uncertainty: ["검증 불확실성"],
      visualKind: "PHOTO",
      confidence: null,
    },
    provenanceClass: "INTERPRETATION",
    confidence: null,
    reviewStatus: "EDITED",
    modelId: null,
    promptVersion: null,
    createdAt: "2026-08-25T10:10:00.000Z",
  },
  relations: [],
  extractionRun: null,
};

const unassignedVisualSummary: VisualAssetSummary = {
  ...visualSummary,
  id: "asset-unassigned",
  parentSourceId: null,
  parentVersionId: null,
  originKind: "PERSONAL_UPLOAD",
  sourceUrl: null,
  caption: "개인 업로드 이미지",
  storageState: "ARCHIVAL",
  rightsStatus: "PERSONAL",
};

const unassignedVisualDetail: VisualAssetDetail = {
  ...visualDetail,
  ...unassignedVisualSummary,
  autoSuggestion: unassignedVisualSummary.analysis,
  userVerified: null,
  rightsBasis: "개인 작업 업로드",
  rightsReviewedAt: "2026-08-25T11:05:00.000Z",
};

let deepAnalysisResult: { status: number; body: Record<string, unknown> };
let deleteResult: { status: number; body: Record<string, unknown> };
let pendingDelete: Promise<Response> | null;
type TestSourceDetail = Omit<typeof sourceDetail, "source" | "acquisition"> & {
  source: Omit<typeof sourceDetail.source, "canonicalUrl"> & { canonicalUrl: string | null };
  acquisition: Omit<typeof sourceDetail.acquisition, "textScope" | "originalTextUrl"> & {
    textScope: "FULLTEXT" | "PARTIAL" | "METADATA_ONLY" | "EMPTY" | "UNKNOWN";
    originalTextUrl: string | null;
  };
  visualExtractionRun?: VisualExtractionRunSummary | null;
  visualExtractionCapability?: { state: "READY" | "ORIGINAL_MISSING" | "ORIGINAL_OBJECT_MISSING" | "UNSUPPORTED"; canStart: boolean; sourceId: string; sourceVersionId: string | null; originalUrl: string | null; reasonCode: string | null };
};

function deepAnalysisJob(status: ResearchJob["status"]): ResearchJob {
  return {
    id: "deep-job",
    workflowInstanceId: "workflow-deep-job",
    kind: "DEEP_ANALYSIS",
    status,
    progress: status === "SUCCEEDED" ? 100 : 20,
    message: status === "SUCCEEDED" ? "완료" : "자료 본문을 읽는 중",
    input: { sourceId: "source-1", profile: "precision" },
    result: status === "SUCCEEDED" ? { analysisId: "analysis-new" } : null,
    resultRef: status === "SUCCEEDED" ? { view: "RESERVOIR", sourceId: "source-1", analysisId: "analysis-new" } : null,
    errorCode: null,
    error: null,
    retryOf: null,
    requestedBy: "test-user",
    dedupeKey: "DEEP_ANALYSIS:{sourceId:source-1,profile:precision}",
    dismissedAt: null,
    createdAt: "2026-08-28T12:00:00.000Z",
    startedAt: "2026-08-28T12:00:01.000Z",
    finishedAt: status === "SUCCEEDED" ? "2026-08-28T12:00:10.000Z" : null,
    updatedAt: status === "SUCCEEDED" ? "2026-08-28T12:00:10.000Z" : "2026-08-28T12:00:01.000Z",
  };
}

let currentSourceDetail: TestSourceDetail;
let reservoirItems: Array<Record<string, unknown>>;
let pendingSourceOneDetail: Promise<Response> | null;
let pendingSearch: Promise<Response> | null;
let pendingDeepHistory: Record<string, Promise<Response> | undefined>;
let pendingDecisionSignal: Promise<Response> | null;
let pendingReanalysis: Promise<Response> | null;
let pendingDeepAnalysis: Promise<Response> | null;
let pendingRefetch: Promise<Response> | null;
let pendingReservoirLists: Record<string, Promise<Response> | undefined>;
let pendingTopicResponses: Array<Promise<Response>>;
let viewSignalFailure = false;
let decisionSignalFailure: string | null = null;
let sourceOneDetailFailure = false;
let pdfExtractionResult: PdfVisualExtractionResult;
let currentVisualDetail: VisualAssetDetail;
let currentUnassignedVisualDetail: VisualAssetDetail;
let currentUnassignedVisuals: VisualAssetSummary[];
let currentFocusedExtractionRun: VisualExtractionRunSummary | null;

beforeEach(() => {
  resetPdfVisualExtractionManagerForTests();
  setViewport(1280);
  let requestedWatching = false;
  deepAnalysisResult = { status: 202, body: { job: { id: "deep-job" }, reused: false } };
  deleteResult = { status: 200, body: { deletedSourceId: "source-1", merge: null } };
  pendingDelete = null;
  currentSourceDetail = sourceDetail;
  reservoirItems = [{ id: "source-1", title: "자료 A", kind: "PAPER_ACADEMIC", reliability: "PRIMARY", status: "indexed", origin: "upload", year: 2025, canonicalUrl: "https://example.com/paper", activeVersionId: "version-source-1", createdAt: "2026-08-21", topics: "[\"사진\"]", keywordCount: 1, signalCount: 0, markedForNextResearch: 1, decisionStatus: null }];
  pendingSourceOneDetail = null;
  pendingSearch = null;
  pendingDeepHistory = {};
  pendingDecisionSignal = null;
  pendingReanalysis = null;
  pendingDeepAnalysis = null;
  pendingRefetch = null;
  pendingReservoirLists = {};
  pendingTopicResponses = [];
  viewSignalFailure = false;
  decisionSignalFailure = null;
  sourceOneDetailFailure = false;
  currentVisualDetail = visualDetail;
  currentUnassignedVisualDetail = unassignedVisualDetail;
  currentUnassignedVisuals = [];
  currentFocusedExtractionRun = null;
  pdfExtractionResult = {
    runId: "run-visual-1",
    status: "PAUSED",
    totalPages: 85,
    uploadedPages: 40,
    remainingPages: 45,
    nextPageNumber: 41,
  };
  pdfExtractionMocks.startOrResumePdfVisualExtraction.mockReset();
  pdfExtractionMocks.startOrResumePdfVisualExtraction.mockResolvedValue(pdfExtractionResult);
  pdfExtractionMocks.cancelPdfVisualExtraction.mockReset();
  pdfExtractionMocks.cancelPdfVisualExtraction.mockResolvedValue(undefined);
  vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === "/api/reservoir" || url.startsWith("/api/reservoir?")) {
      if (pendingReservoirLists[url]) return pendingReservoirLists[url];
      const decisionStatus = url.includes("decision=watching") ? "watch" : null;
      requestedWatching = decisionStatus === "watch";
      return Promise.resolve(new Response(JSON.stringify({ items: reservoirItems.map((item) => ({ ...item, decisionStatus })) })));
    }
    if (url === "/api/reservoir/topics") return pendingTopicResponses.shift() ?? Promise.resolve(new Response(JSON.stringify({ topics: [] })));
    if (url.startsWith("/api/search?") && pendingSearch) return pendingSearch;
    if (url === "/api/reservoir/source-1" && init?.method === "DELETE") {
      if (pendingDelete) return pendingDelete;
      if (deleteResult.status === 200 || deleteResult.body.error === "source_not_found") {
        reservoirItems = reservoirItems.filter((item) => item.id !== "source-1");
      }
      return Promise.resolve(new Response(JSON.stringify(deleteResult.body), { status: deleteResult.status }));
    }
    if (url === "/api/reservoir/source-1" && pendingSourceOneDetail) return pendingSourceOneDetail;
    if (url === "/api/reservoir/source-1" && sourceOneDetailFailure) return Promise.resolve(new Response("", { status: 500 }));
    if (url === "/api/reservoir/source-1") return Promise.resolve(new Response(JSON.stringify(requestedWatching ? { ...currentSourceDetail, source: { ...currentSourceDetail.source, decisionStatus: "watch" } } : currentSourceDetail)));
    if (url === "/api/reservoir/source-2") return Promise.resolve(new Response(JSON.stringify(sourceDetailB)));
    if (url === "/api/visual-extraction/runs/run-focused") {
      return currentFocusedExtractionRun
        ? Promise.resolve(new Response(JSON.stringify({ run: currentFocusedExtractionRun, checkpoint: { uploadedPages: [], totalPages: 0, remainingPages: 0, nextPageNumber: null } })))
        : Promise.resolve(new Response("", { status: 404 }));
    }
    if (url === "/api/visual-assets?unassigned=1") return Promise.resolve(new Response(JSON.stringify({ items: currentUnassignedVisuals })));
    if (url === "/api/visual-assets/asset-1") return Promise.resolve(new Response(JSON.stringify({ asset: currentVisualDetail })));
    if (url === "/api/visual-assets/asset-unassigned") return Promise.resolve(new Response(JSON.stringify({ asset: currentUnassignedVisualDetail })));
    if (url === "/api/visual-assets/asset-unassigned/assignment" && init?.method === "PATCH") {
      currentUnassignedVisuals = [];
      currentUnassignedVisualDetail = {
        ...currentUnassignedVisualDetail,
        parentSourceId: "source-1",
        parentVersionId: "version-source-1",
      };
      return Promise.resolve(new Response(JSON.stringify({
        asset: {
          ...unassignedVisualSummary,
          parentSourceId: "source-1",
          parentVersionId: "version-source-1",
          updatedAt: "2026-08-25T11:06:00.000Z",
        },
      })));
    }
    const deepHistoryMatch = url.match(/^\/api\/reservoir\/source-1\/deep-analysis\/(analysis-[12])$/);
    if (deepHistoryMatch && pendingDeepHistory[deepHistoryMatch[1]]) return pendingDeepHistory[deepHistoryMatch[1]];
    if (url === "/api/reservoir/source-1/deep-analysis" && init?.method === "POST") {
      if (pendingDeepAnalysis) return pendingDeepAnalysis;
      return Promise.resolve(new Response(JSON.stringify(deepAnalysisResult.body), { status: deepAnalysisResult.status }));
    }
    if (url === "/api/inbox/retry/source-1?analyze=1" && init?.method === "POST" && pendingReanalysis) return pendingReanalysis;
    if (url === "/api/inbox/retry/source-1?fetch=1" && init?.method === "POST" && pendingRefetch) return pendingRefetch;
    if (url === "/api/signals" && init?.method === "POST") {
      const action = JSON.parse(String(init.body ?? "{}")) as { action?: string };
      if (action.action === "view" && viewSignalFailure) return Promise.reject(new Error("signal_failed"));
      if (action.action !== "view" && decisionSignalFailure) {
        const error = decisionSignalFailure;
        decisionSignalFailure = null;
        return Promise.resolve(new Response(JSON.stringify({ error }), { status: 500 }));
      }
      if (action.action !== "view" && pendingDecisionSignal) return pendingDecisionSignal;
      return Promise.resolve(new Response(JSON.stringify({ ok: true })));
    }
    return Promise.resolve(new Response(JSON.stringify({ items: [] })));
  }));
});

describe("ReservoirView", () => {
  it("keeps the index visible while reading a source", async () => {
    render(<ReservoirView />);
    await userEvent.click(await screen.findByRole("button", { name: /자료 A/ }));
    expect(screen.queryByRole("dialog", { name: "읽은 뒤 판단" })).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "저장소 자료" })).toBeInTheDocument();
    expect(screen.getByText("시스템 해석")).toBeInTheDocument();
    expect(screen.getByText("원문에서 추출한 문장")).toBeInTheDocument();
    expect(screen.getAllByText(/다음 리서치/).length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: "심층 정리하기" })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "심층 정리 품질" })).toHaveValue("precision");
  });

  it("permanently deletes after exact-title confirmation and returns to the list", async () => {
    render(<ReservoirView />);
    await userEvent.click(await screen.findByRole("button", { name: /자료 A/ }));
    await userEvent.click(screen.getByRole("button", { name: "자료 삭제" }));
    const dialog = screen.getByRole("dialog", { name: "자료 영구 삭제" });
    await userEvent.type(within(dialog).getByLabelText("확인을 위해 자료 제목 입력"), "자료 A");
    await userEvent.click(within(dialog).getByRole("button", { name: "영구 삭제" }));

    await waitFor(() => expect(fetch).toHaveBeenCalledWith(
      "/api/reservoir/source-1",
      expect.objectContaining({
        method: "DELETE",
        body: JSON.stringify({ confirmTitle: "자료 A" }),
      }),
    ));
    expect(await screen.findByText("자료를 영구 삭제했습니다.")).toBeInTheDocument();
    expect(screen.getByText("읽을 자료를 선택하세요")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /자료 A/ })).not.toBeInTheDocument();
  });

  it("keeps the detail and translates a storage cleanup failure", async () => {
    deleteResult = { status: 502, body: { error: "source_delete_r2_failed" } };
    render(<ReservoirView />);
    await userEvent.click(await screen.findByRole("button", { name: /자료 A/ }));
    await userEvent.click(screen.getByRole("button", { name: "자료 삭제" }));
    const dialog = screen.getByRole("dialog", { name: "자료 영구 삭제" });
    await userEvent.type(within(dialog).getByLabelText("확인을 위해 자료 제목 입력"), "자료 A");
    await userEvent.click(within(dialog).getByRole("button", { name: "영구 삭제" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      "원본 저장소 정리에 실패했습니다. 자료는 삭제되지 않았습니다.",
    );
    expect(screen.getByText("시스템이 정리한 내용")).toBeInTheDocument();
  });

  it("returns to a refreshed list when the source was already deleted", async () => {
    deleteResult = { status: 404, body: { error: "source_not_found" } };
    render(<ReservoirView />);
    await userEvent.click(await screen.findByRole("button", { name: /자료 A/ }));
    await userEvent.click(screen.getByRole("button", { name: "자료 삭제" }));
    const dialog = screen.getByRole("dialog", { name: "자료 영구 삭제" });
    await userEvent.type(within(dialog).getByLabelText("확인을 위해 자료 제목 입력"), "자료 A");
    await userEvent.click(within(dialog).getByRole("button", { name: "영구 삭제" }));
    expect(await screen.findByText("이미 삭제된 자료라 저장소 목록을 새로 불러왔습니다.")).toBeInTheDocument();
    expect(screen.getByText("읽을 자료를 선택하세요")).toBeInTheDocument();
  });

  it("locks the delete dialog while the request is pending", async () => {
    let resolveDelete: (response: Response) => void = () => undefined;
    pendingDelete = new Promise((resolve) => { resolveDelete = resolve; });
    render(<ReservoirView />);
    await userEvent.click(await screen.findByRole("button", { name: /자료 A/ }));
    await userEvent.click(screen.getByRole("button", { name: "자료 삭제" }));
    const dialog = screen.getByRole("dialog", { name: "자료 영구 삭제" });
    await userEvent.type(within(dialog).getByLabelText("확인을 위해 자료 제목 입력"), "자료 A");
    await userEvent.click(within(dialog).getByRole("button", { name: "영구 삭제" }));
    expect(within(dialog).getByRole("button", { name: "삭제 중…" })).toBeDisabled();
    expect(within(dialog).getByRole("button", { name: "취소" })).toBeDisabled();
    await act(async () => {
      resolveDelete(new Response(JSON.stringify({ deletedSourceId: "source-1", merge: null })));
    });
    expect(await screen.findByText("자료를 영구 삭제했습니다.")).toBeInTheDocument();
  });

  it("shows a quality recheck action instead of acquisition for FULLTEXT REVIEW", async () => {
    currentSourceDetail = {
      ...sourceDetail,
      acquisition: { ...sourceDetail.acquisition, qualityStatus: "REVIEW", charCount: 3_790, canDeepAnalyze: false, originalTextUrl: null },
    };
    render(<ReservoirView />);

    await userEvent.click(await screen.findByRole("button", { name: /자료 A/ }));

    expect(await screen.findByRole("button", { name: "품질 다시 검사" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "원문 수집 필요" })).not.toBeInTheDocument();
  });

  it("explains how to repair a partial local source without presenting a dead remote-fetch action", async () => {
    currentSourceDetail = {
      ...sourceDetail,
      source: {
        ...sourceDetail.source,
        canonicalUrl: null,
        inputFormat: "OBSIDIAN_MARKDOWN",
      },
      acquisition: {
        ...sourceDetail.acquisition,
        textScope: "PARTIAL",
        qualityStatus: "REVIEW",
        charCount: 283,
        acquisitionLabel: "원문 일부 저장됨 · 283자",
        canDeepAnalyze: false,
        originalTextUrl: "/api/reservoir/source-1/original-text",
      },
    };
    render(<ReservoirView />);

    await userEvent.click(await screen.findByRole("button", { name: /자료 A/ }));

    expect(screen.getByText(/원문 일부 · 검토 필요 · 283자/)).toHaveTextContent("받은 자료에서 본문을 보강하거나 Obsidian 동기화를 다시 실행해 주세요.");
    expect(screen.getByRole("button", { name: "본문 보강 필요" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "원문 수집 필요" })).not.toBeInTheDocument();
  });

  it("opens reading before asking for a judgment", async () => {
    render(<ReservoirView />);
    await userEvent.click(await screen.findByRole("button", { name: /자료 A/ }));

    expect(screen.getByText("시스템 해석")).toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "읽은 뒤 판단" })).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "판단하기" }));
    expect(screen.getByRole("dialog", { name: "읽은 뒤 판단" })).toBeInTheDocument();
  });

  it("returns to a coherent unselected state", async () => {
    render(<ReservoirView />);
    const item = await screen.findByRole("button", { name: /자료 A/ });
    await userEvent.click(item);
    await userEvent.click(screen.getByRole("button", { name: "목록으로" }));

    expect(screen.getByText("읽을 자료를 선택하세요")).toBeInTheDocument();
    expect(item).not.toHaveAttribute("aria-current");
    expect(screen.queryByRole("button", { name: "판단하기" })).not.toBeInTheDocument();
  });

  it("keeps the newest filtered list and next-research state when an older list response arrives late", async () => {
    let resolveWatching: (response: Response) => void = () => undefined;
    let resolveActive: (response: Response) => void = () => undefined;
    render(<ReservoirView />);
    await screen.findByRole("button", { name: /자료 A/ });
    pendingReservoirLists["/api/reservoir?decision=watching"] = new Promise((resolve) => { resolveWatching = resolve; });
    pendingReservoirLists["/api/reservoir?decision=active"] = new Promise((resolve) => { resolveActive = resolve; });

    await userEvent.click(screen.getByRole("button", { name: "관찰 중" }));
    await waitFor(() => expect(fetch).toHaveBeenCalledWith("/api/reservoir?decision=watching"));
    await userEvent.click(screen.getByRole("button", { name: "활성 자료" }));
    await waitFor(() => expect(fetch).toHaveBeenCalledWith("/api/reservoir?decision=active"));
    await act(async () => {
      resolveActive(new Response(JSON.stringify({
        items: [{ ...reservoirItems[0], id: "source-2", title: "자료 B" }],
        nextResearch: { markedCount: 8, lastResearchAt: "2026-08-24" },
      })));
    });
    await userEvent.click(await screen.findByRole("button", { name: /자료 B/ }));
    expect(await screen.findByText("두 번째 자료 분석")).toBeInTheDocument();
    expect(screen.getByText("8개 표시됨")).toBeInTheDocument();

    await act(async () => {
      resolveWatching(new Response(JSON.stringify({
        items: reservoirItems,
        nextResearch: { markedCount: 1, lastResearchAt: null },
      })));
    });

    expect(screen.getByRole("button", { name: /자료 B/ })).toHaveAttribute("aria-current", "true");
    expect(screen.queryByRole("button", { name: /자료 A/ })).not.toBeInTheDocument();
    expect(screen.getByText("8개 표시됨")).toBeInTheDocument();
  });

  it("clears the reading selection when the accepted filtered list excludes it", async () => {
    let resolveWatching: (response: Response) => void = () => undefined;
    pendingReservoirLists["/api/reservoir?decision=watching"] = new Promise((resolve) => { resolveWatching = resolve; });
    render(<ReservoirView />);

    await userEvent.click(await screen.findByRole("button", { name: /자료 A/ }));
    await userEvent.click(screen.getByRole("button", { name: "관찰 중" }));
    await waitFor(() => expect(fetch).toHaveBeenCalledWith("/api/reservoir?decision=watching"));
    await act(async () => {
      resolveWatching(new Response(JSON.stringify({
        items: [{ ...reservoirItems[0], id: "source-2", title: "자료 B" }],
        nextResearch: { markedCount: 0, lastResearchAt: null },
      })));
    });

    expect(await screen.findByText("읽을 자료를 선택하세요")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /자료 B/ })).not.toHaveAttribute("aria-current");
    expect(screen.queryByRole("dialog", { name: "읽은 뒤 판단" })).not.toBeInTheDocument();
  });

  it("keeps current topic options when an older topic response arrives late", async () => {
    let resolveOldTopics: (response: Response) => void = () => undefined;
    const oldTopics = new Promise<Response>((resolve) => { resolveOldTopics = resolve; });
    pendingTopicResponses = [
      oldTopics,
      Promise.resolve(new Response(JSON.stringify({ topics: [{ topic: "초기 토픽", count: 1 }] }))),
      Promise.resolve(new Response(JSON.stringify({ topics: [{ topic: "새 토픽", count: 2 }] }))),
    ];
    render(<ReservoirView />);

    await waitFor(() => expect(vi.mocked(fetch).mock.calls.some(([input]) => input === "/api/reservoir/topics")).toBe(true));
    await userEvent.click(await screen.findByRole("button", { name: "관찰 중" }));
    await waitFor(() => expect(vi.mocked(fetch).mock.calls.filter(([input]) => input === "/api/reservoir/topics").length).toBeGreaterThanOrEqual(3));
    expect(await screen.findByRole("button", { name: "새 토픽 · 2" })).toBeInTheDocument();

    await act(async () => {
      resolveOldTopics(new Response(JSON.stringify({ topics: [{ topic: "이전 토픽", count: 1 }] })));
    });

    expect(screen.getByRole("button", { name: "새 토픽 · 2" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "이전 토픽 · 1" })).not.toBeInTheDocument();
  });

  it("ignores an earlier detail response after a newer selection is cleared", async () => {
    let resolveSourceOneDetail: (response: Response) => void = () => undefined;
    pendingSourceOneDetail = new Promise((resolve) => { resolveSourceOneDetail = resolve; });
    reservoirItems = [
      reservoirItems[0],
      { ...reservoirItems[0], id: "source-2", title: "자료 B" },
    ];
    render(<ReservoirView />);

    await userEvent.click(await screen.findByRole("button", { name: /자료 A/ }));
    await userEvent.click(screen.getByRole("button", { name: /자료 B/ }));
    expect(await screen.findByText("두 번째 자료 분석")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "목록으로" }));

    resolveSourceOneDetail(new Response(JSON.stringify(sourceDetail)));

    await waitFor(() => expect(screen.getByText("읽을 자료를 선택하세요")).toBeInTheDocument());
    expect(screen.queryByText("시스템이 정리한 내용")).not.toBeInTheDocument();
    expect(screen.queryByText("자료 상세 내용을 불러오지 못했습니다.")).not.toBeInTheDocument();
  });

  it("keeps the selected reading state coherent while detail loading is pending", async () => {
    let resolveSourceOneDetail: (response: Response) => void = () => undefined;
    pendingSourceOneDetail = new Promise((resolve) => { resolveSourceOneDetail = resolve; });
    render(<ReservoirView />);

    await userEvent.click(await screen.findByRole("button", { name: /자료 A/ }));

    expect(screen.getByTestId("split-workspace")).toHaveAttribute("data-mobile-pane", "reading");
    expect(screen.getByRole("heading", { name: "자료 상세 내용을 불러오는 중…" })).toBeInTheDocument();
    expect(screen.queryByText("읽을 자료를 선택하세요")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "목록으로" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "판단하기" })).not.toBeInTheDocument();

    await act(async () => {
      resolveSourceOneDetail(new Response(JSON.stringify(sourceDetail)));
    });

    expect(await screen.findByText("시스템이 정리한 내용")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "자료 상세 내용을 불러오는 중…" })).not.toBeInTheDocument();
  });

  it("ignores an active detail response after search clears the reading selection", async () => {
    let resolveSourceOneDetail: (response: Response) => void = () => undefined;
    pendingSourceOneDetail = new Promise((resolve) => { resolveSourceOneDetail = resolve; });
    render(<ReservoirView />);

    await userEvent.click(await screen.findByRole("button", { name: /자료 A/ }));
    await userEvent.type(screen.getByPlaceholderText("제목, 저자, 질문으로 검색"), "사진");
    await userEvent.click(screen.getByRole("button", { name: "검색" }));
    expect(await screen.findByText(/검색 결과\s*0개/)).toBeInTheDocument();

    resolveSourceOneDetail(new Response(JSON.stringify(sourceDetail)));

    await waitFor(() => expect(screen.getByText("읽을 자료를 선택하세요")).toBeInTheDocument());
    expect(screen.queryByText("시스템이 정리한 내용")).not.toBeInTheDocument();
    expect(screen.queryByText("자료 상세 내용을 불러오지 못했습니다.")).not.toBeInTheDocument();
  });

  it("ignores a late search response after a newer source selection", async () => {
    let resolveSearch: (response: Response) => void = () => undefined;
    pendingSearch = new Promise((resolve) => { resolveSearch = resolve; });
    reservoirItems = [
      reservoirItems[0],
      { ...reservoirItems[0], id: "source-2", title: "자료 B" },
    ];
    render(<ReservoirView />);

    await userEvent.type(screen.getByPlaceholderText("제목, 저자, 질문으로 검색"), "사진");
    await userEvent.click(screen.getByRole("button", { name: "검색" }));
    await waitFor(() => expect(fetch).toHaveBeenCalledWith("/api/search?q=%EC%82%AC%EC%A7%84"));
    await userEvent.click(screen.getByRole("button", { name: /자료 B/ }));
    expect(await screen.findByText("두 번째 자료 분석")).toBeInTheDocument();

    await act(async () => {
      resolveSearch(new Response(JSON.stringify({ hits: [{ sourceId: "source-1", title: "검색된 자료 A", matched: "title", snippet: "사진" }] })));
    });

    expect(screen.getByText("두 번째 자료 분석")).toBeInTheDocument();
    expect(screen.queryByText(/검색 결과 1개/)).not.toBeInTheDocument();
  });

  it("invalidates a pending search when an empty search clears it", async () => {
    let resolveSearch: (response: Response) => void = () => undefined;
    pendingSearch = new Promise((resolve) => { resolveSearch = resolve; });
    render(<ReservoirView />);

    const search = screen.getByPlaceholderText("제목, 저자, 질문으로 검색");
    await userEvent.type(search, "사진");
    await userEvent.click(screen.getByRole("button", { name: "검색" }));
    await waitFor(() => expect(fetch).toHaveBeenCalledWith("/api/search?q=%EC%82%AC%EC%A7%84"));
    await userEvent.clear(search);
    await userEvent.click(screen.getByRole("button", { name: "검색" }));

    await act(async () => {
      resolveSearch(new Response(JSON.stringify({ hits: [{ sourceId: "source-1", title: "검색된 자료 A", matched: "title", snippet: "사진" }] })));
    });

    expect(screen.queryByText(/검색 결과 1개/)).not.toBeInTheDocument();
    expect(screen.getByText("읽을 자료를 선택하세요")).toBeInTheDocument();
  });

  it("keeps a loaded detail visible when its best-effort view signal fails", async () => {
    viewSignalFailure = true;
    render(<ReservoirView />);

    await userEvent.click(await screen.findByRole("button", { name: /자료 A/ }));

    expect(await screen.findByText("시스템이 정리한 내용")).toBeInTheDocument();
    expect(screen.queryByText("자료 상세 내용을 불러오지 못했습니다.")).not.toBeInTheDocument();
  });

  it("does not apply a prior source's deep-history result after selecting another source", async () => {
    let resolveDeepHistory: (response: Response) => void = () => undefined;
    pendingDeepHistory["analysis-1"] = new Promise((resolve) => { resolveDeepHistory = resolve; });
    currentSourceDetail = {
      ...sourceDetail,
      deepAnalysis: { profile: "precision", overview: "현재 A 심층 정리", arguments: [], structure: [], quotes: [], connections: [], researchUses: [], limitations: [], meta: { sourceCharCount: 2400, analyzedCharCount: 2400, chunkCount: 1 } },
      deepAnalysisHistory: [{ id: "analysis-1", createdAt: "2026-08-23T12:00:00.000Z" }],
    };
    reservoirItems = [
      reservoirItems[0],
      { ...reservoirItems[0], id: "source-2", title: "자료 B" },
    ];
    render(<ReservoirView />);

    await userEvent.click(await screen.findByRole("button", { name: /자료 A/ }));
    await userEvent.click(screen.getByText("이전 심층 정리 1개"));
    await userEvent.click(screen.getByRole("button", { name: /이전 정리/ }));
    await waitFor(() => expect(fetch).toHaveBeenCalledWith("/api/reservoir/source-1/deep-analysis/analysis-1"));
    await userEvent.click(screen.getByRole("button", { name: /자료 B/ }));
    expect(await screen.findByText("두 번째 자료 분석")).toBeInTheDocument();

    await act(async () => {
      resolveDeepHistory(new Response(JSON.stringify({ analysis: { profile: "precision", overview: "오래된 A 심층 정리", arguments: [], structure: [], quotes: [], connections: [], researchUses: [], limitations: [], meta: { sourceCharCount: 2400, analyzedCharCount: 2400, chunkCount: 1 } } })));
    });

    expect(screen.queryByText("오래된 A 심층 정리")).not.toBeInTheDocument();
    expect(screen.getByText("두 번째 자료 분석")).toBeInTheDocument();
  });

  it("keeps only the latest same-source deep-history result and error", async () => {
    let resolveFirstHistory: (response: Response) => void = () => undefined;
    let resolveSecondHistory: (response: Response) => void = () => undefined;
    pendingDeepHistory["analysis-1"] = new Promise((resolve) => { resolveFirstHistory = resolve; });
    pendingDeepHistory["analysis-2"] = new Promise((resolve) => { resolveSecondHistory = resolve; });
    currentSourceDetail = {
      ...sourceDetail,
      deepAnalysis: { profile: "precision", overview: "현재 A 심층 정리", arguments: [], structure: [], quotes: [], connections: [], researchUses: [], limitations: [], meta: { sourceCharCount: 2400, analyzedCharCount: 2400, chunkCount: 1 } },
      deepAnalysisHistory: [
        { id: "analysis-1", createdAt: "2026-08-23T12:00:00.000Z" },
        { id: "analysis-2", createdAt: "2026-08-24T12:00:00.000Z" },
      ],
    };
    render(<ReservoirView />);

    await userEvent.click(await screen.findByRole("button", { name: /자료 A/ }));
    await userEvent.click(screen.getByText("이전 심층 정리 2개"));
    const historyButtons = screen.getAllByRole("button", { name: /이전 정리/ });
    await userEvent.click(historyButtons[0]);
    await userEvent.click(historyButtons[1]);

    await act(async () => {
      resolveSecondHistory(new Response(JSON.stringify({ analysis: { profile: "precision", overview: "두 번째 이력", arguments: [], structure: [], quotes: [], connections: [], researchUses: [], limitations: [], meta: { sourceCharCount: 2400, analyzedCharCount: 2400, chunkCount: 1 } } })));
    });
    expect(screen.getByText("두 번째 이력")).toBeInTheDocument();

    await act(async () => {
      resolveFirstHistory(new Response("", { status: 500 }));
    });
    expect(screen.getByText("두 번째 이력")).toBeInTheDocument();
    expect(screen.queryByText("이전 심층 정리를 불러오지 못했습니다.")).not.toBeInTheDocument();
  });

  it("keeps a mobile list return action visible when detail loading fails", async () => {
    sourceOneDetailFailure = true;
    render(<ReservoirView />);
    await userEvent.click(await screen.findByRole("button", { name: /자료 A/ }));

    expect(await screen.findByText("자료 상세 내용을 불러오지 못했습니다.")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "목록으로" }));

    expect(screen.getByText("읽을 자료를 선택하세요")).toBeInTheDocument();
    expect(screen.getByTestId("split-workspace")).toHaveAttribute("data-mobile-pane", "index");
  });

  it("records a develop signal", async () => {
    render(<ReservoirView />);
    await userEvent.click(await screen.findByRole("button", { name: /자료 A/ }));
    await userEvent.click(screen.getByRole("button", { name: "판단하기" }));
    await userEvent.click(screen.getByRole("button", { name: "발전시키기" }));
    await waitFor(() => expect(fetch).toHaveBeenCalledWith("/api/signals", expect.objectContaining({ method: "POST", body: JSON.stringify({ sourceId: "source-1", action: "develop" }) })));
  });

  it("surfaces a failed decision in the reading view with a retry action", async () => {
    const user = userEvent.setup();
    decisionSignalFailure = "signal_failed";
    render(<ReservoirView />);

    await user.click(await screen.findByRole("button", { name: /자료 A/ }));
    await user.click(screen.getByRole("button", { name: "판단하기" }));
    await user.click(screen.getByRole("button", { name: "관찰하기" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("분류를 저장하지 못했습니다.");
    await user.click(within(alert).getByRole("button", { name: "다시 시도" }));

    await waitFor(() => expect(vi.mocked(fetch).mock.calls.filter(([input, init]) => (
      input === "/api/signals" && init?.method === "POST" && String(init.body).includes('"action":"watch"')
    ))).toHaveLength(2));
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
  });

  it("does not reselect an earlier source when its pending decision completes", async () => {
    let resolveDecision: (response: Response) => void = () => undefined;
    pendingDecisionSignal = new Promise((resolve) => { resolveDecision = resolve; });
    reservoirItems = [
      reservoirItems[0],
      { ...reservoirItems[0], id: "source-2", title: "자료 B" },
    ];
    render(<ReservoirView />);

    await userEvent.click(await screen.findByRole("button", { name: /자료 A/ }));
    await userEvent.click(screen.getByRole("button", { name: "판단하기" }));
    await userEvent.click(screen.getByRole("button", { name: "보관하기" }));
    await userEvent.click(screen.getByRole("button", { name: /자료 B/ }));
    expect(await screen.findByText("두 번째 자료 분석")).toBeInTheDocument();

    await act(async () => {
      resolveDecision(new Response(JSON.stringify({ ok: true })));
    });

    expect(screen.getByText("두 번째 자료 분석")).toBeInTheDocument();
    expect(screen.queryByText("시스템이 정리한 내용")).not.toBeInTheDocument();
  });

  it("does not reload a stale filter after a pending judgment completes", async () => {
    let resolveDecision: (response: Response) => void = () => undefined;
    pendingDecisionSignal = new Promise((resolve) => { resolveDecision = resolve; });
    render(<ReservoirView />);

    await userEvent.click(await screen.findByRole("button", { name: /자료 A/ }));
    await userEvent.click(screen.getByRole("button", { name: "판단하기" }));
    await userEvent.click(screen.getByRole("button", { name: "보관하기" }));
    await userEvent.click(screen.getByRole("button", { name: "관찰 중" }));
    await waitFor(() => expect(fetch).toHaveBeenCalledWith("/api/reservoir?decision=watching"));
    const activeLoadsBeforeCompletion = vi.mocked(fetch).mock.calls.filter(([url]) => url === "/api/reservoir?decision=active").length;

    await act(async () => {
      resolveDecision(new Response(JSON.stringify({ ok: true })));
    });

    await waitFor(() => expect(vi.mocked(fetch).mock.calls.filter(([url]) => url === "/api/reservoir?decision=active").length).toBe(activeLoadsBeforeCompletion));
    expect(screen.getByRole("button", { name: "관찰 중" })).toHaveClass("is-active");
  });

  it("runs deep analysis with the selected quality profile", async () => {
    render(<ReservoirView />);
    await userEvent.click(await screen.findByRole("button", { name: /자료 A/ }));
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "심층 정리 품질" }), "maximum");
    await userEvent.click(screen.getByRole("button", { name: "심층 정리하기" }));
    await waitFor(() => expect(fetch).toHaveBeenCalledWith("/api/reservoir/source-1/deep-analysis", expect.objectContaining({ method: "POST", body: JSON.stringify({ profile: "maximum" }) })));
  });

  it("refreshes the current detail when deep analysis finishes", async () => {
    const { rerender } = render(<ReservoirView jobs={[]} />);
    await userEvent.click(await screen.findByRole("button", { name: /자료 A/ }));
    await userEvent.click(screen.getByRole("button", { name: "심층 정리하기" }));
    await waitFor(() => expect(fetch).toHaveBeenCalledWith("/api/reservoir/source-1/deep-analysis", expect.objectContaining({ method: "POST" })));

    currentSourceDetail = {
      ...currentSourceDetail,
      deepAnalysis: {
        profile: "precision",
        overview: "완료된 심층 정리 결과",
        arguments: [],
        structure: [],
        quotes: [],
        connections: [],
        researchUses: [],
        limitations: [],
        meta: { sourceCharCount: 2400, analyzedCharCount: 2400, chunkCount: 1 },
      },
      deepAnalysisHistory: [{ id: "analysis-new", createdAt: "2026-08-28T12:00:10.000Z" }],
    };
    rerender(<ReservoirView jobs={[deepAnalysisJob("SUCCEEDED")]} />);

    expect(await screen.findByText("완료된 심층 정리 결과")).toBeInTheDocument();
    expect(vi.mocked(fetch).mock.calls.filter(([url]) => url === "/api/reservoir/source-1").length).toBeGreaterThan(1);
  });

  it("refreshes the current detail when visual extraction finishes", async () => {
    const { rerender } = render(<ReservoirView jobs={[]} />);
    await userEvent.click(await screen.findByRole("button", { name: /자료 A/ }));

    const visualRun: VisualExtractionRunSummary = {
      id: "run-visual-complete",
      parentSourceId: "source-1",
      parentVersionId: "version-source-1",
      originKind: "PDF_PAGE_CROP",
      status: "SUCCEEDED",
      totalUnits: 3,
      uploadedUnits: 3,
      processedUnits: 3,
      selectedCount: 1,
      reviewCount: 0,
      filteredCount: 2,
      unavailableCount: 0,
      errorCode: null,
      error: null,
      createdAt: "2026-08-28T12:00:00.000Z",
      updatedAt: "2026-08-28T12:00:10.000Z",
      finishedAt: "2026-08-28T12:00:10.000Z",
    };
    currentSourceDetail = { ...sourceDetail, visuals: [visualSummary], visualExtractionRun: visualRun };
    const visualJob: ResearchJob = {
      id: "visual-job-complete",
      workflowInstanceId: "workflow-visual-job-complete",
      kind: "VISUAL_EXTRACTION",
      status: "SUCCEEDED",
      progress: 100,
      message: "완료",
      input: { sourceId: "source-1", sourceVersionId: "version-source-1", extractionRunId: "run-visual-complete" },
      result: { extractionRunId: "run-visual-complete", counts: { selected: 1, review: 0, filtered: 2, unavailable: 0 } },
      resultRef: { view: "VISUAL", sourceId: "source-1", extractionRunId: "run-visual-complete" },
      errorCode: null,
      error: null,
      retryOf: null,
      requestedBy: "test-user",
      dedupeKey: "VISUAL_EXTRACTION:run-visual-complete",
      dismissedAt: null,
      createdAt: "2026-08-28T12:00:00.000Z",
      startedAt: "2026-08-28T12:00:01.000Z",
      finishedAt: "2026-08-28T12:00:10.000Z",
      updatedAt: "2026-08-28T12:00:10.000Z",
    };

    rerender(<ReservoirView jobs={[visualJob]} />);

    expect(await screen.findByRole("button", { name: /도판 1/ })).toBeInTheDocument();
    expect(vi.mocked(fetch).mock.calls.filter(([url]) => url === "/api/reservoir/source-1").length).toBeGreaterThan(1);
  });

  it("does not apply a late deep-analysis block after navigating to another source", async () => {
    let resolveDeepAnalysis: (response: Response) => void = () => undefined;
    pendingDeepAnalysis = new Promise((resolve) => { resolveDeepAnalysis = resolve; });
    reservoirItems = [reservoirItems[0], { ...reservoirItems[0], id: "source-2", title: "자료 B" }];
    render(<ReservoirView />);

    await userEvent.click(await screen.findByRole("button", { name: /자료 A/ }));
    await userEvent.click(screen.getByRole("button", { name: "심층 정리하기" }));
    await userEvent.click(screen.getByRole("button", { name: /자료 B/ }));
    expect(await screen.findByText("두 번째 자료 분석")).toBeInTheDocument();

    await act(async () => {
      resolveDeepAnalysis(new Response(JSON.stringify({
        error: "deep_analysis_text_not_ready",
        textScope: "METADATA_ONLY",
        qualityStatus: "REVIEW",
        charCount: 92,
      }), { status: 422 }));
    });

    expect(screen.getByText("두 번째 자료 분석")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "심층 정리하기" })).toBeEnabled();
    expect(screen.queryByText(/메타데이터만 저장되어 심층 정리를 시작할 수 없습니다/)).not.toBeInTheDocument();
  });

  it("does not show a late deep-analysis error after returning to the list", async () => {
    let resolveDeepAnalysis: (response: Response) => void = () => undefined;
    pendingDeepAnalysis = new Promise((resolve) => { resolveDeepAnalysis = resolve; });
    render(<ReservoirView />);

    await userEvent.click(await screen.findByRole("button", { name: /자료 A/ }));
    await userEvent.click(screen.getByRole("button", { name: "심층 정리하기" }));
    await userEvent.click(screen.getByRole("button", { name: "목록으로" }));
    await act(async () => {
      resolveDeepAnalysis(new Response(JSON.stringify({ error: "deep_analysis_failed" }), { status: 500 }));
    });

    expect(screen.getByText("읽을 자료를 선택하세요")).toBeInTheDocument();
    expect(screen.queryByText("deep_analysis_failed")).not.toBeInTheDocument();
  });

  it("blocks deep analysis with a clear reason for metadata-only text", async () => {
    deepAnalysisResult = {
      status: 422,
      body: {
        ok: false,
        error: "deep_analysis_text_not_ready",
        textScope: "METADATA_ONLY",
        qualityStatus: "REVIEW",
        charCount: 92,
      },
    };
    render(<ReservoirView />);
    await userEvent.click(await screen.findByRole("button", { name: /자료 A/ }));
    await userEvent.click(screen.getByRole("button", { name: "심층 정리하기" }));

    expect(await screen.findByText("메타데이터만 저장되어 심층 정리를 시작할 수 없습니다. 원문을 다시 가져온 뒤 시도해 주세요."))
      .toBeInTheDocument();
    expect(screen.getByRole("button", { name: "원문 다시 가져오기" })).toBeEnabled();
  });

  it("reanalyzes the current version without starting source acquisition", async () => {
    render(<ReservoirView />);
    await userEvent.click(await screen.findByRole("button", { name: /자료 A/ }));
    await userEvent.click(screen.getByRole("button", { name: "판단하기" }));
    await userEvent.click(screen.getByRole("button", { name: "다시 분석하기" }));

    await waitFor(() => expect(fetch).toHaveBeenCalledWith("/api/inbox/retry/source-1?analyze=1", { method: "POST" }));
    expect(fetch).not.toHaveBeenCalledWith("/api/inbox/retry/source-1?fetch=1", { method: "POST" });
  });

  it("does not reopen a source when its pending reanalysis completes after returning to the list", async () => {
    let resolveReanalysis: (response: Response) => void = () => undefined;
    pendingReanalysis = new Promise((resolve) => { resolveReanalysis = resolve; });
    render(<ReservoirView />);

    await userEvent.click(await screen.findByRole("button", { name: /자료 A/ }));
    await userEvent.click(screen.getByRole("button", { name: "판단하기" }));
    await userEvent.click(screen.getByRole("button", { name: "다시 분석하기" }));
    await userEvent.click(screen.getByRole("button", { name: "목록으로" }));

    await act(async () => {
      resolveReanalysis(new Response(JSON.stringify({ status: "analyzed" })));
    });

    expect(screen.getByText("읽을 자료를 선택하세요")).toBeInTheDocument();
    expect(screen.queryByText("시스템이 정리한 내용")).not.toBeInTheDocument();
  });

  it("refetches the canonical source without reanalyzing the current version", async () => {
    const onJobCreated = vi.fn().mockResolvedValue(undefined);
    render(<ReservoirView onJobCreated={onJobCreated} />);
    await userEvent.click(await screen.findByRole("button", { name: /자료 A/ }));
    await userEvent.click(screen.getByRole("button", { name: "판단하기" }));
    await userEvent.click(screen.getByRole("button", { name: "다시 가져오기" }));

    await waitFor(() => expect(fetch).toHaveBeenCalledWith("/api/inbox/retry/source-1?fetch=1", { method: "POST" }));
    expect(fetch).not.toHaveBeenCalledWith("/api/inbox/retry/source-1?analyze=1", { method: "POST" });
    expect(onJobCreated).toHaveBeenCalledOnce();
  });

  it("does not show a prior source's refetch failure after navigation", async () => {
    let resolveRefetch: (response: Response) => void = () => undefined;
    pendingRefetch = new Promise((resolve) => { resolveRefetch = resolve; });
    reservoirItems = [reservoirItems[0], { ...reservoirItems[0], id: "source-2", title: "자료 B" }];
    render(<ReservoirView />);

    await userEvent.click(await screen.findByRole("button", { name: /자료 A/ }));
    await userEvent.click(screen.getByRole("button", { name: "판단하기" }));
    await userEvent.click(screen.getByRole("button", { name: "다시 가져오기" }));
    await userEvent.click(screen.getByRole("button", { name: /자료 B/ }));
    expect(await screen.findByText("두 번째 자료 분석")).toBeInTheDocument();

    await act(async () => {
      resolveRefetch(new Response(JSON.stringify({ error: "A 원문 수집 실패" }), { status: 500 }));
    });

    expect(screen.getByText("두 번째 자료 분석")).toBeInTheDocument();
    expect(screen.queryByText("A 원문 수집 실패")).not.toBeInTheDocument();
  });

  it("disables refetch when the source has no canonical URL", async () => {
    currentSourceDetail = { ...sourceDetail, source: { ...sourceDetail.source, canonicalUrl: null } };
    render(<ReservoirView />);
    await userEvent.click(await screen.findByRole("button", { name: /자료 A/ }));
    await userEvent.click(screen.getByRole("button", { name: "판단하기" }));

    expect(screen.getByRole("button", { name: "다시 가져오기" })).toBeDisabled();
  });

  it("preserves the acquisition deep-analysis block before a paid request", async () => {
    currentSourceDetail = {
      ...sourceDetail,
      source: { ...sourceDetail.source, inputFormat: "URL_HTML", activeVersionId: "version-source-1" },
      acquisition: {
        ...sourceDetail.acquisition,
        textScope: "METADATA_ONLY",
        qualityStatus: "REVIEW",
        charCount: 92,
        acquisitionLabel: "메타데이터만 저장됨",
        canDeepAnalyze: false,
        originalTextUrl: null,
      },
    };
    render(<ReservoirView />);
    await userEvent.click(await screen.findByRole("button", { name: /자료 A/ }));

    expect(screen.getAllByRole("button", { name: "원문 다시 가져오기" })).toHaveLength(2);
    expect(screen.getAllByRole("button", { name: "원문 다시 가져오기" }).every((button) => !(button as HTMLButtonElement).disabled)).toBe(true);
    expect(screen.getByText(/메타데이터만.*검토 필요.*92자/)).toBeInTheDocument();
    expect(fetch).not.toHaveBeenCalledWith("/api/reservoir/source-1/deep-analysis", expect.anything());
  });

  it("does not offer web-source visual refetch while FULLTEXT quality is under review", async () => {
    currentSourceDetail = {
      ...sourceDetail,
      source: { ...sourceDetail.source, inputFormat: "URL_HTML" },
      acquisition: {
        ...sourceDetail.acquisition,
        qualityStatus: "REVIEW",
        charCount: 3_790,
        canDeepAnalyze: false,
        originalTextUrl: null,
      },
    };
    render(<ReservoirView />);
    await userEvent.click(await screen.findByRole("button", { name: /자료 A/ }));

    expect(screen.getByRole("button", { name: "품질 다시 검사" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "원문 다시 가져오기" })).not.toBeInTheDocument();
  });

  it("shows pdf visual extraction controls without disturbing the current reading pane", async () => {
    render(<ReservoirView />);
    await userEvent.click(await screen.findByRole("button", { name: /자료 A/ }));

    expect(screen.getByRole("button", { name: "시각 자료 찾기" })).toBeInTheDocument();
    expect(screen.getByText("시스템이 정리한 내용")).toBeInTheDocument();
  });

  it("offers PDF original recovery instead of a dead visual extraction button", async () => {
    currentSourceDetail = {
      ...sourceDetail,
      visualExtractionCapability: {
        state: "ORIGINAL_MISSING",
        canStart: false,
        sourceId: "source-1",
        sourceVersionId: "version-source-1",
        originalUrl: null,
        reasonCode: "pdf_original_not_preserved",
      },
    };
    render(<ReservoirView />);
    await userEvent.click(await screen.findByRole("button", { name: /자료 A/ }));

    expect(screen.queryByRole("button", { name: "시각 자료 찾기" })).not.toBeInTheDocument();
    expect(screen.getByText("텍스트만 보존된 PDF입니다.")).toBeInTheDocument();
    expect(screen.getByText(/시각 자료를 찾으려면 같은 자료의 원본 PDF를 다시 첨부하세요/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "원본 PDF 다시 첨부" })).toBeInTheDocument();
  });

  it("starts pdf visual extraction and then offers continue from the checkpoint", async () => {
    render(<ReservoirView />);
    await userEvent.click(await screen.findByRole("button", { name: /자료 A/ }));
    await userEvent.click(screen.getByRole("button", { name: "시각 자료 찾기" }));

    await waitFor(() => expect(pdfExtractionMocks.startOrResumePdfVisualExtraction).toHaveBeenCalledWith(expect.objectContaining({
      sourceId: "source-1",
      versionId: "version-source-1",
      originalUrl: "/api/reservoir/source-1/original?version=version-source-1",
    })));
    expect(await screen.findByText("40 / 85페이지 업로드됨")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "계속" })).toBeInTheDocument();
    expect(screen.getByText("시스템이 정리한 내용")).toBeInTheDocument();
  });

  it("locks the PDF action while visual candidate analysis is queued", async () => {
    pdfExtractionResult = {
      ...pdfExtractionResult,
      status: "QUEUED",
      uploadedPages: 85,
      remainingPages: 0,
      nextPageNumber: null,
    };
    pdfExtractionMocks.startOrResumePdfVisualExtraction.mockResolvedValue(pdfExtractionResult);

    render(<ReservoirView />);
    await userEvent.click(await screen.findByRole("button", { name: /자료 A/ }));
    await userEvent.click(screen.getByRole("button", { name: "시각 자료 찾기" }));

    const queuedButton = await screen.findByRole("button", { name: "시각 후보 분석 중…" });
    expect(queuedButton).toBeDisabled();
    expect(screen.getByText("페이지 준비가 끝났습니다. 백그라운드에서 시각 후보를 분석하고 있습니다.")).toBeInTheDocument();
  });

  it("hides pdf visual extraction controls for non-pdf sources", async () => {
    currentSourceDetail = {
      ...sourceDetail,
      source: { ...sourceDetail.source, inputFormat: "URL_HTML", activeVersionId: "version-source-1" },
    };
    render(<ReservoirView />);
    await userEvent.click(await screen.findByRole("button", { name: /자료 A/ }));

    expect(screen.queryByRole("button", { name: "시각 자료 찾기" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "계속" })).not.toBeInTheDocument();
  });

  it("replaces decision buttons with the current status badge", async () => {
    render(<ReservoirView />);
    await userEvent.click(await screen.findByRole("button", { name: "관찰 중" }));
    await userEvent.click(await screen.findByRole("button", { name: /자료 A/ }));
    expect(screen.getByText("현재 판단 · 관찰 중")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "판단 변경" }));
    expect(screen.getByText("현재 판단")).toBeInTheDocument();
    expect(screen.getAllByText("관찰 중").length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByRole("button", { name: "판단 변경" })).toHaveLength(1);
    expect(screen.queryByRole("button", { name: "보관하기" })).not.toBeInTheDocument();
  });

  it("assigns an unassigned personal visual to a chosen source version and synchronizes both panels", async () => {
    currentUnassignedVisuals = [unassignedVisualSummary];
    currentSourceDetail = {
      ...sourceDetail,
      visuals: [],
    };
    render(<ReservoirView />);

    await userEvent.click(await screen.findByRole("button", { name: /자료 A/ }));
    expect(await screen.findByText("시스템이 정리한 내용")).toBeInTheDocument();

    const unassignedSection = screen.getByLabelText("연결되지 않은 시각 자료");
    await userEvent.click(within(unassignedSection).getByRole("button", { name: /개인 업로드 이미지/ }));

    const combobox = await screen.findByRole("combobox", { name: "연결할 자료 검색" });
    await userEvent.type(combobox, "자료 A");
    await userEvent.click(screen.getByRole("button", { name: "자료 A에 연결" }));
    await userEvent.click(screen.getByRole("button", { name: "이 자료에 연결" }));

    await waitFor(() => expect(fetch).toHaveBeenCalledWith(
      "/api/visual-assets/asset-unassigned/assignment",
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({ sourceId: "source-1", sourceVersionId: "version-source-1" }),
      }),
    ));

    await waitFor(() => {
      expect(screen.queryByLabelText("연결되지 않은 시각 자료")).not.toBeInTheDocument();
    });
    expect(screen.getByRole("region", { name: "시각 자료" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /개인 업로드 이미지/ })).toBeInTheDocument();
  });

  it("shows the extraction status for the run opened from Job Center instead of a newer run", async () => {
    const latestRun: VisualExtractionRunSummary = {
      id: "run-latest",
      parentSourceId: "source-1",
      parentVersionId: "version-source-1",
      originKind: "PDF_PAGE_CROP",
      status: "SUCCEEDED",
      totalUnits: 85,
      uploadedUnits: 85,
      processedUnits: 85,
      selectedCount: 4,
      reviewCount: 0,
      filteredCount: 81,
      unavailableCount: 0,
      errorCode: null,
      error: null,
      createdAt: "2026-08-25T10:00:00.000Z",
      updatedAt: "2026-08-25T10:01:00.000Z",
      finishedAt: "2026-08-25T10:01:00.000Z",
    };
    currentFocusedExtractionRun = {
      ...latestRun,
      id: "run-focused",
      status: "PARTIAL",
      selectedCount: 1,
      reviewCount: 2,
      filteredCount: 3,
      finishedAt: null,
    };
    currentSourceDetail = { ...sourceDetail, visualExtractionRun: latestRun };

    render(<ReservoirView focusSourceId="source-1" focusExtractionRunId="run-focused" />);

    expect(await screen.findByText("일부 페이지 처리됨")).toBeInTheDocument();
    expect(fetch).toHaveBeenCalledWith("/api/visual-extraction/runs/run-focused");
  });

  it("keeps source selection, index scroll, reading scroll, and focus when the visual inspector closes", async () => {
    currentSourceDetail = {
      ...sourceDetail,
      visuals: [visualSummary],
    };
    render(<ReservoirView />);

    await userEvent.click(await screen.findByRole("button", { name: /자료 A/ }));
    const indexRegion = screen.getByRole("region", { name: "자료 목록" });
    const readingRegion = screen.getByRole("region", { name: "자료 읽기" });
    indexRegion.scrollTop = 140;
    readingRegion.scrollTop = 220;

    const visualCard = await screen.findByRole("button", { name: /도판 1/ });
    await userEvent.click(visualCard);
    expect(await screen.findByRole("complementary", { name: "시각 자료 상세" })).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "닫기" }));

    await waitFor(() => expect(visualCard).toHaveFocus());
    expect(screen.getByRole("button", { name: /자료 A/ })).toHaveAttribute("aria-current", "true");
    expect(indexRegion.scrollTop).toBe(140);
    expect(readingRegion.scrollTop).toBe(220);
  });

  it("keeps source selection, index scroll, reading scroll, and focus when the pdf progress sheet closes", async () => {
    setViewport(640);
    render(<ReservoirView />);

    await userEvent.click(await screen.findByRole("button", { name: /자료 A/ }));
    const indexRegion = screen.getByRole("region", { name: "자료 목록" });
    const readingRegion = screen.getByRole("region", { name: "자료 읽기" });
    indexRegion.scrollTop = 110;
    readingRegion.scrollTop = 260;

    const trigger = screen.getByRole("button", { name: "시각 자료 찾기" });
    trigger.focus();
    await userEvent.click(trigger);

    const dialog = await screen.findByRole("dialog", { name: "PDF 시각 자료 추출" });
    await userEvent.click(within(dialog).getByRole("button", { name: "닫기" }));

    await waitFor(() => expect(trigger).toHaveFocus());
    expect(screen.getByRole("button", { name: /자료 A/ })).toHaveAttribute("aria-current", "true");
    expect(indexRegion.scrollTop).toBe(110);
    expect(readingRegion.scrollTop).toBe(260);
  });

  it("traps focus inside the mobile pdf sheet, closes on Escape, and hides the background while open", async () => {
    const user = userEvent.setup();
    setViewport(640);
    const { container } = render(<ReservoirView />);

    await user.click(await screen.findByRole("button", { name: /자료 A/ }));
    const trigger = screen.getByRole("button", { name: "시각 자료 찾기" });
    await user.click(trigger);

    const dialog = await screen.findByRole("dialog", { name: "PDF 시각 자료 추출" });
    expect(container).toHaveAttribute("aria-hidden", "true");
    expect(container).toHaveAttribute("inert");
    expect(within(dialog).getByRole("button", { name: "닫기" })).toHaveFocus();

    await user.tab({ shift: true });
    expect(within(dialog).getByRole("button", { name: "시각 자료 찾기" })).toHaveFocus();

    await user.tab();
    expect(within(dialog).getByRole("button", { name: "닫기" })).toHaveFocus();

    await user.keyboard("{Escape}");

    await waitFor(() => expect(screen.queryByRole("dialog", { name: "PDF 시각 자료 추출" })).not.toBeInTheDocument());
    expect(container).not.toHaveAttribute("aria-hidden");
    expect(container).not.toHaveAttribute("inert");
    expect(trigger).toHaveFocus();
  });

  it("opens the visual inspector from the reservoir reading panel and shows the verified analysis by default", async () => {
    currentSourceDetail = {
      ...sourceDetail,
      visuals: [visualSummary],
    };
    render(<ReservoirView />);

    await userEvent.click(await screen.findByRole("button", { name: /자료 A/ }));
    await userEvent.click(await screen.findByRole("button", { name: /도판 1/ }));

    expect(await screen.findByRole("complementary", { name: "시각 자료 상세" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "사용자 검증" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByText("검증 피사체")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "원문에서 보기" })).toHaveAttribute("href", "https://example.com/figure-1");
  });
});
