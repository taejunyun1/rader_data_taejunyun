import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DiscoveryRunDiagnostics } from "@radar/shared/discoveryRun";
import DiscoveryRunSummary from "../components/discovery/DiscoveryRunSummary";
import FieldSignalRunSummary from "../components/discovery/FieldSignalRunSummary";
import DiscoverView from "./DiscoverView";

const candidate = { id: "candidate-1", openalexId: "https://openalex.org/W1", title: "자료 후보", authors: "저자", year: 2026, relevanceScore: 0.82, status: "CANDIDATE", queryUsed: "사진 연구", provider: "openalex", externalUrl: "https://doi.org/10.0000/example" };
const fieldSignal = {
  id: "signal-1",
  sourceId: "caa-news",
  sourceName: "CAA News",
  externalUrl: "https://www.collegeart.org/news/cfp-photography",
  title: "Call for Papers: Photography and Visual Culture",
  summary: "A conference on photography, AI, and image politics.",
  signalType: "CALL_FOR_PAPERS",
  publishedAt: "2026-08-20T00:00:00.000Z",
  eventAt: "2026-09-12T00:00:00.000Z",
  deadlineAt: "2026-08-31T00:00:00.000Z",
  matchedTerms: ["photography", "visual culture"],
  relevanceScore: 0.85,
  status: "NEW",
  createdAt: "2026-08-23T00:00:00.000Z",
  updatedAt: "2026-08-23T00:00:00.000Z",
};

beforeEach(() => {
  let fieldSignalStatus = "NEW";
  vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === "/api/discover/candidates/candidate-1/keep" && init?.method === "POST") return Promise.resolve(new Response(JSON.stringify({ ok: true, status: "KEPT", sourceId: "source-1" })));
    if (url.startsWith("/api/discover/signals?") && !init?.method) {
      const requestedStatus = url.match(/status=([^&]+)/)?.[1] ?? "NEW";
      return Promise.resolve(new Response(JSON.stringify({
        items: requestedStatus === fieldSignalStatus ? [{ ...fieldSignal, status: fieldSignalStatus }] : [],
      })));
    }
    if (url === "/api/discover/signals/signal-1/save" && init?.method === "POST") {
      fieldSignalStatus = "SAVED";
      return Promise.resolve(new Response(JSON.stringify({ ok: true, status: "SAVED" })));
    }
    if (url === "/api/discover/signals/signal-1/dismiss" && init?.method === "POST") {
      fieldSignalStatus = "DISMISSED";
      return Promise.resolve(new Response(JSON.stringify({ ok: true, status: "DISMISSED" })));
    }
    if (url === "/api/discover/signals/signal-1/restore" && init?.method === "POST") {
      fieldSignalStatus = "NEW";
      return Promise.resolve(new Response(JSON.stringify({ ok: true, status: "NEW" })));
    }
    if (url.startsWith("/api/discover/candidates")) return Promise.resolve(new Response(JSON.stringify({ items: [candidate] })));
    if (url === "/api/discover/queries") return Promise.resolve(new Response(JSON.stringify({ queries: [] })));
    if (url === "/api/discover/feeds") return Promise.resolve(new Response(JSON.stringify({ feeds: [] })));
    if (url === "/api/settings/homepage") return Promise.resolve(new Response(JSON.stringify({ projects: [] })));
    if (url === "/api/signals" && init?.method === "POST") return Promise.resolve(new Response(JSON.stringify({ ok: true })));
    return Promise.resolve(new Response(JSON.stringify({ ok: true })));
  }));
});

