# Radar Quantitative Overview Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 레이더 최상단에 선택 기간의 정량 요약을 배치하고, 하단에 반복되는 통계·키워드·질문 표현을 제거해 `정량 요약 → 해석 → 읽기와 판단 → 상세 정보` 흐름을 만든다.

**Architecture:** 기존 `/api/radar/stats` 응답을 그대로 사용하고 프론트엔드 표현 계층만 재구성한다. 순수 변환 함수는 `radarPresentation.ts`로 분리하고, 그래픽은 의존성 없는 `RadarOverview` React 컴포넌트로 캡슐화한다. `RadarView`는 데이터 로딩과 화면 조합만 담당하며 저장된 synthesis 원본은 변경하지 않는다.

**Tech Stack:** Vite 8, React 19, TypeScript 5.9, Vitest 4, Testing Library, 기존 CSS 토큰

## Global Constraints

- 제품 원칙은 Cloudflare-first / External-minimal / Serverless-first / Reservoir-first / Model-agnostic을 유지한다.
- 원본과 snapshot은 삭제·변형하지 않고 화면 표현만 필터링한다.
- 신규 런타임·차트 의존성을 추가하지 않는다.
- UI는 한국어 중심이며 원문 키워드는 한글 표시명 아래에만 병기한다.
- 넓은 컬러 배경과 장식용 그래픽을 사용하지 않고 `--color-accent: #6547ff`를 핵심 신호에만 사용한다.
- Snapshot은 자동 준비하고 Radar synthesis는 기존처럼 사용자 실행으로 유지한다.
- 실제 원문 중복 병합, 키워드 의미 정규화, 지난 기간 대비 증감률은 범위 밖이다.
- 커밋 메시지는 `YYMMDD: 업데이트 주요 내용 축약` 형식을 사용한다.

---

## File Map

| 파일 | 책임 |
|---|---|
| `web/src/lib/radarPresentation.ts` | Radar 통계 타입, 판단·자료 구성 정렬, synthesis 중복 섹션 필터 |
| `web/src/lib/radarPresentation.test.ts` | 순수 변환 함수의 정렬·필터·빈 데이터 검증 |
| `web/src/components/radar/RadarOverview.tsx` | 핵심 수치와 관심 신호·판단 분포·저장소 구성 렌더링 |
| `web/src/components/radar/RadarOverview.test.tsx` | 정량 요약의 값·레이블·원문 병기·행동 제외 검증 |
| `web/src/views/RadarView.tsx` | 정량 요약을 최상단에 조합하고 반복 섹션 제거 |
| `web/src/views/RadarView.test.tsx` | 화면 순서, synthesis 필터, 기간 전환 회귀 테스트 |
| `web/src/styles/views.css` | Radar overview, 막대, 상세 영역, 반응형 레이아웃 |
| `web/tests/e2e/core-reading-flow.spec.ts` | 실제 브라우저에서 정량 요약→발견 이동 핵심 흐름 검증 |
| `docs/PROJECT_CONTEXT.md` | 변경된 Radar 읽기 순서와 통계 기간 의미 기록 |

---

### Task 1: Radar 표현 모델과 중복 제거 규칙

**Files:**
- Create: `web/src/lib/radarPresentation.ts`
- Create: `web/src/lib/radarPresentation.test.ts`

**Interfaces:**
- Produces: `RadarStats`
- Produces: `DecisionRow`
- Produces: `CompositionRow`
- Produces: `decisionRows(signalCounts: Record<string, number>): DecisionRow[]`
- Produces: `compositionRows(kindBreakdown: Record<string, number>, limit?: number): CompositionRow[]`
- Produces: `visibleSynthesisSections(sections: SynthesisSection[]): SynthesisSection[]`

- [ ] **Step 1: 순수 변환 함수의 실패 테스트를 작성한다**

