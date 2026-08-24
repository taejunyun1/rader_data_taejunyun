import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import ReservoirView from "./ReservoirView";

const sourceDetail = {
  source: { id: "source-1", title: "자료 A", authors: "저자", kind: "PAPER_ACADEMIC", reliability: "PRIMARY", origin: "upload", year: 2025, canonicalUrl: "https://example.com/paper" as string | null, provenanceClass: "SOURCE", createdAt: "2026-08-21", markedForNextResearch: 1 },
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
  source: { ...sourceDetail.source, id: "source-2", title: "자료 B" },
  acquisition: { ...sourceDetail.acquisition, originalTextUrl: "/api/reservoir/source-2/original-text" },
  analysis: { ...sourceDetail.analysis, summary: "두 번째 자료 분석" },
};

let deepAnalysisResult: { status: number; body: Record<string, unknown> };
type TestSourceDetail = Omit<typeof sourceDetail, "source" | "acquisition"> & {
  source: Omit<typeof sourceDetail.source, "canonicalUrl"> & { canonicalUrl: string | null };
  acquisition: Omit<typeof sourceDetail.acquisition, "textScope" | "originalTextUrl"> & {
    textScope: "FULLTEXT" | "PARTIAL" | "METADATA_ONLY" | "EMPTY" | "UNKNOWN";
    originalTextUrl: string | null;
  };
};

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
let viewSignalFailure = false;
let sourceOneDetailFailure = false;

beforeEach(() => {
  let requestedWatching = false;
  deepAnalysisResult = { status: 202, body: { job: { id: "deep-job" }, reused: false } };
  currentSourceDetail = sourceDetail;
  reservoirItems = [{ id: "source-1", title: "자료 A", kind: "PAPER_ACADEMIC", reliability: "PRIMARY", status: "indexed", origin: "upload", year: 2025, canonicalUrl: "https://example.com/paper", createdAt: "2026-08-21", topics: "[\"사진\"]", keywordCount: 1, signalCount: 0, markedForNextResearch: 1, decisionStatus: null }];
  pendingSourceOneDetail = null;
  pendingSearch = null;
  pendingDeepHistory = {};
  pendingDecisionSignal = null;
  pendingReanalysis = null;
  pendingDeepAnalysis = null;
  pendingRefetch = null;
  pendingReservoirLists = {};
  viewSignalFailure = false;
  sourceOneDetailFailure = false;
  vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === "/api/reservoir" || url.startsWith("/api/reservoir?")) {
      if (pendingReservoirLists[url]) return pendingReservoirLists[url];
      const decisionStatus = url.includes("decision=watching") ? "watch" : null;
      requestedWatching = decisionStatus === "watch";
      return Promise.resolve(new Response(JSON.stringify({ items: reservoirItems.map((item) => ({ ...item, decisionStatus })) })));
    }
    if (url === "/api/reservoir/topics") return Promise.resolve(new Response(JSON.stringify({ topics: [] })));
    if (url.startsWith("/api/search?") && pendingSearch) return pendingSearch;
    if (url === "/api/reservoir/source-1" && pendingSourceOneDetail) return pendingSourceOneDetail;
    if (url === "/api/reservoir/source-1" && sourceOneDetailFailure) return Promise.resolve(new Response("", { status: 500 }));
    if (url === "/api/reservoir/source-1") return Promise.resolve(new Response(JSON.stringify(requestedWatching ? { ...currentSourceDetail, source: { ...currentSourceDetail.source, decisionStatus: "watch" } } : currentSourceDetail)));
    if (url === "/api/reservoir/source-2") return Promise.resolve(new Response(JSON.stringify(sourceDetailB)));
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

  it("runs deep analysis with the selected quality profile", async () => {
    render(<ReservoirView />);
    await userEvent.click(await screen.findByRole("button", { name: /자료 A/ }));
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "심층 정리 품질" }), "maximum");
    await userEvent.click(screen.getByRole("button", { name: "심층 정리하기" }));
    await waitFor(() => expect(fetch).toHaveBeenCalledWith("/api/reservoir/source-1/deep-analysis", expect.objectContaining({ method: "POST", body: JSON.stringify({ profile: "maximum" }) })));
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
    expect(screen.getByRole("button", { name: "원문 수집 필요" })).toBeDisabled();
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

    expect(screen.getByRole("button", { name: "원문 수집 필요" })).toBeDisabled();
    expect(screen.getByText(/METADATA_ONLY.*REVIEW.*92자/)).toBeInTheDocument();
    expect(fetch).not.toHaveBeenCalledWith("/api/reservoir/source-1/deep-analysis", expect.anything());
  });

  it("replaces decision buttons with the current status badge", async () => {
    render(<ReservoirView />);
    await userEvent.click(await screen.findByRole("button", { name: "관찰 중" }));
    await userEvent.click(await screen.findByRole("button", { name: /자료 A/ }));
    expect(screen.getByText("현재 판단 · 관찰 중")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "판단 변경" }));
    expect(screen.getByText("현재 판단")).toBeInTheDocument();
    expect(screen.getAllByText("관찰 중").length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByRole("button", { name: "판단 변경" })).toHaveLength(2);
    expect(screen.queryByRole("button", { name: "보관하기" })).not.toBeInTheDocument();
  });
});