describe("DiscoverView", () => {
  it("keeps actual access links visible while reading a candidate", async () => {
    render(<DiscoverView onNavigate={vi.fn()} />);
    await userEvent.click(await screen.findByRole("option", { name: /자료 후보/ }));
    expect(screen.getByRole("dialog", { name: "읽은 뒤 판단" })).toBeInTheDocument();
    expect(screen.getAllByRole("link", { name: /서지·접근 정보/ })[1]).toHaveAttribute("href", "https://doi.org/10.0000/example");
    expect(screen.getByText("시스템 해석")).toBeInTheDocument();
    expect(screen.getByText("분석 내용 없음")).toBeInTheDocument();
  });

  it("maps 발전시키기 to keep plus a develop signal", async () => {
    const onNavigate = vi.fn();
    render(<DiscoverView onNavigate={onNavigate} />);
    await userEvent.click(await screen.findByRole("option", { name: /자료 후보/ }));
    await userEvent.click(screen.getByRole("button", { name: "발전시키기" }));
    await waitFor(() => expect(fetch).toHaveBeenCalledWith("/api/signals", expect.objectContaining({ method: "POST", body: JSON.stringify({ sourceId: "source-1", action: "develop" }) })));
    expect(onNavigate).toHaveBeenCalledWith("RESERVOIR");
  });

  it("opens diagnostics automatically when the run collected zero candidates", () => {
    const diagnostics: DiscoveryRunDiagnostics = {
      plannedQueries: 5,
      readyQueries: 5,
      executedQueries: 5,
      unsupportedQueries: 0,
      providers: {
        openalex: { requests: 5, succeededRequests: 5, failedRequests: 0, received: 20, missingAccess: 4, rejected: 12, duplicate: 2, quotaExcluded: 1, selected: 0, errorCodes: [] },
        arxiv: { requests: 2, succeededRequests: 2, failedRequests: 0, received: 8, missingAccess: 0, rejected: 8, duplicate: 0, quotaExcluded: 0, selected: 0, errorCodes: [] },
        rss: { requests: 3, succeededRequests: 3, failedRequests: 0, received: 24, missingAccess: 12, rejected: 12, duplicate: 0, quotaExcluded: 0, selected: 0, errorCodes: [] },
      },
      rejectedByReason: { NO_RESEARCH_ANCHOR: 20, ACCESS_UNKNOWN: 4 },
      existingReclassified: 0,
      incomplete: false,
    };
    render(<DiscoveryRunSummary collected={0} diagnostics={diagnostics} onAction={vi.fn()} />);
    expect(screen.getByText("새 후보 0개")).toBeInTheDocument();
    expect(screen.getByText("연구축 표현 부족")).toBeVisible();
  });

  it("labels a partial provider run without calling it a normal empty result", () => {
    const diagnostics: DiscoveryRunDiagnostics = {
      plannedQueries: 1,
      readyQueries: 1,
      executedQueries: 1,
      unsupportedQueries: 0,
      providers: {
        openalex: { requests: 1, succeededRequests: 0, failedRequests: 1, received: 0, missingAccess: 0, rejected: 0, duplicate: 0, quotaExcluded: 0, selected: 0, errorCodes: ["TIMEOUT"] },
        arxiv: { requests: 1, succeededRequests: 1, failedRequests: 0, received: 0, missingAccess: 0, rejected: 0, duplicate: 0, quotaExcluded: 0, selected: 0, errorCodes: [] },
        rss: { requests: 0, succeededRequests: 0, failedRequests: 0, received: 0, missingAccess: 0, rejected: 0, duplicate: 0, quotaExcluded: 0, selected: 0, errorCodes: [] },
      },
      rejectedByReason: {},
      existingReclassified: 0,
      incomplete: true,
    };
    render(<DiscoveryRunSummary collected={0} diagnostics={diagnostics} onAction={vi.fn()} />);
    expect(screen.getByText("일부 출처 확인 실패")).toBeInTheDocument();
  });

  it("separates automatic source status from the custom feed editor", async () => {
    render(<DiscoverView onNavigate={vi.fn()} />);
    await userEvent.click(screen.getByText("발견 범위와 수집 출처 조정"));

    expect(screen.getByRole("heading", { name: "사용자 추가 RSS·Atom 피드" })).toBeVisible();
    expect(screen.getByText(/기본 피드는 자동으로 적용됩니다/)).toBeVisible();
    expect(screen.getByRole("link", { name: "Unthinking Photography ↗" }).closest(".discovery-source__row")).toHaveTextContent("읽을거리 자동 수집");
    expect(screen.getByRole("link", { name: "CAA News ↗" }).closest(".discovery-source__row")).toHaveTextContent("현장 신호 자동 수집");
    expect(screen.getByRole("link", { name: "Artforum ↗" }).closest(".discovery-source__row")).toHaveTextContent("공식 RSS · 자동 수집 안 함");
  });

  it("shows field signals separately from reading candidates", async () => {
    render(<DiscoverView onNavigate={vi.fn()} />);
    await userEvent.click(screen.getByRole("tab", { name: "현장 신호" }));

    expect(await screen.findByRole("heading", { name: "Call for Papers: Photography and Visual Culture" })).toBeVisible();
    expect(screen.getByText("CAA News")).toBeVisible();
    expect(screen.getByText("마감 2026. 8. 31.")).toBeVisible();
    expect(screen.queryByRole("option", { name: /자료 후보/ })).not.toBeInTheDocument();
  });

  it("saves a field signal without promoting it to Reservoir", async () => {
    render(<DiscoverView onNavigate={vi.fn()} />);
    await userEvent.click(screen.getByRole("tab", { name: "현장 신호" }));
    await userEvent.click(await screen.findByRole("button", { name: "신호 저장" }));

    await waitFor(() => expect(fetch).toHaveBeenCalledWith(
      "/api/discover/signals/signal-1/save",
      { method: "POST" },
    ));
    expect(fetch).not.toHaveBeenCalledWith(expect.stringContaining("/api/signals"), expect.anything());
  });

  it("dismisses and restores a field signal within field-signal status filters", async () => {
    render(<DiscoverView onNavigate={vi.fn()} />);
    await userEvent.click(screen.getByRole("tab", { name: "현장 신호" }));
    await userEvent.click(await screen.findByRole("button", { name: "제외" }));

    await waitFor(() => expect(fetch).toHaveBeenCalledWith(
      "/api/discover/signals/signal-1/dismiss",
      { method: "POST" },
    ));
    await userEvent.click(screen.getByRole("button", { name: "제외됨" }));
    expect(await screen.findByRole("button", { name: "복구" })).toBeVisible();

    await userEvent.click(screen.getByRole("button", { name: "복구" }));
    await waitFor(() => expect(fetch).toHaveBeenCalledWith(
      "/api/discover/signals/signal-1/restore",
      { method: "POST" },
    ));
    await userEvent.click(screen.getByRole("button", { name: "새 신호" }));
    expect(await screen.findByRole("button", { name: "신호 저장" })).toBeVisible();
  });

  it("renders field-signal diagnostic reasons when no new signals were collected", () => {
    render(
      <FieldSignalRunSummary
        collected={0}
        diagnostics={{
          sources: {
            "caa-news": {
              requests: 2,
              succeededRequests: 2,
              failedRequests: 0,
              received: 8,
              rejected: 6,
              stale: 1,
              expired: 1,
              missingUrl: 1,
              duplicate: 1,
              quotaExcluded: 1,
              selected: 0,
              errorCodes: [],
            },
          },
          rejectedByReason: {
            NO_RESEARCH_MATCH: 1,
            STALE: 1,
            EXPIRED: 1,
            MISSING_URL: 1,
            DUPLICATE: 1,
            SOURCE_QUOTA: 1,
          },
          incomplete: false,
        }}
      />,
    );

    expect(screen.getByText("연구 일치 부족 1")).toBeVisible();
    expect(screen.getByText("오래됨 1")).toBeVisible();
    expect(screen.getByText("종료됨 1")).toBeVisible();
    expect(screen.getByText("링크 없음 1")).toBeVisible();
    expect(screen.getByText("중복 1")).toBeVisible();
    expect(screen.getByText("출처 상한 1")).toBeVisible();
  });

  it("shows partial-failure details for field-signal diagnostics", () => {
    render(
      <FieldSignalRunSummary
        collected={0}
        diagnostics={{
          sources: {
            "caa-news": {
              requests: 2,
              succeededRequests: 1,
              failedRequests: 1,
              received: 4,
              rejected: 2,
              stale: 0,
              expired: 0,
              missingUrl: 1,
              duplicate: 0,
              quotaExcluded: 1,
              selected: 1,
              errorCodes: ["TIMEOUT", "HTTP_500", "PARSE_ERROR"],
            },
          },
          rejectedByReason: {},
          incomplete: true,
        }}
      />,
    );

    expect(screen.getByText("일부 출처 확인 실패")).toBeVisible();
    expect(screen.getByText(/실패 1/)).toBeVisible();
    expect(screen.getByText(/링크 없음 1/)).toBeVisible();
    expect(screen.getByText(/상한 제외 1/)).toBeVisible();
    expect(screen.getByText(/오류 TIMEOUT, HTTP_500 \+1/)).toBeVisible();
  });

  it("uses tab semantics for the reading and field-signal switch", async () => {
    render(<DiscoverView onNavigate={vi.fn()} />);

    const tablist = screen.getByRole("tablist", { name: "발견 콘텐츠 종류" });
    expect(tablist).toBeVisible();
    expect(screen.getByRole("tab", { name: "읽을거리" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: "현장 신호" })).toHaveAttribute("aria-selected", "false");

    await userEvent.click(screen.getByRole("tab", { name: "현장 신호" }));
    expect(screen.getByRole("tab", { name: "읽을거리" })).toHaveAttribute("aria-selected", "false");
    expect(screen.getByRole("tab", { name: "현장 신호" })).toHaveAttribute("aria-selected", "true");
  });
});