Create `web/src/lib/radarPresentation.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { compositionRows, decisionRows, visibleSynthesisSections } from "./radarPresentation";

describe("radarPresentation", () => {
  it("keeps only human decision actions in a fixed order", () => {
    expect(decisionRows({ import: 8, view: 4, keep: 2, ignore: 1, develop: 3, watch: 0 })).toEqual([
      { action: "develop", label: "발전", count: 3, percent: 50 },
      { action: "keep", label: "보관", count: 2, percent: 33 },
      { action: "watch", label: "관찰", count: 0, percent: 0 },
      { action: "ignore", label: "제외", count: 1, percent: 17 },
    ]);
  });

  it("groups source kinds after the visible limit into 기타", () => {
    expect(compositionRows({ NOTE: 10, WEB: 8, PAPER_ACADEMIC: 4, PERSONAL_WORK: 2 }, 3)).toEqual([
      { kind: "NOTE", label: "메모", count: 10, percent: 42 },
      { kind: "WEB", label: "웹 자료", count: 8, percent: 33 },
      { kind: "OTHER", label: "기타", count: 6, percent: 25 },
    ]);
  });

  it("removes sections already owned by quantitative and question areas", () => {
    const sections = [
      { heading: "이번 주 새로 떠오른 키워드", items: ["사진"] },
      { heading: "반복해서 남은 질문", items: ["무엇을 읽을까"] },
      { heading: "멀리 있는 자료 사이의 새 연결", items: ["연결 A"] },
      { heading: "예상 밖의 자료", items: ["자료 B"] },
    ];
    expect(visibleSynthesisSections(sections)).toEqual([
      { heading: "멀리 있는 자료 사이의 새 연결", items: ["연결 A"] },
      { heading: "예상 밖의 자료", items: ["자료 B"] },
    ]);
  });
});
```

- [ ] **Step 2: 테스트가 실패하는지 확인한다**

Run:

```bash
pnpm --filter @radar/web exec vitest run src/lib/radarPresentation.test.ts
```

Expected: FAIL with `Failed to resolve import "./radarPresentation"`.

- [ ] **Step 3: 표현 모델과 변환 함수를 구현한다**

Create `web/src/lib/radarPresentation.ts`:

```ts
import { labelOf, SOURCE_KIND_LABELS } from "./labels";

export interface KeywordCount {
  keyword: string;
  count: number;
}

export interface RadarStats {
  newSources: number;
  newKeywords: KeywordCount[];
  newQuestions: string[];
  signalCounts: Record<string, number>;
  topKeptSources: { title: string; kind: string }[];
  distillRuns: number;
  gapsRaised: number;
  readingQueueSize: number;
  kindBreakdown: Record<string, number>;
}

export interface SynthesisSection {
  heading: string;
  items: string[];
}

export interface DecisionRow {
  action: "develop" | "keep" | "watch" | "ignore";
  label: string;
  count: number;
  percent: number;
}

export interface CompositionRow {
  kind: string;
  label: string;
  count: number;
  percent: number;
}

const DECISIONS = [
  { action: "develop", label: "발전" },
  { action: "keep", label: "보관" },
  { action: "watch", label: "관찰" },
  { action: "ignore", label: "제외" },
] as const;

const DUPLICATE_SYNTHESIS_HEADINGS = new Set([
  "이번 주 새로 떠오른 키워드",
  "반복해서 남은 질문",
  "아직 풀리지 않은 질문",
  "집중이 과한 영역",
]);

export function decisionRows(signalCounts: Record<string, number>): DecisionRow[] {
  const total = DECISIONS.reduce((sum, item) => sum + (signalCounts[item.action] ?? 0), 0);
  return DECISIONS.map((item) => {
    const count = signalCounts[item.action] ?? 0;
    return { ...item, count, percent: total ? Math.round((count / total) * 100) : 0 };
  });
}

export function compositionRows(kindBreakdown: Record<string, number>, limit = 6): CompositionRow[] {
  const entries = Object.entries(kindBreakdown).sort((a, b) => b[1] - a[1]);
  const total = entries.reduce((sum, [, count]) => sum + count, 0);
  const visible = entries.slice(0, Math.max(limit - 1, 0));
  const overflow = entries.slice(Math.max(limit - 1, 0)).reduce((sum, [, count]) => sum + count, 0);
  const grouped = overflow > 0 ? [...visible, ["OTHER", overflow] as const] : entries.slice(0, limit);
  return grouped.map(([kind, count]) => ({
    kind,
    label: kind === "OTHER" ? "기타" : labelOf(SOURCE_KIND_LABELS, kind),
    count,
    percent: total ? Math.round((count / total) * 100) : 0,
  }));
}

export function visibleSynthesisSections(sections: SynthesisSection[]): SynthesisSection[] {
  return sections.filter((section) => !DUPLICATE_SYNTHESIS_HEADINGS.has(section.heading));
}
```

