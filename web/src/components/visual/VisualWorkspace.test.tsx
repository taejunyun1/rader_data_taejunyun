import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { VisualAssetDetail, VisualAssetSummary } from "@radar/shared";
import VisualAssetPanel from "./VisualAssetPanel";

vi.mock("pdfjs-dist", () => ({
  GlobalWorkerOptions: { workerSrc: "" },
  getDocument: vi.fn(() => ({
    promise: Promise.resolve({
      destroy: vi.fn().mockResolvedValue(undefined),
      getPage: vi.fn().mockResolvedValue({
        getViewport: vi.fn(({ scale }: { scale: number }) => ({ width: 800 * scale, height: 1000 * scale })),
        render: vi.fn(() => ({ promise: Promise.resolve() })),
        cleanup: vi.fn(),
      }),
    }),
  })),
}));

function analysisPayload(seed: string) {
  return {
    observation: {
      subject: [`${seed} 피사체`],
      composition: [`${seed} 구도`],
      color: [`${seed} 색`],
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
    confidence: 0.72,
  };
}

function buildSummary(overrides: Partial<VisualAssetSummary> = {}): VisualAssetSummary {
  return {
    id: "asset-1",
    parentSourceId: "source-1",
    parentVersionId: "version-1",
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
      payload: analysisPayload("AI"),
      provenanceClass: "INTERPRETATION",
      confidence: 0.72,
      reviewStatus: "PENDING",
      modelId: "vision-low",
      promptVersion: "visual-v1",
      createdAt: "2026-08-25T10:00:00.000Z",
    },
    createdAt: "2026-08-25T10:00:00.000Z",
    updatedAt: "2026-08-25T10:00:00.000Z",
    ...overrides,
  };
}

function buildExtractionRun(overrides: Partial<VisualAssetDetail["extractionRun"]> = {}) {
  return {
    id: "run-1",
    parentSourceId: "source-1",
    parentVersionId: "version-1",
    originKind: "WEB_EMBED" as const,
    status: "SUCCEEDED" as const,
    totalUnits: 3,
    uploadedUnits: 3,
    processedUnits: 3,
    selectedCount: 1,
    reviewCount: 1,
    filteredCount: 1,
    unavailableCount: 0,
    errorCode: null,
    error: null,
    createdAt: "2026-08-25T10:12:00.000Z",
    updatedAt: "2026-08-25T10:13:00.000Z",
    finishedAt: "2026-08-25T10:14:00.000Z",
    ...overrides,
  };
}

function buildDetail(overrides: Partial<VisualAssetDetail> = {}): VisualAssetDetail {
  return {
    ...buildSummary(),
    candidateKey: "figure-1",
    bbox: null,
    nearbyText: "원문 첫 문단 옆에서 이 이미지를 설명합니다.",
    rightsBasis: "권리 검토 대기",
    rightsReviewedAt: "2026-08-25T10:00:00.000Z",
    autoSuggestion: {
      id: "analysis-auto",
      payload: analysisPayload("AI"),
      provenanceClass: "INTERPRETATION",
      confidence: 0.72,
      reviewStatus: "PENDING",
      modelId: "vision-low",
      promptVersion: "visual-v1",
      createdAt: "2026-08-25T10:00:00.000Z",
    },
    userVerified: {
      id: "analysis-user",
      payload: analysisPayload("검증"),
      provenanceClass: "INTERPRETATION",
      confidence: null,
      reviewStatus: "EDITED",
      modelId: null,
      promptVersion: null,
      createdAt: "2026-08-25T10:10:00.000Z",
    },
    relations: [
      {
        id: "relation-1",
        relationKind: "DUPLICATE_OF",
        createdBy: "SYSTEM",
        description: "유사 도판",
        toVisualAssetId: "asset-2",
        relatedSourceId: "source-2",
        relatedThreadId: null,
        createdAt: "2026-08-25T10:11:00.000Z",
      },
    ],
    extractionRun: {
      id: "run-1",
      parentSourceId: "source-1",
      parentVersionId: "version-1",
      originKind: "WEB_EMBED",
      status: "PARTIAL",
      totalUnits: 3,
      uploadedUnits: 3,
      processedUnits: 2,
      selectedCount: 1,
      reviewCount: 1,
      filteredCount: 0,
      unavailableCount: 1,
      errorCode: null,
      error: null,
      createdAt: "2026-08-25T10:12:00.000Z",
      updatedAt: "2026-08-25T10:13:00.000Z",
      finishedAt: null,
    },
    ...overrides,
  };
}