- [ ] **Step 4: 단위 테스트와 타입 검사를 실행한다**

Run:

```bash
pnpm --filter @radar/web exec vitest run src/lib/radarPresentation.test.ts
pnpm --filter @radar/web typecheck
```

Expected: both commands exit 0; three unit tests pass.

- [ ] **Step 5: 커밋한다**

```bash
git add web/src/lib/radarPresentation.ts web/src/lib/radarPresentation.test.ts
git commit -m "260822: 레이더 정량 표현 규칙 분리"
```

---

### Task 2: 최상단 정량 요약 컴포넌트

**Files:**
- Create: `web/src/components/radar/RadarOverview.tsx`
- Create: `web/src/components/radar/RadarOverview.test.tsx`
- Modify: `web/src/styles/views.css:84-116`

**Interfaces:**
- Consumes: `RadarStats`, `decisionRows`, `compositionRows` from Task 1
- Consumes: `KEYWORD_LABELS`, `labelOf` from `web/src/lib/labels.ts`
- Produces: `RadarOverview({ stats, periodLabel }: { stats: RadarStats; periodLabel: string })`

- [ ] **Step 1: 정량 요약의 실패 테스트를 작성한다**

Create `web/src/components/radar/RadarOverview.test.tsx`:

```tsx
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import RadarOverview from "./RadarOverview";
import type { RadarStats } from "../../lib/radarPresentation";

const stats: RadarStats = {
  newSources: 103,
  newKeywords: [
    { keyword: "photography", count: 25 },
    { keyword: "machine-vision", count: 18 },
  ],
  newQuestions: [],
  signalCounts: { develop: 5, keep: 3, watch: 2, ignore: 1, import: 113, view: 33 },
  topKeptSources: [],
  distillRuns: 7,
  gapsRaised: 19,
  readingQueueSize: 31,
  kindBreakdown: { NOTE: 51, WEB: 36, PERSONAL_WORK: 10, PAPER_ACADEMIC: 4 },
};

describe("RadarOverview", () => {
  it("shows period metrics before three quantitative groups", () => {
    render(<RadarOverview stats={stats} periodLabel="이번 주" />);
    const overview = screen.getByRole("region", { name: "이번 주 정량 요약" });
    expect(within(overview).getByText("103")).toBeInTheDocument();
    expect(within(overview).getByRole("heading", { name: "관심 신호" })).toBeInTheDocument();
    expect(within(overview).getByRole("heading", { name: "판단 분포" })).toBeInTheDocument();
    expect(within(overview).getByRole("heading", { name: "저장소 구성" })).toBeInTheDocument();
  });

  it("shows Korean keyword labels with the original below", () => {
    render(<RadarOverview stats={stats} periodLabel="이번 주" />);
    expect(screen.getByText("사진")).toBeInTheDocument();
    expect(screen.getByText("photography")).toBeInTheDocument();
  });

  it("does not count import and view as decisions", () => {
    render(<RadarOverview stats={stats} periodLabel="이번 주" />);
    const decisions = screen.getByLabelText("이번 주 판단 분포");
    expect(within(decisions).queryByText("가져오기")).not.toBeInTheDocument();
    expect(within(decisions).queryByText("열람")).not.toBeInTheDocument();
    expect(within(decisions).getByText("발전")).toBeInTheDocument();
  });

  it("labels all-time composition and gives empty charts readable messages", () => {
    render(<RadarOverview stats={{ ...stats, newKeywords: [], signalCounts: {}, kindBreakdown: {} }} periodLabel="이번 달" />);
    expect(screen.getByText("숫자는 선택한 기간 기준이며, 저장소 구성만 전체 누적입니다.")).toBeInTheDocument();
    expect(screen.getByText("이 기간에 새롭게 집계된 키워드가 없습니다.")).toBeInTheDocument();
    expect(screen.getByText("이 기간에 남긴 판단이 없습니다.")).toBeInTheDocument();
    expect(screen.getByText("저장소에 집계된 자료가 없습니다.")).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: 테스트가 실패하는지 확인한다**

Run:

```bash
pnpm --filter @radar/web exec vitest run src/components/radar/RadarOverview.test.tsx
```

Expected: FAIL with `Failed to resolve import "./RadarOverview"`.

- [ ] **Step 3: 정량 요약 컴포넌트를 구현한다**

Create `web/src/components/radar/RadarOverview.tsx`:

```tsx
import { KEYWORD_LABELS, labelOf } from "../../lib/labels";
import { compositionRows, decisionRows, type RadarStats } from "../../lib/radarPresentation";

function Bar({ percent }: { percent: number }) {
  return <span className="radar-bar" aria-hidden="true"><span style={{ width: `${Math.max(percent, percent ? 6 : 0)}%` }} /></span>;
}

export default function RadarOverview({ stats, periodLabel }: { stats: RadarStats; periodLabel: string }) {
  const keywords = stats.newKeywords.slice(0, 6);
  const keywordMax = Math.max(...keywords.map((item) => item.count), 1);
  const decisions = decisionRows(stats.signalCounts);
  const composition = compositionRows(stats.kindBreakdown);
  const hasDecisions = decisions.some((item) => item.count > 0);

  return <section className="radar-overview" aria-label={`${periodLabel} 정량 요약`}>
    <div className="radar-overview__heading">
      <div><p className="reading-section__label">이번 기간 요약</p><h2>{periodLabel} 연구 상태</h2></div>
      <p>숫자는 선택한 기간 기준이며, 저장소 구성만 전체 누적입니다.</p>
    </div>
    <div className="radar-metrics">
      <div><span>새 자료</span><strong>{stats.newSources}</strong></div>
      <div><span>착즙</span><strong>{stats.distillRuns}</strong></div>
      <div><span>연구 공백</span><strong>{stats.gapsRaised}</strong></div>
      <div><span>읽기 큐</span><strong>{stats.readingQueueSize}</strong></div>
    </div>
    <div className="radar-overview__charts">
      <section><h3>관심 신호</h3><p>이 기간에 새로 자주 등장한 키워드</p>
        {keywords.length ? <ol className="radar-chart-list" aria-label={`${periodLabel} 관심 신호`}>
          {keywords.map((item) => { const translated = labelOf(KEYWORD_LABELS, item.keyword, item.keyword.replaceAll("-", " · ")); return <li key={item.keyword}><div><strong>{translated}</strong><span>{item.count}회</span></div>{translated !== item.keyword && <small>{item.keyword}</small>}<Bar percent={(item.count / keywordMax) * 100} /></li>; })}
        </ol> : <p className="table-note">이 기간에 새롭게 집계된 키워드가 없습니다.</p>}
      </section>
      <section><h3>판단 분포</h3><p>읽은 뒤 남긴 발전·보관·관찰·제외</p>
        {hasDecisions ? <ol className="radar-chart-list" aria-label={`${periodLabel} 판단 분포`}>
          {decisions.map((item) => <li key={item.action}><div><strong>{item.label}</strong><span>{item.count}회 · {item.percent}%</span></div><Bar percent={item.percent} /></li>)}
        </ol> : <p className="table-note">이 기간에 남긴 판단이 없습니다.</p>}
      </section>
      <section><h3>저장소 구성</h3><p>전체 누적 자료 유형</p>
        {composition.length ? <ol className="radar-chart-list" aria-label="저장소 전체 자료 구성">
          {composition.map((item) => <li key={item.kind}><div><strong>{item.label}</strong><span>{item.count}개 · {item.percent}%</span></div><Bar percent={item.percent} /></li>)}
        </ol> : <p className="table-note">저장소에 집계된 자료가 없습니다.</p>}
      </section>
    </div>
  </section>;
}
```

- [ ] **Step 4: 시각화 스타일을 추가한다**

Append before the first Radar media query in `web/src/styles/views.css`:

```css
.radar-overview { grid-column: 1 / -1; display: grid; gap: 18px; padding-top: 24px; }
.radar-overview__heading { display: flex; align-items: end; justify-content: space-between; gap: 20px; }
.radar-overview__heading h2 { margin: 4px 0 0; font-size: 18px; letter-spacing: -0.035em; }
.radar-overview__heading > p { max-width: 360px; margin: 0; color: var(--color-muted); font-size: 10px; line-height: 1.5; text-align: right; }
.radar-overview__charts { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); border-bottom: 1px solid var(--color-line); }
.radar-overview__charts > section { min-width: 0; padding: 18px 20px 22px 0; }
.radar-overview__charts > section + section { padding-left: 20px; border-left: 1px solid var(--color-line); }
.radar-overview__charts h3 { margin: 0; font-size: 13px; }
.radar-overview__charts section > p { margin: 5px 0 14px; color: var(--color-muted); font-size: 10px; line-height: 1.5; }
.radar-chart-list { display: grid; gap: 11px; margin: 0; padding: 0; list-style: none; }
.radar-chart-list li { min-width: 0; }
.radar-chart-list li > div { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; }
.radar-chart-list strong { overflow: hidden; font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }
.radar-chart-list span { flex: 0 0 auto; color: var(--color-muted); font-family: var(--font-mono); font-size: 9px; }
.radar-chart-list small { display: block; overflow: hidden; margin-top: 2px; color: var(--color-muted); font-family: var(--font-mono); font-size: 8px; text-overflow: ellipsis; white-space: nowrap; }
.radar-bar { display: block; height: 4px; margin-top: 5px; overflow: hidden; background: var(--color-soft); }
.radar-bar > span { display: block; height: 100%; background: var(--color-accent); }
```

Replace the Radar mobile rule at `web/src/styles/views.css:137` with:

```css
@media (max-width: 960px) { .radar-overview__charts { grid-template-columns: 1fr; } .radar-overview__charts > section { padding: 18px 0; } .radar-overview__charts > section + section { padding-left: 0; border-top: 1px solid var(--color-line); border-left: 0; } }
@media (max-width: 760px) { .radar-dashboard { display: block; } .radar-overview__heading { display: grid; } .radar-overview__heading > p { text-align: left; } .radar-metrics { grid-template-columns: repeat(2, 1fr); } .radar-metrics div:nth-child(2) { border-right: 0; } .radar-metrics div:nth-child(-n+2) { border-bottom: 1px solid var(--color-line); } }
```

- [ ] **Step 5: 컴포넌트 테스트와 타입 검사를 실행한다**

Run:

```bash
pnpm --filter @radar/web exec vitest run src/components/radar/RadarOverview.test.tsx
pnpm --filter @radar/web typecheck
```

Expected: both commands exit 0; four component tests pass.

- [ ] **Step 6: 커밋한다**

```bash
git add web/src/components/radar/RadarOverview.tsx web/src/components/radar/RadarOverview.test.tsx web/src/styles/views.css
git commit -m "260822: 레이더 최상단 정량 요약 추가"
```

---

### Task 3: RadarView 정보 위계 재구성

**Files:**
- Modify: `web/src/views/RadarView.tsx:1-86`
- Modify: `web/src/views/RadarView.test.tsx:1-36`

**Interfaces:**
- Consumes: `RadarOverview` from Task 2
- Consumes: `RadarStats`, `visibleSynthesisSections` from Task 1
- Preserves: `onNavigate(view: View): void`, period switching, synthesis generation, reading queue fetch

- [ ] **Step 1: 새 화면 순서와 중복 제거에 대한 실패 테스트를 작성한다**

Replace the first test in `web/src/views/RadarView.test.tsx` with:

```tsx
it("shows quantitative facts before interpretation without repeated sections", async () => {
  const onNavigate = vi.fn();
  render(<RadarView onNavigate={onNavigate} />);
  const overview = await screen.findByRole("region", { name: "이번 주 정량 요약" });
  const narrative = await screen.findByText("저장된 서사");
  expect(overview.compareDocumentPosition(narrative) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(screen.getByRole("heading", { name: "관심 신호" })).toBeInTheDocument();
  expect(screen.queryByRole("heading", { name: "상승 신호" })).not.toBeInTheDocument();
  expect(screen.queryByRole("heading", { name: "이번 주 새로 떠오른 키워드" })).not.toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "멀리 있는 자료 사이의 새 연결" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "새 후보 확인 발견으로 이동 →" })).toBeInTheDocument();
});
```

Update the mocked synthesis at line 11 so one duplicate and one interpretive section are both present:

```ts
sections: [
  { heading: "rising keywords — what is growing this week", items: [{ observation: "반복되는 흐름" }] },
  { heading: "new connections between distant materials", items: [{ observation: "서로 먼 자료의 연결" }] },
]
```

- [ ] **Step 2: 테스트가 기존 화면 순서에서 실패하는지 확인한다**

Run:

```bash
pnpm --filter @radar/web exec vitest run src/views/RadarView.test.tsx
```

Expected: FAIL because `이번 주 정량 요약` region is absent and `상승 신호` still exists.

- [ ] **Step 3: imports와 로컬 타입을 정리한다**

In `web/src/views/RadarView.tsx`, replace lines 2-8 imports and the local `Stats` interface with:

```tsx
import type { RadarPeriod, View } from "@radar/shared";
import { runTask, useTasks } from "../lib/tasks";
import { RADAR_SECTION_LABELS } from "../lib/labels";
import { type RadarStats, visibleSynthesisSections } from "../lib/radarPresentation";
import PageHeader from "../components/layout/PageHeader";
import RadarOverview from "../components/radar/RadarOverview";
import StatusMessage from "../components/ui/StatusMessage";
```

Change the stats state and fetch cast:

```tsx
const [stats, setStats] = useState<RadarStats | null>(null);
```

```tsx
useEffect(() => { fetch(`/api/radar/stats?period=${period}`).then((response) => response.json() as Promise<{ stats?: RadarStats }>).then((data) => setStats(data.stats ?? null)).catch(() => setStats(null)); }, [period]);
```

Delete `signalLabel`, `KeywordCount`, `keywordLabel`, and `KeywordBoard`; they are no longer used by this view.

- [ ] **Step 4: 대시보드 JSX를 새 정보 순서로 교체한다**

Inside the `stats` branch, replace the current `<div className="radar-dashboard">...</div>` with:

```tsx
<div className="radar-dashboard">
  <RadarOverview stats={stats} periodLabel={PERIODS.find((item) => item.value === period)?.label ?? "선택 기간"} />
  <section className="radar-narrative">
    <p className="reading-section__label">{PERIODS.find((item) => item.value === period)?.label}의 서사</p>
    {synthesis ? <>
      <p className="radar-narrative__copy">{synthesis.narrative}</p>
      {visibleSynthesisSections(synthesis.sections).map((section) => <div className="radar-section" key={section.heading}><h2>{section.heading}</h2>{section.items.map((item) => <p key={item}>{item}</p>)}</div>)}
    </> : <p className="distill-copy">아직 생성된 서사가 없습니다. 레이더를 새로 만들어 보세요.</p>}
  </section>
  <aside className="radar-side">
    <section><p className="reading-section__label">지금 직접 읽기</p>{queue.length ? queue.map((item) => <article className="radar-queue" key={item.id}><a href={item.sourceUrl ?? "#"} target="_blank" rel="noreferrer">{item.title} ↗</a><span>{item.whyRead ?? "검증된 다음 읽기"}</span></article>) : <p className="table-note">검증된 읽기 큐가 없습니다.</p>}<button className="ui-button-secondary" onClick={() => onNavigate("DISTILL")}>착즙에서 큐 편집</button></section>
    <section><p className="reading-section__label">다음 행동</p><button className="next-action" onClick={() => onNavigate("DISCOVER")}>새 후보 확인 <span>발견으로 이동 →</span></button><button className="next-action" onClick={() => onNavigate("RESERVOIR")}>보존 자료 다시 읽기 <span>저장소로 이동 →</span></button></section>
  </aside>
  <section className="radar-section radar-section--wide radar-questions">
    <h2>남은 질문</h2>
    {stats.newQuestions.length ? stats.newQuestions.slice(0, 5).map((question) => <p className="reading-question" key={question}><span>?</span>{question}</p>) : <p className="table-note">아직 기록된 질문이 없습니다.</p>}
  </section>
  <details className="radar-landscape radar-section--wide">
    <summary>장기 연구 지형 <span>전체 누적 토픽 보기</span></summary>
    {topics.length ? <ol className="radar-landscape__list" aria-label="전체 누적 연구 토픽">{topics.slice(0, 14).map((topic) => <li key={topic.topic}><span>{topic.topic}</span><strong>{topic.count}회</strong></li>)}</ol> : <p className="table-note">주제 태그가 아직 없습니다.</p>}
  </details>
  {synthesis?.biasWatch?.length ? <section className="radar-section radar-section--wide radar-bias"><h2>편향 점검</h2>{synthesis.biasWatch.map((item) => <p key={item}>주의 · {item}</p>)}</section> : null}