function setViewport(width: number) {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
  window.dispatchEvent(new Event("resize"));
}

describe("Visual workspace", () => {
  beforeEach(() => {
    setViewport(1280);
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: (query: string) => ({
        matches: query.includes("900") ? window.innerWidth <= 900 : false,
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      }),
    });
    HTMLCanvasElement.prototype.getContext = vi.fn(() => ({ drawImage: vi.fn(), clearRect: vi.fn() })) as unknown as typeof HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.toBlob = vi.fn((callback: BlobCallback) => callback?.(new Blob(["preview"], { type: "image/png" }))) as unknown as typeof HTMLCanvasElement.prototype.toBlob;
    globalThis.URL.createObjectURL = vi.fn(() => "blob:preview");
    globalThis.URL.revokeObjectURL = vi.fn();
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/visual-assets/asset-1") return Promise.resolve(new Response(JSON.stringify({ asset: buildDetail() })));
      if (url === "/api/visual-assets/asset-1/analysis" && init?.method === "PATCH") {
        return Promise.resolve(new Response(JSON.stringify({ error: "save_failed" }), { status: 500 }));
      }
      if (url === "/api/visual-assets/asset-1/retry" && init?.method === "POST") {
        return Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 202 }));
      }
      if (url === "/api/reservoir/source-1/original?version=version-1") {
        return Promise.resolve(new Response(new Blob(["%PDF-1.7"], { type: "application/pdf" })));
      }
      return Promise.resolve(new Response(JSON.stringify({})));
    }));
  });

  it("opens the inspector from a card click and defaults to the user-verified analysis with the full sections visible", async () => {
    render(<VisualAssetPanel assets={[buildSummary()]} />);

    await userEvent.click(screen.getByRole("button", { name: /도판 1/ }));

    const inspector = await screen.findByRole("complementary", { name: "시각 자료 상세" });
    expect(within(inspector).getByRole("tab", { name: "사용자 검증" })).toHaveAttribute("aria-selected", "true");
    expect(within(inspector).getByText("검증 피사체")).toBeInTheDocument();
    expect(within(inspector).getByText("검증 형태")).toBeInTheDocument();
    expect(within(inspector).getByText("검증 매체")).toBeInTheDocument();
    expect(within(inspector).getByText("검증 제안")).toBeInTheDocument();
    expect(within(inspector).getByText("검증 불확실성")).toBeInTheDocument();
    expect(within(inspector).getByText("근거 / 불확실성")).toBeInTheDocument();
    expect(within(inspector).getByText(/유사 도판/)).toBeInTheDocument();
    expect(within(inspector).getByText(/부분 완료/)).toBeInTheDocument();
    expect(within(inspector).getByText("후보 문맥")).toBeInTheDocument();
    expect(within(inspector).getByText(/후보 키/)).toHaveTextContent("figure-1");
  });

  it("rejects over-limit editor item counts without truncating loaded content", async () => {
    const payload = analysisPayload("검증") as Record<string, unknown>;
    const context = payload.context as Record<string, unknown>;
    context.medium = ["매체 1", "매체 2", "매체 3", "매체 4", "매체 5", "매체 6", "매체 7"];
    const detail = buildDetail({
      userVerified: { ...buildDetail().userVerified!, payload },
    });
    vi.mocked(fetch).mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/visual-assets/asset-1") return Promise.resolve(new Response(JSON.stringify({ asset: detail })));
      if (url === "/api/visual-assets/asset-1/analysis" && init?.method === "PATCH") {
        return Promise.resolve(new Response(JSON.stringify({ asset: buildSummary() })));
      }
      return Promise.resolve(new Response(JSON.stringify({})));
    });

    render(<VisualAssetPanel assets={[buildSummary()]} />);
    await userEvent.click(screen.getByRole("button", { name: /도판 1/ }));
    await userEvent.click(await screen.findByRole("button", { name: "분석 수정" }));
    await userEvent.click(screen.getByRole("button", { name: "저장" }));

    expect(await screen.findByText("매체 항목은 최대 6개까지 입력할 수 있습니다.")).toBeInTheDocument();
    expect(screen.getByDisplayValue("매체 7")).toBeInTheDocument();
    expect(vi.mocked(fetch).mock.calls.some(([input, init]) => String(input) === "/api/visual-assets/asset-1/analysis" && init?.method === "PATCH")).toBe(false);
  });

  it("rejects over-limit item lengths while keeping existing values visible and applying field maxLength", async () => {
    const payload = analysisPayload("검증") as Record<string, unknown>;
    const observation = payload.observation as Record<string, unknown>;
    const longObservation = "관".repeat(321);
    const longProposition = "제".repeat(501);
    observation.subject = [longObservation];
    payload.propositions = [longProposition];
    const detail = buildDetail({
      userVerified: { ...buildDetail().userVerified!, payload },
    });
    vi.mocked(fetch).mockImplementation((input: RequestInfo | URL) => {
      if (String(input) === "/api/visual-assets/asset-1") return Promise.resolve(new Response(JSON.stringify({ asset: detail })));
      return Promise.resolve(new Response(JSON.stringify({})));
    });

    render(<VisualAssetPanel assets={[buildSummary()]} />);
    await userEvent.click(screen.getByRole("button", { name: /도판 1/ }));
    await userEvent.click(await screen.findByRole("button", { name: "분석 수정" }));

    const observationInput = screen.getByDisplayValue(longObservation);
    const propositionInput = screen.getByDisplayValue(longProposition);
    expect(observationInput).toHaveAttribute("maxLength", "320");
    expect(screen.getByDisplayValue("검증 형태")).toHaveAttribute("maxLength", "320");
    expect(screen.getByDisplayValue("검증 매체")).toHaveAttribute("maxLength", "320");
    expect(screen.getByDisplayValue("검증 불확실성")).toHaveAttribute("maxLength", "320");
    expect(propositionInput).toHaveAttribute("maxLength", "500");

    await userEvent.click(screen.getByRole("button", { name: "저장" }));

    expect(await screen.findByText("관찰 1은 320자 이내로 입력해 주세요.")).toBeInTheDocument();
    expect(await screen.findByText("제안 1은 500자 이내로 입력해 주세요.")).toBeInTheDocument();
    expect(screen.getByDisplayValue(longObservation)).toBeInTheDocument();
    expect(screen.getByDisplayValue(longProposition)).toBeInTheDocument();
    expect(vi.mocked(fetch).mock.calls.some(([input, init]) => String(input) === "/api/visual-assets/asset-1/analysis" && init?.method === "PATCH")).toBe(false);
  });

  it("disables context add controls at the shared six-item cap", async () => {
    render(<VisualAssetPanel assets={[buildSummary()]} />);
    await userEvent.click(screen.getByRole("button", { name: /도판 1/ }));
    await userEvent.click(await screen.findByRole("button", { name: "분석 수정" }));

    const contextFields = [
      { label: "매체", initialCount: 1 },
      { label: "과정", initialCount: 0 },
      { label: "사진과의 관계", initialCount: 1 },
      { label: "문화 참조", initialCount: 0 },
    ] as const;
    for (const field of contextFields) {
      const group = within(screen.getByRole("heading", { name: field.label }).closest("section") as HTMLElement);
      for (let count = field.initialCount; count < 6; count += 1) {
        await userEvent.click(group.getByRole("button", { name: "항목 추가" }));
      }
      expect(group.getByRole("button", { name: "항목 추가" })).toBeDisabled();
    }
  });

  it("keeps edited analysis input on save failure and offers inline retry controls", async () => {
    render(<VisualAssetPanel assets={[buildSummary()]} />);
    await userEvent.click(screen.getByRole("button", { name: /도판 1/ }));
    await screen.findByRole("complementary", { name: "시각 자료 상세" });

    await userEvent.click(screen.getByRole("button", { name: "분석 수정" }));
    const propositionInput = await screen.findByDisplayValue("검증 제안");
    await userEvent.clear(propositionInput);
    await userEvent.type(propositionInput, "사용자 수정 제안");
    await userEvent.click(screen.getByRole("button", { name: "저장" }));

    expect(await screen.findByText("저장하지 못했습니다. 입력을 유지한 상태로 다시 시도해 주세요.")).toBeInTheDocument();
    expect(screen.getByDisplayValue("사용자 수정 제안")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "다시 저장" })).toBeInTheDocument();
  });

  it("shows a PDF LINK_ONLY crop preview and revokes the generated object URL when the inspector closes", async () => {
    render(<VisualAssetPanel assets={[buildSummary({ originKind: "PDF_PAGE_CROP", pageNumber: 4 })]} />);

    vi.mocked(fetch).mockImplementation((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/visual-assets/asset-1") {
        return Promise.resolve(new Response(JSON.stringify({
          asset: buildDetail({
            originKind: "PDF_PAGE_CROP",
            pageNumber: 4,
            bbox: { x: 0.1, y: 0.2, width: 0.3, height: 0.4, page: 4 },
          }),
        })));
      }
      if (url === "/api/reservoir/source-1/original?version=version-1") {
        return Promise.resolve(new Response(new Blob(["%PDF-1.7"], { type: "application/pdf" })));
      }
      return Promise.resolve(new Response(JSON.stringify({})));
    });

    await userEvent.click(screen.getByRole("button", { name: /도판 1/ }));
    expect(await screen.findByRole("img", { name: "PDF 잘라보기 미리보기" })).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "닫기" }));
    expect(globalThis.URL.revokeObjectURL).toHaveBeenCalledWith("blob:preview");
  });

  it("keeps web LINK_ONLY assets rights-safe by showing text context and the source link instead of hotlinking the image", async () => {
    render(<VisualAssetPanel assets={[buildSummary()]} />);
    await userEvent.click(screen.getByRole("button", { name: /도판 1/ }));

    const inspector = await screen.findByRole("complementary", { name: "시각 자료 상세" });
    expect(within(inspector).queryByRole("img", { name: /도판 1/ })).not.toBeInTheDocument();
    expect(within(inspector).getByText("원문 첫 문단 옆에서 이 이미지를 설명합니다.")).toBeInTheDocument();
    expect(within(inspector).getByRole("link", { name: "원문에서 보기" })).toHaveAttribute("href", "https://example.com/figure-1");
  });

  it("shows a single retry action with staged failure guidance instead of a raw technical error", async () => {
    vi.mocked(fetch).mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/visual-assets/asset-1") {
        return Promise.resolve(new Response(JSON.stringify({
          asset: buildDetail({
            processingStatus: "FAILED",
            autoSuggestion: null,
            userVerified: null,
            analysis: null,
          }),
        })));
      }
      if (url === "/api/visual-assets/asset-1/retry" && init?.method === "POST") {
        return Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 202 }));
      }
      return Promise.resolve(new Response(JSON.stringify({})));
    });

    render(<VisualAssetPanel assets={[buildSummary({ processingStatus: "FAILED", analysis: null })]} />);
    await userEvent.click(screen.getByRole("button", { name: /도판 1/ }));

    expect(await screen.findByText("원본 확인 → 미리보기 생성 → 분석 저장 단계 중 하나에서 멈췄습니다.")).toBeInTheDocument();
    const retryButton = screen.getByRole("button", { name: "다시 처리" });
    expect(screen.getAllByRole("button", { name: "다시 처리" })).toHaveLength(1);
    await userEvent.click(retryButton);
    await waitFor(() => expect(fetch).toHaveBeenCalledWith("/api/visual-assets/asset-1/retry", { method: "POST" }));
  });

  it("uses a bottom sheet on narrow screens and restores focus to the selected card when the sheet closes", async () => {
    setViewport(640);
    render(<VisualAssetPanel assets={[buildSummary()]} />);
    const card = screen.getByRole("button", { name: /도판 1/ });
    card.focus();
    await userEvent.click(card);

    expect(await screen.findByRole("dialog", { name: "시각 자료 상세" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "닫기" }));

    await waitFor(() => expect(card).toHaveFocus());
  });

  it("shows extraction state guidance for web and pdf sources before visible assets are ready", () => {
    const { rerender } = render(
      <VisualAssetPanel
        assets={[]}
        extractionContext={{ sourceKind: "WEB", run: null }}
      />,
    );

    expect(screen.getByText("시각 자료 확인 중")).toBeInTheDocument();
    expect(screen.getByText("저장된 웹 원문에서 연구 가치가 있는 이미지를 추리는 중입니다.")).toBeInTheDocument();

    rerender(
      <VisualAssetPanel
        assets={[]}
        extractionContext={{ sourceKind: "PDF", run: null }}
      />,
    );

    expect(screen.getByText("PDF 시각 자료는 직접 시작해야 합니다.")).toBeInTheDocument();
    expect(screen.getByText("PDF는 브라우저에서 페이지를 나눠 올려야 해서 자동으로 시작하지 않습니다.")).toBeInTheDocument();
  });

  it("distinguishes empty and status states for no images, all filtered, review needed, rights-safe link-only, and failures", () => {
    const { rerender } = render(
      <VisualAssetPanel
        assets={[]}
        extractionContext={{ sourceKind: "WEB", run: buildExtractionRun({ totalUnits: 0, processedUnits: 0, selectedCount: 0, reviewCount: 0, filteredCount: 0, unavailableCount: 0 }) }}
      />,
    );
    expect(screen.getByText("이미지 없음")).toBeInTheDocument();

    rerender(
      <VisualAssetPanel
        assets={[
          buildSummary({ id: "filtered-1", selectionStatus: "DECORATIVE", selectionReason: "visual-filter-v1:decorative_signal" }),
          buildSummary({ id: "filtered-2", selectionStatus: "DUPLICATE", selectionReason: "visual-filter-v1:duplicate_exact" }),
        ]}
        extractionContext={{ sourceKind: "WEB", run: buildExtractionRun({ selectedCount: 0, reviewCount: 0, filteredCount: 2 }) }}
      />,
    );
    expect(screen.getByText("모두 필터됨")).toBeInTheDocument();

    rerender(
      <VisualAssetPanel
        assets={[buildSummary({ id: "review-1", selectionStatus: "REVIEW" })]}
        extractionContext={{ sourceKind: "WEB", run: buildExtractionRun({ selectedCount: 0, reviewCount: 1, filteredCount: 0 }) }}
      />,
    );
    expect(screen.getByText("일부 확인 필요")).toBeInTheDocument();

    rerender(
      <VisualAssetPanel
        assets={[buildSummary({ id: "link-only-1", storageState: "LINK_ONLY", rightsStatus: "UNKNOWN", selectionStatus: "SELECTED" })]}
        extractionContext={{ sourceKind: "WEB", run: buildExtractionRun({ selectedCount: 1, reviewCount: 0, filteredCount: 0 }) }}
      />,
    );
    expect(screen.getByText("권리 때문에 링크만 보존")).toBeInTheDocument();

    rerender(
      <VisualAssetPanel
        assets={[buildSummary({ id: "failed-1", processingStatus: "FAILED", analysis: null })]}
        extractionContext={{ sourceKind: "WEB", run: buildExtractionRun({ status: "FAILED", error: "workflow_runtime_failed" }) }}
      />,
    );
    expect(screen.getByRole("heading", { name: "처리 실패" })).toBeInTheDocument();
  });

  it("hides filtered assets behind a disclosure and recovers decorative or duplicate items through explicit user action", async () => {
    vi.mocked(fetch).mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/visual-assets/asset-review") return Promise.resolve(new Response(JSON.stringify({ asset: buildDetail({ id: "asset-review", selectionStatus: "REVIEW" }) })));
      if (url === "/api/visual-assets/asset-dup/selection" && init?.method === "PATCH") {
        return Promise.resolve(new Response(JSON.stringify({
          asset: buildSummary({
            id: "asset-dup",
            caption: "중복 후보",
            selectionStatus: "REVIEW",
            selectionReason: "사용자가 필터링된 이미지를 검토 목록으로 복구함",
          }),
        })));
      }
      return Promise.resolve(new Response(JSON.stringify({})));
    });

    render(
      <VisualAssetPanel
        assets={[
          buildSummary({ id: "asset-review", selectionStatus: "REVIEW", caption: "검토 필요 이미지" }),
          buildSummary({ id: "asset-dup", selectionStatus: "DUPLICATE", selectionReason: "visual-filter-v1:duplicate_exact", caption: "중복 후보" }),
          buildSummary({ id: "asset-deco", selectionStatus: "DECORATIVE", selectionReason: "visual-filter-v1:decorative_signal", caption: "장식 이미지" }),
          buildSummary({ id: "asset-unavailable", selectionStatus: "UNAVAILABLE", selectionReason: "visual-filter-v1:unavailable_fetch_timeout", caption: "열 수 없는 이미지" }),
        ]}
        extractionContext={{ sourceKind: "WEB", run: buildExtractionRun({ selectedCount: 0, reviewCount: 1, filteredCount: 3, unavailableCount: 1 }) }}
      />,
    );

    expect(screen.getByRole("button", { name: /검토 필요 이미지/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /중복 후보/ })).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "필터링된 이미지 3개" }));
    expect(screen.getByText("중복 1개")).toBeInTheDocument();
    expect(screen.getByText("장식/광고 1개")).toBeInTheDocument();
    expect(screen.getByText("열 수 없음 1개")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "중복 후보 검토 목록으로 복구" }));

    await waitFor(() => expect(fetch).toHaveBeenCalledWith(
      "/api/visual-assets/asset-dup/selection",
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({ selectionStatus: "REVIEW" }),
      }),
    ));
    expect(await screen.findByRole("button", { name: /중복 후보/ })).toBeInTheDocument();
  });
});