</div>
```

- [ ] **Step 5: 상세 연구 지형 스타일을 추가한다**

Append to the Radar section of `web/src/styles/views.css`:

```css
.radar-questions { padding-top: 8px; border-top: 1px solid var(--color-line); }
.radar-landscape { grid-column: 1 / -1; max-width: 820px; margin-top: 10px; padding: 14px 0; border-top: 1px solid var(--color-line); border-bottom: 1px solid var(--color-line); }
.radar-landscape summary { cursor: pointer; font-size: 13px; font-weight: 750; }
.radar-landscape summary span { margin-left: 8px; color: var(--color-muted); font-size: 10px; font-weight: 500; }
.radar-landscape__list { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 0 24px; margin: 14px 0 0; padding: 0; list-style: none; }
.radar-landscape__list li { display: flex; justify-content: space-between; gap: 12px; padding: 8px 0; border-top: 1px solid var(--color-line); font-size: 11px; }
.radar-landscape__list strong { color: var(--color-muted); font-family: var(--font-mono); font-size: 9px; }
@media (max-width: 520px) { .radar-landscape__list { grid-template-columns: 1fr; } }
```

- [ ] **Step 6: view 테스트와 전체 web 테스트를 실행한다**

Run:

```bash
pnpm --filter @radar/web exec vitest run src/views/RadarView.test.tsx
pnpm --filter @radar/web exec vitest run
pnpm --filter @radar/web typecheck
```

Expected: all commands exit 0; the Radar tests confirm overview-first order and period isolation.

- [ ] **Step 7: 커밋한다**

```bash
git add web/src/views/RadarView.tsx web/src/views/RadarView.test.tsx web/src/styles/views.css
git commit -m "260822: 레이더 중복 정보 위계 정리"
```

---

### Task 4: 브라우저 회귀 검증과 운영 문서 갱신

**Files:**
- Modify: `web/tests/e2e/core-reading-flow.spec.ts:4-26`
- Modify: `docs/PROJECT_CONTEXT.md:44-51`

**Interfaces:**
- Consumes: completed Radar dashboard from Tasks 1-3
- Preserves: dashboard → 발견 → 후보 읽기 핵심 흐름

- [ ] **Step 1: E2E mock에 판단·자료 구성 데이터를 추가한다**

Replace the Radar stats response in `web/tests/e2e/core-reading-flow.spec.ts` with:

```ts
if (url.pathname === "/api/radar/stats") return route.fulfill({ json: { stats: { newSources: 2, newKeywords: [{ keyword: "photography", count: 2 }], newQuestions: ["무엇을 읽을까"], signalCounts: { develop: 2, keep: 1, import: 8, view: 4 }, topKeptSources: [], distillRuns: 1, gapsRaised: 1, readingQueueSize: 1, kindBreakdown: { NOTE: 2, PAPER_ACADEMIC: 1 } } } });
```

- [ ] **Step 2: E2E assertion을 새 읽기 순서에 맞춘다**

Replace `await expect(page.getByText("상승 신호")).toBeVisible();` with:

```ts
const overview = page.getByRole("region", { name: "이번 주 정량 요약" });
await expect(overview).toBeVisible();
await expect(overview.getByRole("heading", { name: "관심 신호" })).toBeVisible();
await expect(overview.getByRole("heading", { name: "판단 분포" })).toBeVisible();
await expect(overview.getByRole("heading", { name: "저장소 구성" })).toBeVisible();
await expect(page.getByRole("heading", { name: "상승 신호" })).toHaveCount(0);
```

- [ ] **Step 3: 로컬 브라우저 테스트를 실행한다**

Run:

```bash
pnpm --filter @radar/web exec playwright test tests/e2e/core-reading-flow.spec.ts
```

Expected: `dashboard to discover preserves the reading-first flow` passes.

- [ ] **Step 4: 내부 참조 가이드에 새 Radar 순서를 기록한다**

Replace the Radar bullet under `docs/PROJECT_CONTEXT.md` section `3-1. 현재 UI 읽기 흐름` with:

```markdown
- 레이더는 `선택 기간 정량 요약 → 해석 서사 → 지금 직접 읽기와 다음 행동 → 상세 연구 정보` 순서다. 신규 키워드·판단·자료 구성은 최상단에 한 번만 표시하고, 자료 구성은 전체 누적임을 명시한다. 장기 연구 지형은 접힌 상세 영역으로 제공한다.
```

- [ ] **Step 5: 전체 검증을 실행한다**

Run:

```bash
pnpm typecheck
pnpm build
git diff --check
git status --short
```

Expected: typecheck/build exit 0; `git diff --check` has no output; only intended tracked files and pre-existing untracked directories appear.

- [ ] **Step 6: 최종 UI 변경을 커밋한다**

```bash
git add web/tests/e2e/core-reading-flow.spec.ts docs/PROJECT_CONTEXT.md
git commit -m "260822: 레이더 정량 요약 검증 문서화"
```

---

### Task 5: 배포 전 최종 검증과 배포

**Files:**
- Verify only: all files changed in Tasks 1-4

**Interfaces:**
- Produces: verified production build and Cloudflare deployment

- [ ] **Step 1: 최종 변경 범위를 검토한다**

Run:

```bash
git diff HEAD~4 --stat
git log -4 --oneline
git status --short
```

Expected: Radar presentation, component, view, tests, styles, context documentation만 추적 변경으로 확인된다. `.playwright-cli/`, `.pnpm-store/`, `.superpowers/`, `web/test-results/`는 커밋하지 않는다.

- [ ] **Step 2: 최종 테스트와 빌드를 다시 실행한다**

Run:

```bash
pnpm --filter @radar/web exec vitest run
pnpm --filter @radar/web exec playwright test tests/e2e/core-reading-flow.spec.ts
pnpm typecheck
pnpm build
```

Expected: all commands exit 0.

- [ ] **Step 3: Cloudflare에 배포한다**

Run:

```bash
pnpm deploy
```

Expected: Wrangler reports a new deployed Worker version and `radar.taejunyun.com` serves the updated static assets.

- [ ] **Step 4: 운영 화면을 확인한다**

Verify at `https://radar.taejunyun.com`:

```text
1. 이번 주 정량 요약이 서사보다 위에 보인다.
2. 관심 신호·판단 분포·저장소 구성이 표시된다.
3. 상승 신호·최근 판단·하단 자료 구성이 반복되지 않는다.
4. 장기 연구 지형은 기본적으로 닫혀 있다.
5. 이번 달과 올해로 전환해도 해당 기간 통계와 서사가 분리된다.
6. 새 후보 확인과 보존 자료 다시 읽기 이동이 동작한다.
```

- [ ] **Step 5: main을 원격에 푸시한다**

Run:

```bash
git push origin main
```

Expected: local `main` and `origin/main` point to the same final commit.
