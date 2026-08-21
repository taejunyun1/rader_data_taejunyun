# Research Radar 읽기 중심 UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 기존 Worker API와 데이터 모델을 유지하면서 Research Radar의 7개 화면을 한글·읽기 중심의 연구 편집 UI로 교체한다.

**Architecture:** React의 현재 view 상태 전환 구조는 유지하고 `AppShell`, 공통 읽기 작업 공간, 문서형 착즙 컴포넌트를 추가한다. 각 view가 API 호출과 도메인 상태를 소유하고, 공통 컴포넌트는 props로 받은 데이터만 표현한다. 스타일은 인라인 객체에서 CSS 토큰과 책임별 스타일시트로 이동한다.

**Tech Stack:** React 19, TypeScript 5.9, Vite 8, pnpm workspaces, Vitest, Testing Library, Playwright, 기존 Cloudflare Worker API

## Global Constraints

- 기준 사양: `docs/superpowers/specs/2026-08-21-research-radar-ui-design.md`
- 제품 기준: `docs/spec-v0.1.txt`, `docs/SPEC.md`, `docs/DEV_PLAN.md`, `docs/PROJECT_CONTEXT.md`
- UI 언어는 한글이며 작가명·논문명·저널명·고유명사는 원문을 유지한다.
- 배경은 `#FFFFFF`와 `#F7F8FA`, 주 accent는 `#6547FF`를 사용한다.
- 외부 UI 프레임워크, 전역 상태 라이브러리, 폰트 CDN을 추가하지 않는다.
- Worker route, D1/R2 schema, 모델 설정을 변경하지 않는다.
- 발견 후보에 없는 abstract·본문·AI 분석을 프론트에서 만들어내지 않는다.
- Distill 재선택은 현재 API가 지원하는 section key 단위를 유지한다.
- 한 화면에서 가장 강한 CTA는 하나만 둔다.
- 데스크톱 우선이며 899px 이하에서도 핵심 흐름이 작동해야 한다.
- 모든 단계에서 `pnpm typecheck`, `pnpm build`, 관련 테스트를 통과시킨다.
- 커밋 메시지는 `YYMMDD: 변경 내용 요약` 형식을 사용한다.

---

## File Map

### 새 파일

| 파일 | 책임 |
|---|---|
| `web/vitest.config.ts` | jsdom 기반 컴포넌트 테스트 설정 |
| `web/playwright.config.ts` | mock API 기반 핵심 흐름 브라우저 테스트 설정 |
| `web/src/test/setup.ts` | Testing Library matcher와 테스트 정리 |
| `web/src/test/fixtures.ts` | Radar, candidate, source, Distill, Inbox, Usage fixture |
| `web/src/lib/ui.ts` | 한글 view metadata와 공통 표시 formatter |
| `web/src/lib/sourceAccess.ts` | 출처 URL/provider로 접근 상태를 보수적으로 판정 |
| `web/src/styles/tokens.css` | 색상, 타이포그래피, 간격, focus 토큰 |
| `web/src/styles/base.css` | reset, 본문, 입력, 링크, 반응형 기본값 |
| `web/src/styles/shell.css` | AppShell, sidebar, header, Task Center |
| `web/src/styles/reading.css` | 3열 작업 공간, 읽기 본문, provenance, 판단 레일 |
| `web/src/styles/views.css` | Radar, Distill, Inbox, Settings, Usage 전용 레이아웃 |
| `web/src/components/layout/AppShell.tsx` | 전역 레이아웃 조합 |
| `web/src/components/layout/SidebarNav.tsx` | 한글 내비게이션과 행동 수 |
| `web/src/components/layout/PageHeader.tsx` | 제목·필터·주 CTA |
| `web/src/components/layout/TaskCenter.tsx` | 장기 작업 진행·완료·실패 표시 |
| `web/src/components/ui/StatusMessage.tsx` | loading, empty, error, success 상태와 복구 행동 |
| `web/src/components/reading/SplitWorkspace.tsx` | index, reading, decision 3열 레이아웃 |
| `web/src/components/reading/SourceIndex.tsx` | 후보·저장 자료 목록과 키보드 선택 |
| `web/src/components/reading/ReadingPane.tsx` | 출처·해석·발췌·질문 읽기 영역 |
| `web/src/components/reading/SourceAccessBadge.tsx` | 직접 읽기·PDF·기관 인증·초록·확인 필요 상태 |
| `web/src/components/reading/ProvenanceNotice.tsx` | 원자료와 시스템 해석 구분 |
| `web/src/components/reading/DecisionRail.tsx` | 발전·보관·관찰·제외와 관련 정보 |
| `web/src/components/distill/DocumentOutline.tsx` | 착즙 문서 목차와 섹션 이동 |
| `web/src/components/distill/SelectionTray.tsx` | 유지할 section key와 Re-Distill CTA |
| `web/tests/e2e/core-reading-flow.spec.ts` | 레이더→원문→분류→착즙 핵심 흐름 |

### 수정 파일

| 파일 | 변경 |
|---|---|
| `web/package.json` | test scripts와 test devDependencies 추가 |
| `pnpm-lock.yaml` | 테스트 도구 설치 결과 고정 |
| `web/src/main.tsx:1-9` | 전역 CSS import |
| `web/src/App.tsx:1-172` | AppShell 적용, 한글 nav, 운영 디버그 문구 제거 |
| `web/src/lib/tasks.ts:1-66` | Task Center가 사용할 상태 label·dismiss 지원 |
| `web/src/views/ReservoirView.tsx:1-309` | 공통 읽기 작업 공간 적용 |
| `web/src/views/DiscoverView.tsx:1-262` | 후보 읽기·판단 중심으로 재구성 |
| `web/src/views/DistillView.tsx:1-373` | 긴 문서·목차·section 선택 구조 적용 |
| `web/src/views/RadarView.tsx:1-195` | 연구 편집 데스크와 읽을 자료 표시 |
| `web/src/views/InboxView.tsx:1-245` | 자료 추가 drawer와 처리 인덱스 적용 |
| `web/src/views/SettingsView.tsx:1-207` | 연구 성향·데이터·발견 소스·고급 관리 재구성 |
| `web/src/views/UsageView.tsx:1-125` | 예산 안전장치 중심 재구성 |
| `docs/SPEC.md:17-30` | D9를 최신 한글 UI 결정으로 갱신 |
| `docs/PROJECT_CONTEXT.md:40-63` | 새 UI 구조와 검증 명령 기록 |

---

### Task 1: 테스트 기반과 디자인 토큰

**Files:**
- Modify: `web/package.json`
- Modify: `pnpm-lock.yaml`
- Create: `web/vitest.config.ts`
- Create: `web/src/test/setup.ts`
- Create: `web/src/lib/ui.ts`
- Create: `web/src/lib/ui.test.ts`
- Create: `web/src/styles/tokens.css`
- Create: `web/src/styles/base.css`
- Modify: `web/src/main.tsx:1-9`

**Interfaces:**
- Produces: `VIEW_META: Record<View, ViewMeta>`
- Produces: `PRIMARY_VIEWS: readonly View[]`
- Produces: `formatDateKo(value: string): string`
- Produces: CSS custom properties used by all later tasks

- [ ] **Step 1: 테스트 도구를 설치하고 scripts를 선언한다**

Run:

```bash
pnpm --filter @radar/web add -D vitest jsdom @testing-library/react @testing-library/jest-dom @testing-library/user-event @playwright/test
```

Add to `web/package.json` scripts:

```json
{
  "test": "vitest run",
  "test:watch": "vitest",
  "test:e2e": "playwright test"
}
```

Expected: `web/package.json`과 `pnpm-lock.yaml`만 dependency 설치로 변경된다.

- [ ] **Step 2: Vitest 설정과 matcher를 만든다**

Create `web/vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    css: true,
    restoreMocks: true,
  },
});
```

Create `web/src/test/setup.ts`:

```ts
import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

afterEach(() => cleanup());
```

- [ ] **Step 3: 한글 view metadata의 실패 테스트를 작성한다**

Create `web/src/lib/ui.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { PRIMARY_VIEWS, VIEW_META, formatDateKo } from "./ui";

describe("UI metadata", () => {
  it("puts the daily reading flow before utilities", () => {
    expect(PRIMARY_VIEWS).toEqual(["RADAR", "DISCOVER", "RESERVOIR", "DISTILL", "INBOX"]);
  });

  it("provides Korean labels for every primary view", () => {
    expect(PRIMARY_VIEWS.map((view) => VIEW_META[view].label)).toEqual([
      "레이더",
      "발견",
      "저장소",
      "착즙",
      "받은 자료",
    ]);
  });

  it("formats ISO dates in Korean", () => {
    expect(formatDateKo("2026-08-21T02:00:00.000Z")).toMatch(/2026/);
    expect(formatDateKo("2026-08-21T02:00:00.000Z")).toMatch(/8/);
  });
});
```

- [ ] **Step 4: 테스트가 실패하는지 확인한다**

Run:

```bash
pnpm --filter @radar/web exec vitest run src/lib/ui.test.ts
```

Expected: FAIL with `Failed to resolve import "./ui"`.

- [ ] **Step 5: view metadata를 구현한다**

Create `web/src/lib/ui.ts`:

```ts
import type { View } from "@radar/shared";

export interface ViewMeta {
  label: string;
  description: string;
}

export const PRIMARY_VIEWS = ["RADAR", "DISCOVER", "RESERVOIR", "DISTILL", "INBOX"] as const satisfies readonly View[];
export const UTILITY_VIEWS = ["USAGE", "SETTINGS"] as const satisfies readonly View[];

export const VIEW_META: Record<View, ViewMeta> = {
  RADAR: { label: "레이더", description: "현재 연구 흐름과 읽을 자료" },
  DISCOVER: { label: "발견", description: "외부 자료 후보 검토" },
  RESERVOIR: { label: "저장소", description: "보존된 연구 자료" },
  DISTILL: { label: "착즙", description: "선택한 맥락의 종합과 검증" },
  INBOX: { label: "받은 자료", description: "자료 입력과 처리 상태" },
  USAGE: { label: "AI 사용량", description: "월 예산과 호출 내역" },
  SETTINGS: { label: "설정", description: "연구 성향과 데이터 관리" },
};

export function formatDateKo(value: string): string {
  return new Intl.DateTimeFormat("ko-KR", { year: "numeric", month: "long", day: "numeric" }).format(new Date(value));
}
```

- [ ] **Step 6: 토큰과 base 스타일을 작성하고 import한다**

Create `web/src/styles/tokens.css` with these exact variables:

```css
:root {
  --color-ink: #17181c;
  --color-surface: #ffffff;
  --color-soft: #f7f8fa;
  --color-line: #e4e6eb;
  --color-muted: #6f7580;
  --color-accent: #6547ff;
  --color-positive: #008d86;
  --color-warning: #d85a22;
  --color-danger: #b42318;
  --font-sans: "Pretendard Variable", "Apple SD Gothic Neo", "Noto Sans KR", system-ui, sans-serif;
  --font-mono: ui-monospace, "SFMono-Regular", monospace;
  --focus-ring: 0 0 0 3px rgb(101 71 255 / 20%);
}
```

Create `web/src/styles/base.css` with body, button, input, link, focus-visible, and reduced-motion rules. Import both files before component styles in `web/src/main.tsx`:

```ts
import "./styles/tokens.css";
import "./styles/base.css";
```

- [ ] **Step 7: 테스트와 빌드를 확인한다**

Run:

```bash
pnpm --filter @radar/web test
pnpm --filter @radar/web typecheck
pnpm --filter @radar/web build
```

Expected: all commands exit 0.

- [ ] **Step 8: 커밋한다**

```bash
git add web/package.json pnpm-lock.yaml web/vitest.config.ts web/src/test web/src/lib/ui.ts web/src/lib/ui.test.ts web/src/styles/tokens.css web/src/styles/base.css web/src/main.tsx
git commit -m "260821: UI 테스트 기반과 디자인 토큰 구성"
```

---

### Task 2: AppShell, 한글 내비게이션, Task Center

**Files:**
- Create: `web/src/components/layout/AppShell.tsx`
- Create: `web/src/components/layout/SidebarNav.tsx`
- Create: `web/src/components/layout/PageHeader.tsx`
- Create: `web/src/components/layout/TaskCenter.tsx`
- Create: `web/src/components/layout/AppShell.test.tsx`
- Create: `web/src/styles/shell.css`
- Modify: `web/src/lib/tasks.ts:1-66`
- Modify: `web/src/App.tsx:1-172`
- Modify: `web/src/main.tsx`

**Interfaces:**
- Consumes: `PRIMARY_VIEWS`, `UTILITY_VIEWS`, `VIEW_META`
- Produces: `AppShellProps { view, onNavigate, usage, tasks, children }`
- Produces: `PageHeaderProps { title, description?, controls?, primaryAction? }`
- Produces: `dismissTask(id: string): void`

- [ ] **Step 1: AppShell 동작 테스트를 작성한다**

Create `web/src/components/layout/AppShell.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import AppShell from "./AppShell";

describe("AppShell", () => {
  it("renders Korean navigation and changes views", async () => {
    const onNavigate = vi.fn();
    render(
      <AppShell view="RADAR" onNavigate={onNavigate} usage={null} tasks={[]}>
        <p>본문</p>
      </AppShell>
    );
    await userEvent.click(screen.getByRole("button", { name: "발견" }));
    expect(onNavigate).toHaveBeenCalledWith("DISCOVER");
    expect(screen.getByRole("button", { name: "레이더" })).toHaveAttribute("aria-current", "page");
  });

  it("keeps usage and settings in the utility area", () => {
    render(
      <AppShell view="RADAR" onNavigate={vi.fn()} usage={{ usedUsd: 1, budgetUsd: 10, usedPct: 10, blocked: false }} tasks={[]}>
        <p>본문</p>
      </AppShell>
    );
    expect(screen.getByText("AI 사용량 · 10%")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "설정" })).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: 실패를 확인한다**

Run:

```bash
pnpm --filter @radar/web exec vitest run src/components/layout/AppShell.test.tsx
```

Expected: FAIL because `AppShell.tsx` does not exist.

- [ ] **Step 3: 레이아웃 컴포넌트 인터페이스를 구현한다**

Implement `AppShell` using these props:

```tsx
import type { ReactNode } from "react";
import type { View } from "@radar/shared";
import type { Task } from "../../lib/tasks";

export interface UsageBadge {
  usedUsd: number;
  budgetUsd: number;
  usedPct: number;
  blocked: boolean;
}

export interface AppShellProps {
  view: View;
  onNavigate: (view: View) => void;
  usage: UsageBadge | null;
  tasks: Task[];
  children: ReactNode;
}
```

`SidebarNav` must render primary and utility arrays separately, use `aria-current="page"`, and show usage as `AI 사용량 · {Math.round(usedPct)}%`. `TaskCenter` renders the latest three tasks and provides visible text for status and progress. `PageHeader` renders a semantic `header`, one `h1`, controls, and one primary action slot.

- [ ] **Step 4: task dismiss를 추가한다**

Add to `web/src/lib/tasks.ts`:

```ts
export function dismissTask(id: string): void {
  tasks = tasks.filter((task) => task.id !== id);
  emit();
}
```

Task Center의 완료·실패 항목에는 이 함수를 호출하는 `닫기` 버튼을 연결한다. 실행 중인 task는 닫을 수 없게 한다.

- [ ] **Step 5: App.tsx를 AppShell 중심으로 교체한다**

Keep the existing `view` state and `usage` fetch. Remove `/api/health`, `/api/debug/ai-check`, `health`, and `ai` state from the production UI. Render the selected view inside:

```tsx
<AppShell view={view} onNavigate={setView} usage={usage} tasks={tasks}>
  {view === "RADAR" && <RadarView />}
  {view === "DISCOVER" && <DiscoverView />}
  {view === "RESERVOIR" && <ReservoirView />}
  {view === "DISTILL" && <DistillView />}
  {view === "INBOX" && <InboxView />}
  {view === "USAGE" && <UsageView />}
  {view === "SETTINGS" && <SettingsView />}
</AppShell>
```

Add `shell.css` for a 176px desktop sidebar, sticky 69px page header, utility navigation, visible focus, and compact mode under 900px. Import it from `main.tsx`.

- [ ] **Step 6: 테스트와 빌드를 확인한다**

Run:

```bash
pnpm --filter @radar/web exec vitest run src/components/layout/AppShell.test.tsx
pnpm --filter @radar/web typecheck
pnpm --filter @radar/web build
```

Expected: PASS and no missing props in view components.

- [ ] **Step 7: 커밋한다**

```bash
git add web/src/App.tsx web/src/main.tsx web/src/lib/tasks.ts web/src/components/layout web/src/styles/shell.css
git commit -m "260821: 한글 AppShell과 작업 상태 UI 구성"
```

---

### Task 3: 출처 접근 상태와 공통 읽기 컴포넌트

**Files:**
- Create: `web/src/lib/sourceAccess.ts`
- Create: `web/src/lib/sourceAccess.test.ts`
- Create: `web/src/components/ui/StatusMessage.tsx`
- Create: `web/src/components/reading/SplitWorkspace.tsx`
- Create: `web/src/components/reading/SourceIndex.tsx`
- Create: `web/src/components/reading/ReadingPane.tsx`
- Create: `web/src/components/reading/SourceAccessBadge.tsx`
- Create: `web/src/components/reading/ProvenanceNotice.tsx`
- Create: `web/src/components/reading/DecisionRail.tsx`
- Create: `web/src/components/reading/ReadingPane.test.tsx`
- Create: `web/src/styles/reading.css`
- Modify: `web/src/main.tsx`

**Interfaces:**
- Produces: `SourceAccessKind = "DIRECT" | "PDF" | "INSTITUTION" | "ABSTRACT" | "UNKNOWN"`
- Produces: `deriveSourceAccess(input: SourceAccessInput): SourceAccess`
- Produces: `ReadingDocument`, `SourceIndexItem`, `DecisionAction`
- Produces: reusable 3-column workspace used by Tasks 4 and 5

- [ ] **Step 1: 접근 상태 판정 테스트를 작성한다**

Create `web/src/lib/sourceAccess.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { deriveSourceAccess } from "./sourceAccess";

describe("deriveSourceAccess", () => {
  it("labels arXiv PDFs without claiming a free article", () => {
    expect(deriveSourceAccess({ provider: "arxiv", href: "https://arxiv.org/pdf/1234" }).kind).toBe("PDF");
  });

  it("uses institution wording for RISS", () => {
    expect(deriveSourceAccess({ provider: "riss", href: "https://www.riss.kr/link" })).toMatchObject({
      kind: "INSTITUTION",
      label: "기관 인증 여부 확인",
    });
  });

  it("does not claim access when no URL exists", () => {
    expect(deriveSourceAccess({ provider: "openalex", href: null })).toMatchObject({
      kind: "UNKNOWN",
      href: null,
    });
  });

  it("treats an OpenAlex work page as access metadata, not full text", () => {
    expect(deriveSourceAccess({ provider: "openalex", href: "https://openalex.org/W123", verified: true }).kind).toBe("ABSTRACT");
  });
});
```

- [ ] **Step 2: 실패를 확인한다**

Run:

```bash
pnpm --filter @radar/web exec vitest run src/lib/sourceAccess.test.ts
```

Expected: FAIL because the module is missing.

- [ ] **Step 3: 보수적인 접근 상태 판정을 구현한다**

Create `web/src/lib/sourceAccess.ts`:

```ts
export type SourceAccessKind = "DIRECT" | "PDF" | "INSTITUTION" | "ABSTRACT" | "UNKNOWN";

export interface SourceAccessInput {
  provider?: string | null;
  href?: string | null;
  verified?: boolean;
}

export interface SourceAccess {
  kind: SourceAccessKind;
  label: string;
  actionLabel: string;
  href: string | null;
}

export function deriveSourceAccess(input: SourceAccessInput): SourceAccess {
  const provider = input.provider?.toLowerCase() ?? "";
  const href = input.href ?? null;
  if (!href) return { kind: "UNKNOWN", label: "접근 경로 확인 필요", actionLabel: "출처 정보 보기", href: null };
  if (provider === "riss" || href.includes("riss.kr")) {
    return { kind: "INSTITUTION", label: "기관 인증 여부 확인", actionLabel: "RISS에서 확인", href };
  }
  if (provider === "arxiv" || href.includes("arxiv.org/pdf") || href.toLowerCase().endsWith(".pdf")) {
    return { kind: "PDF", label: "PDF 제공", actionLabel: "PDF 읽기", href };
  }
  if (provider === "openalex" || href.includes("openalex.org")) {
    return { kind: "ABSTRACT", label: "서지·접근 정보", actionLabel: "OpenAlex에서 확인", href };
  }
  return { kind: "DIRECT", label: "원문 링크", actionLabel: "원문에서 읽기", href };
}
```

- [ ] **Step 4: 읽기 컴포넌트 타입과 의미 구조를 구현한다**

Use these public interfaces in `ReadingPane.tsx` and `SourceIndex.tsx`:

```ts
export interface SourceIndexItem {
  id: string;
  title: string;
  meta: string;
  tags: string[];
  access: SourceAccess;
}

export interface ReadingDocument {
  id: string;
  title: string;
  byline: string;
  provenance: string;
  access: SourceAccess;
  summary: string | null;
  fragments: string[];
  questions: string[];
  keywords: string[];
}

export interface DecisionAction {
  id: "develop" | "keep" | "watch" | "ignore";
  label: string;
  description: string;
}
```

`ReadingPane` must render `원문에서 읽기` only when `access.href` is non-null. It must label `summary` as `시스템 해석`, fragments as `원문에서 추출한 문장` only when the backend identifies them as extracted fragments, and show `분석 내용 없음` without invented prose when summary is null.

`SourceIndex` uses semantic buttons, `aria-selected`, ArrowUp/ArrowDown selection, and keeps a visible item count. `DecisionRail` accepts `onAction(actionId)` and disables all actions while an action is pending.

- [ ] **Step 5: provenance 표현 테스트를 작성한다**

Create `web/src/components/reading/ReadingPane.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import ReadingPane from "./ReadingPane";

describe("ReadingPane", () => {
  it("separates source material from system interpretation", () => {
    render(<ReadingPane document={{ id: "1", title: "자료", byline: "저자", provenance: "저장소 원자료", access: { kind: "DIRECT", label: "원문 링크", actionLabel: "원문에서 읽기", href: "https://example.com" }, summary: "해석", fragments: ["원문 문장"], questions: ["질문"], keywords: ["사진"] }} />);
    expect(screen.getByText("시스템 해석")).toBeInTheDocument();
    expect(screen.getByText("원문에서 추출한 문장")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /원문에서 읽기/ })).toHaveAttribute("href", "https://example.com");
  });

  it("does not render a fake reading link", () => {
    render(<ReadingPane document={{ id: "2", title: "후보", byline: "출처 미상", provenance: "발견 후보 메타데이터", access: { kind: "UNKNOWN", label: "접근 경로 확인 필요", actionLabel: "출처 정보 보기", href: null }, summary: null, fragments: [], questions: [], keywords: [] }} />);
    expect(screen.queryByRole("link", { name: /원문/ })).not.toBeInTheDocument();
    expect(screen.getByText("분석 내용 없음")).toBeInTheDocument();
  });
});
```

- [ ] **Step 6: 읽기 레이아웃 CSS를 구현하고 검증한다**

`reading.css` must define `.split-workspace` as `grid-template-columns: minmax(240px, 288px) minmax(420px, 1fr) minmax(210px, 235px)`, limit `.reading-pane__body` to 760px, collapse the decision rail into an accessible `<details>` panel below 1280px, and switch list/detail to sequential screens below 900px.

Run:

```bash
pnpm --filter @radar/web exec vitest run src/lib/sourceAccess.test.ts src/components/reading/ReadingPane.test.tsx
pnpm --filter @radar/web typecheck
```

Expected: PASS.

- [ ] **Step 7: 커밋한다**

```bash
git add web/src/lib/sourceAccess.ts web/src/lib/sourceAccess.test.ts web/src/components/ui web/src/components/reading web/src/styles/reading.css web/src/main.tsx
git commit -m "260821: 출처 중심 공통 읽기 작업공간 구성"
```

---

### Task 4: 저장소를 읽기 작업 공간으로 전환

**Files:**
- Create: `web/src/views/ReservoirView.test.tsx`
- Create: `web/src/styles/views.css`
- Modify: `web/src/main.tsx`
- Modify: `web/src/views/ReservoirView.tsx:1-309`

**Interfaces:**
- Consumes: `SplitWorkspace`, `SourceIndex`, `ReadingPane`, `DecisionRail`
- Consumes: existing `/api/reservoir`, `/api/reservoir/:id`, `/api/search`, `/api/signals`, `/api/inbox/retry/:id`
- Produces: selected source state that remains inside the list/detail workspace

- [ ] **Step 1: 목록 유지와 신호 기록 테스트를 작성한다**

Create `web/src/views/ReservoirView.test.tsx` with mocked fetch responses for `/api/reservoir`, `/api/reservoir/topics`, and `/api/reservoir/source-1`. Assert that clicking `자료 A` keeps the `저장소 자료` index heading visible, renders `시스템 해석`, and clicking `발전시키기` posts `{ sourceId: "source-1", action: "develop" }` to `/api/signals`.

Use this assertion for the signal body:

```ts
expect(fetch).toHaveBeenCalledWith("/api/signals", expect.objectContaining({
  method: "POST",
  body: JSON.stringify({ sourceId: "source-1", action: "develop" }),
}));
```

- [ ] **Step 2: 테스트가 현재 full-page detail 전환 때문에 실패하는지 확인한다**

Run:

```bash
pnpm --filter @radar/web exec vitest run src/views/ReservoirView.test.tsx
```

Expected: FAIL because current detail mode removes the list and has English actions.

- [ ] **Step 3: API data를 공통 reading 타입으로 변환한다**

Add pure adapters inside `ReservoirView.tsx`:

```ts
function toIndexItem(item: ReservoirItem): SourceIndexItem {
  return {
    id: item.id,
    title: item.title,
    meta: [item.kind, item.reliability, item.year].filter(Boolean).join(" · "),
    tags: item.topics ? JSON.parse(item.topics) as string[] : [],
    access: deriveSourceAccess({ href: item.canonicalUrl ?? null }),
  };
}

function toReadingDocument(detail: SourceDetail): ReadingDocument {
  const source = detail.source;
  return {
    id: String(source.id),
    title: String(source.title),
    byline: [source.authors, source.year, source.origin].filter(Boolean).map(String).join(" · "),
    provenance: `${String(source.provenanceClass ?? "SOURCE")} · ${String(source.reliability ?? "")}`,
    access: deriveSourceAccess({ href: source.canonicalUrl ? String(source.canonicalUrl) : null }),
    summary: detail.analysis?.summary ?? null,
    fragments: detail.analysis?.important_fragments ?? detail.fragments.map((fragment) => fragment.text),
    questions: detail.analysis?.questions ?? detail.questions.map((question) => question.question),
    keywords: detail.analysis?.keywords ?? detail.keywords.map((keyword) => keyword.keyword),
  };
}
```

Add `canonicalUrl: string | null` to `ReservoirItem` because the existing API already returns it.

- [ ] **Step 4: return 구조를 3열 작업 공간으로 교체한다**

Keep filters and search in the index area. Never return early when `detail` exists. Render:

```tsx
<SplitWorkspace
  index={<SourceIndex title="저장소 자료" items={visibleItems} selectedId={selectedId} onSelect={openDetail} />}
  reading={detail ? <ReadingPane document={toReadingDocument(detail)} /> : <StatusMessage kind="empty" title="읽을 자료를 선택하세요" />}
  decision={detail ? <DecisionRail actions={DECISION_ACTIONS} pending={actionPending} onAction={signal} secondaryAction={{ label: "다시 분석하기", onClick: reanalyze }} /> : null}
/>
```

Search results use the same `SourceIndex` and preserve `query`, `kindFilter`, `topicFilter`, selected ID, and list scroll when detail changes. Create `views.css` with Reservoir index/filter/empty-state rules and import it from `main.tsx` after `reading.css`.

- [ ] **Step 5: 오류와 빈 상태를 연결한다**

Set explicit `listError` and `detailError` state. `StatusMessage` actions call `load()` or `openDetail(selectedId)`. A failed signal restores the previous selected action and displays `분류를 저장하지 못했습니다. 다시 시도하세요.`

- [ ] **Step 6: 테스트와 빌드를 확인한다**

Run:

```bash
pnpm --filter @radar/web exec vitest run src/views/ReservoirView.test.tsx
pnpm --filter @radar/web typecheck
pnpm --filter @radar/web build
```

Expected: PASS and no Worker changes.

- [ ] **Step 7: 커밋한다**

```bash
git add web/src/main.tsx web/src/views/ReservoirView.tsx web/src/views/ReservoirView.test.tsx web/src/styles/views.css
git commit -m "260821: 저장소 목록읽기판단 흐름 재구성"
```

---

### Task 5: 발견 후보를 읽기·판단 중심으로 전환

**Files:**
- Create: `web/src/views/DiscoverView.test.tsx`
- Modify: `web/src/App.tsx`
- Modify: `web/src/views/DiscoverView.tsx:1-262`
- Modify: `web/src/styles/views.css`

**Interfaces:**
- Consumes: shared reading components and `deriveSourceAccess`
- Consumes: existing `/api/discover/candidates`, candidate action, discovery run APIs
- Produces: `onNavigate(view: View)` after develop action imports a candidate

- [ ] **Step 1: candidate provenance와 develop 흐름 테스트를 작성한다**

Mock a candidate with `provider: "riss"`, `externalUrl: "https://www.riss.kr/item"`, and `queryUsed: "machine vision"`. Assert:

```ts
expect(screen.getByText("발견 후보 메타데이터")).toBeInTheDocument();
expect(screen.getByText("기관 인증 여부 확인")).toBeInTheDocument();
expect(screen.queryByText("시스템 해석")).not.toBeInTheDocument();
```

For `발전시키기`, mock candidate keep response `{ status: "KEPT", sourceId: "source-2" }`, then assert a second request posts `develop` to `/api/signals`, followed by `onNavigate("RESERVOIR")`.

- [ ] **Step 2: 현재 화면에서 테스트가 실패하는지 확인한다**

Run:

```bash
pnpm --filter @radar/web exec vitest run src/views/DiscoverView.test.tsx
```

Expected: FAIL because current screen has no selected reading pane and no develop flow.

- [ ] **Step 3: 후보 adapter를 구현한다**

Use only API fields that exist:

```ts
function candidateToDocument(candidate: Candidate): ReadingDocument {
  const href = candidate.externalUrl ?? candidate.openalexId;
  return {
    id: candidate.id,
    title: candidate.title,
    byline: [candidate.authors, candidate.year, candidate.provider].filter(Boolean).join(" · "),
    provenance: `발견 후보 메타데이터 · 검색어 ${candidate.queryUsed ?? "자동 관심 신호"}`,
    access: deriveSourceAccess({ provider: candidate.provider, href, verified: Boolean(candidate.openalexId) }),
    summary: null,
    fragments: [],
    questions: candidate.queryUsed ? [`“${candidate.queryUsed}”와 어떤 관련이 있는지 원문에서 확인하세요.`] : [],
    keywords: candidate.queryUsed ? [candidate.queryUsed] : [],
  };
}
```

This adapter must not convert `relevanceScore` or `queryUsed` into an AI summary.

- [ ] **Step 4: 발견 페이지를 SplitWorkspace로 교체한다**

Keep the existing custom query and RSS/Atom state/functions in a temporary collapsed `발견 설정` details block at the bottom of Discover so this task remains independently functional. Task 9 moves that block and its state into Settings, then removes it from Discover. Keep curated source shortcuts in a compact collapsible section above the candidate index. Render candidate filters as `전체 후보`, `보관됨`, `관찰 중`, `제외됨`.

`DecisionRail` behavior:

```ts
async function decide(action: DecisionAction["id"]): Promise<void> {
  if (!selectedCandidate) return;
  if (action === "develop") {
    const kept = await act(selectedCandidate.id, "keep");
    if (!kept.sourceId) throw new Error("source_link_missing");
    await fetch("/api/signals", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sourceId: kept.sourceId, action: "develop" }) });
    onNavigate("RESERVOIR");
    return;
  }
  await act(selectedCandidate.id, action);
}
```

Map `keep`, `watch`, and `ignore` directly to current candidate routes. Keep the run limit and weekly cron note in the page header description, not in the reading body.

Change `DiscoverView` to accept `onNavigate: (view: View) => void`, then update `App.tsx` to render `<DiscoverView onNavigate={setView} />`.

- [ ] **Step 5: 빈 상태와 실행 상태를 한글화한다**

Use `Task Center` for discovery progress. Candidate-empty text must be `검토할 후보가 없습니다` and provide `새 자료 찾기`. Failure must preserve the previous list and show `새 자료를 가져오지 못했습니다. 기존 후보는 계속 검토할 수 있습니다.`

- [ ] **Step 6: 테스트와 빌드를 확인한다**

Run:

```bash
pnpm --filter @radar/web exec vitest run src/views/DiscoverView.test.tsx
pnpm --filter @radar/web typecheck
pnpm --filter @radar/web build
```

Expected: PASS.

- [ ] **Step 7: 커밋한다**

```bash
git add web/src/App.tsx web/src/views/DiscoverView.tsx web/src/views/DiscoverView.test.tsx web/src/styles/views.css
git commit -m "260821: 발견 후보 읽기와 분류 흐름 재구성"
```

---

### Task 6: 착즙 결과를 긴 연구 문서로 전환

**Files:**
- Create: `web/src/components/distill/DocumentOutline.tsx`
- Create: `web/src/components/distill/SelectionTray.tsx`
- Create: `web/src/views/DistillView.test.tsx`
- Modify: `web/src/views/DistillView.tsx:1-373`
- Modify: `web/src/styles/views.css`

**Interfaces:**
- Consumes: current Distill session, queue, selection and run endpoints
- Produces: `DistillSectionKey` union matching backend output keys exactly
- Produces: section-level selection tray; no per-item backend claim

- [ ] **Step 1: section ordering과 선택 payload 테스트를 작성한다**

Create a fixture session containing keywords, one reading queue item, one research gap, Critic, and Counter. Assert that `지금 직접 읽을 자료` appears before `연구 간극`, and clicking `이 섹션 유지` under Reading Queue adds `read_next` to the tray.

After clicking `선택 항목 다시 착즙`, assert:

```ts
expect(fetch).toHaveBeenCalledWith("/api/distill/run", expect.objectContaining({
  method: "POST",
  body: JSON.stringify({ redistillOf: "session-1", keepElements: ["read_next"], promptVariant: "distill-v2-terse" }),
}));
```

- [ ] **Step 2: 현재 카드 나열 UI에서 실패하는지 확인한다**

Run:

```bash
pnpm --filter @radar/web exec vitest run src/views/DistillView.test.tsx
```

Expected: FAIL because current queue appears after questions and selection is a bottom checkbox list.

- [ ] **Step 3: section key와 목차를 구현한다**

Define:

```ts
export type DistillSectionKey =
  | "keywords"
  | "thoughts_fragments"
  | "questions"
  | "read_next"
  | "research_gaps"
  | "research_directions"
  | "artwork_directions"
  | "small_experiment";

export const DISTILL_SECTIONS: { key: DistillSectionKey; label: string }[] = [
  { key: "thoughts_fragments", label: "핵심 흐름" },
  { key: "read_next", label: "지금 직접 읽을 자료" },
  { key: "questions", label: "남은 질문" },
  { key: "research_gaps", label: "연구 간극" },
  { key: "research_directions", label: "연구 방향" },
  { key: "artwork_directions", label: "작업 방향" },
  { key: "small_experiment", label: "작은 실험" },
];

function toggleKept(key: DistillSectionKey): void {
  setKept((current) => current.includes(key) ? current.filter((item) => item !== key) : [...current, key]);
}
```

`DocumentOutline` renders links to stable section IDs and accepts `sections` plus `onSelect(sectionId)`. `SelectionTray` accepts `selected: DistillSectionKey[]`, `onToggle`, `onRedistill`, `onSave`, `busy`, and budget state.

- [ ] **Step 4: DistillView 문서 구조를 구현한다**

Keep all existing API functions but replace the return tree with:

```tsx
<div className="distill-workspace">
  <DocumentOutline sections={DISTILL_SECTIONS} onSelect={(sectionId) => document.getElementById(sectionId)?.scrollIntoView({ behavior: "smooth" })} />
  <article className="distill-document">
    <header className="distill-document__header">
      <p>착즙 결과 · {formatDateKo(data.session.createdAt)}</p>
      <h2>현재 연구 흐름의 종합</h2>
      <p>{data.session.sourcesUsed?.length ?? 0}개 원자료의 종합 해석</p>
    </header>
    <section id="distill-core">
      <h3>핵심 흐름</h3>
      {o.thoughts_fragments.map((text) => <p key={text}>{text}</p>)}
      <button type="button" onClick={() => toggleKept("thoughts_fragments")}>이 섹션 유지</button>
    </section>
    <section id="distill-reading">
      <h3>지금 직접 읽을 자료</h3>
      {data.readingQueue.map((item) => <ReadingQueueItem key={item.id} item={item} onVerify={verifyQueue} onImport={importQueueItem} />)}
      <button type="button" onClick={() => toggleKept("read_next")}>이 섹션 유지</button>
    </section>
    <section id="distill-questions">
      <h3>남은 질문</h3>
      {o.questions.map((question) => <p key={question}>{question}</p>)}
      <button type="button" onClick={() => toggleKept("questions")}>이 섹션 유지</button>
    </section>
    <section id="distill-gaps">
      <h3>연구 간극</h3>
      {data.researchGaps.map((gap) => <p key={gap.id}>{gap.gap}</p>)}
      <button type="button" onClick={() => toggleKept("research_gaps")}>이 섹션 유지</button>
    </section>
    <section id="distill-critic-counter">
      <h3>비평과 반대 관점</h3>
      <p>{data.session.critic?.overall ?? "비평 결과 없음"}</p>
      {data.session.counter?.suggestions.map((suggestion) => <p key={suggestion.direction}>{suggestion.direction}</p>)}
    </section>
  </article>
  <SelectionTray selected={kept as DistillSectionKey[]} onToggle={toggleKept} onRedistill={() => runDistill(data.session.id)} onSave={saveSelection} busy={distillBusy} budget={budget} />
</div>
```

Define `ReadingQueueItem` locally in `DistillView.tsx`:

```tsx
interface ReadingQueueItemProps {
  item: SessionData["readingQueue"][number];
  onVerify: () => Promise<void>;
  onImport: (itemId: string) => Promise<void>;
}

function ReadingQueueItem({ item, onVerify, onImport }: ReadingQueueItemProps) {
  const access = deriveSourceAccess({ provider: item.openalexId ? "openalex" : null, href: item.sourceUrl ?? item.openalexId, verified: item.verified === 1 });
  return (
    <article className="distill-reading-item">
      <p>{item.priority === "MUST" ? "필독" : item.priority === "WORTH" ? "읽을 가치 있음" : "참고"}</p>
      <h4>{item.title}</h4>
      {item.author && <p>{item.author}</p>}
      {item.whyRead && <p>{item.whyRead}</p>}
      <SourceAccessBadge access={access} />
      {item.verified === 1 ? (
        <button type="button" onClick={() => void onImport(item.id)}>저장소에 보관</button>
      ) : (
        <button type="button" onClick={() => void onVerify()}>실존 여부 확인</button>
      )}
    </article>
  );
}
```

Remove the visible prompt variant selector from the primary UI and keep `variant` initialized to `distill-v2-terse` internally.

- [ ] **Step 5: queue access and provenance를 적용한다**

For each reading queue item, call:

```ts
deriveSourceAccess({ provider: q.openalexId ? "openalex" : null, href: q.sourceUrl ?? q.openalexId, verified: q.verified === 1 })
```

Render `실존 확인됨` separately from access status. Disable `저장소에 보관` when `verified !== 1`, matching the existing backend guardrail.

- [ ] **Step 6: 테스트와 빌드를 확인한다**

Run:

```bash
pnpm --filter @radar/web exec vitest run src/views/DistillView.test.tsx
pnpm --filter @radar/web typecheck
pnpm --filter @radar/web build
```

Expected: PASS.

- [ ] **Step 7: 커밋한다**

```bash
git add web/src/components/distill web/src/views/DistillView.tsx web/src/views/DistillView.test.tsx web/src/styles/views.css
git commit -m "260821: 착즙 결과 읽기문서와 선택 흐름 재구성"
```

---

### Task 7: 레이더를 연구 편집 데스크로 전환

**Files:**
- Create: `web/src/views/RadarView.test.tsx`
- Modify: `web/src/App.tsx`
- Modify: `web/src/views/RadarView.tsx:1-195`
- Modify: `web/src/styles/views.css`

**Interfaces:**
- Consumes: current radar stats, snapshots, synthesis endpoints
- Consumes: `/api/distill/sessions` and latest `/api/distill/sessions/:id` for verified reading queue links
- Produces: `RadarViewProps { onNavigate(view: View): void }`

- [ ] **Step 1: 읽을 자료와 수동 synthesis 테스트를 작성한다**

Mock weekly stats, one synthesis, session list, and a latest session with a verified source URL. Assert that the page renders `지금 직접 읽기`, a real external link, and the CTA `이번 주 흐름 종합하기`. Assert that changing to `이번 달` causes `/api/radar/stats?period=MONTHLY` and does not automatically POST synthesis.

- [ ] **Step 2: 현재 화면에서 실패하는지 확인한다**

Run:

```bash
pnpm --filter @radar/web exec vitest run src/views/RadarView.test.tsx
```

Expected: FAIL because the current view has no latest reading queue rail and English controls.

- [ ] **Step 3: Radar data를 편집 데스크 섹션으로 매핑한다**

Use deterministic mapping:

```ts
const changeRows = [
  ...stats.newKeywords.slice(0, 3).map((item) => ({ kind: "관심 상승", title: item.keyword, meta: `새 자료 ${item.count}개` })),
  ...stats.newQuestions.slice(0, 2).map((question) => ({ kind: "계속 남음", title: question, meta: "최근 질문" })),
];
```

Do not invent narrative when synthesis is absent. Show `통계는 준비되었습니다. 필요할 때 흐름 종합을 실행하세요.` and render the deterministic rows.

- [ ] **Step 4: 최신 verified reading queue를 읽는다**

After `/api/distill/sessions`, fetch only the latest session detail. Filter `verified === 1` and a non-null `sourceUrl`, then display up to three items. If none exist, render `확인된 읽을 자료가 아직 없습니다` with `착즙에서 읽을 자료 만들기`, calling `onNavigate("DISTILL")`.

- [ ] **Step 5: A안 레이아웃을 구현한다**

Render main narrative and change index on the left, and reading queue plus next actions on the right. Add the spectrum line once beneath the period header. Use CSS grid `minmax(520px, 1fr) 290px`; stack the right rail below 1050px.

Next actions are computed from current data only:

- discovery candidate count is not available in Radar API, so link to `발견 후보 검토` without a fabricated count.
- if no source exists, show `자료 추가` and navigate to Inbox.
- if reading queue exists, show `선택한 자료 착즙` and navigate to Distill.

Change `RadarView` to accept `onNavigate: (view: View) => void`, then update `App.tsx` to render `<RadarView onNavigate={setView} />`.

- [ ] **Step 6: 테스트와 빌드를 확인한다**

Run:

```bash
pnpm --filter @radar/web exec vitest run src/views/RadarView.test.tsx
pnpm --filter @radar/web typecheck
pnpm --filter @radar/web build
```

Expected: PASS.

- [ ] **Step 7: 커밋한다**

```bash
git add web/src/App.tsx web/src/views/RadarView.tsx web/src/views/RadarView.test.tsx web/src/styles/views.css
git commit -m "260821: 레이더 연구편집 대시보드 재구성"
```

---

### Task 8: 받은 자료 입력과 처리 상태 분리

**Files:**
- Create: `web/src/views/InboxView.test.tsx`
- Modify: `web/src/App.tsx`
- Modify: `web/src/views/InboxView.tsx:1-245`
- Modify: `web/src/styles/views.css`

**Interfaces:**
- Consumes: existing text, URL, file, retry endpoints and PDF helpers
- Produces: `InboxViewProps { onNavigate(view: View): void }`

- [ ] **Step 1: 기본 목록과 자료 추가 패널 테스트를 작성한다**

Assert that initial render shows `최근 처리 자료` and one `자료 추가` button, but not all three forms. Clicking the button exposes tabs `텍스트`, `URL`, `파일`. A failed item must show `다시 시도`; an indexed item must show `저장소에서 읽기` and call `onNavigate("RESERVOIR")`.

- [ ] **Step 2: 현재 세 입력 폼 노출 구조에서 실패하는지 확인한다**

Run:

```bash
pnpm --filter @radar/web exec vitest run src/views/InboxView.test.tsx
```

Expected: FAIL because all forms are visible and actions are English.

- [ ] **Step 3: 자료 추가 panel state를 구현한다**

Add:

```ts
type IntakeMode = "TEXT" | "URL" | "FILE";
const [intakeOpen, setIntakeOpen] = useState(false);
const [intakeMode, setIntakeMode] = useState<IntakeMode>("TEXT");
```

Use an in-tree panel with `role="dialog"`, `aria-modal="true"`, a visible `자료 추가` heading, and a `닫기` button that restores focus to the trigger. Preserve the existing `addNote`, `addUrl`, and `onFile` functions. File drop and file input must call the same `ingestFiles(files: File[])` function.

- [ ] **Step 4: 처리 목록을 한글 상태 인덱스로 교체한다**

Use this label map:

```ts
const STATUS_LABELS: Record<InboxItem["status"], string> = {
  received: "받음",
  stored: "원본 보존",
  extracted: "텍스트 추출",
  analyzed: "분석",
  indexed: "읽기 준비",
  failed: "처리 실패",
};
```

Each row renders title, type, current stage, and date. Only failed rows reveal the shortened error and retry action. Indexed rows expose `저장소에서 읽기`. Scanned PDF text warning must say `텍스트 층이 없는 PDF입니다. 원본은 보존했으며 핵심 문장을 메모로 추가하면 분석할 수 있습니다.`

Change `InboxView` to accept `onNavigate: (view: View) => void`, then update `App.tsx` to render `<InboxView onNavigate={setView} />`.

- [ ] **Step 5: 테스트와 빌드를 확인한다**

Run:

```bash
pnpm --filter @radar/web exec vitest run src/views/InboxView.test.tsx
pnpm --filter @radar/web typecheck
pnpm --filter @radar/web build
```

Expected: PASS.

- [ ] **Step 6: 커밋한다**

```bash
git add web/src/App.tsx web/src/views/InboxView.tsx web/src/views/InboxView.test.tsx web/src/styles/views.css
git commit -m "260821: 받은자료 입력과 처리상태 UX 정리"
```

---

### Task 9: 설정과 AI 사용량을 보조 화면으로 정리

**Files:**
- Create: `web/src/views/SettingsView.test.tsx`
- Create: `web/src/views/UsageView.test.tsx`
- Modify: `web/src/views/SettingsView.tsx:1-207`
- Modify: `web/src/views/UsageView.tsx:1-125`
- Modify: `web/src/styles/views.css`

**Interfaces:**
- Consumes: existing params, queries, feeds, export, maintenance, homepage, usage APIs
- Produces: only five research parameters in the primary settings section

- [ ] **Step 1: 설정 정보 구조 테스트를 작성한다**

Assert primary headings appear in this order: `연구 성향`, `홈페이지`, `데이터 내보내기`, `발견 소스`, `고급 관리`. Assert `의미 인덱스 만들기` and `토픽 다시 분류하기` are hidden until `고급 관리` details is expanded. Assert the five sliders use these Korean labels:

```ts
["익숙함", "연구 깊이", "예상 밖 연결", "반대 관점 강도", "기술 ↔ 사진"]
```

- [ ] **Step 2: 사용량 안전장치 테스트를 작성한다**

For `usedPct: 82`, assert `예산의 82%를 사용했습니다`, `주의 구간`, and `착즙은 100%에서 중단됩니다` appear. For `usedPct: 10`, assert no warning role is rendered.

- [ ] **Step 3: 현재 UI에서 실패하는지 확인한다**

Run:

```bash
pnpm --filter @radar/web exec vitest run src/views/SettingsView.test.tsx src/views/UsageView.test.tsx
```

Expected: FAIL because labels and grouping are English and maintenance actions are always visible.

- [ ] **Step 4: Settings를 네 개 primary section과 고급 관리로 재구성한다**

Move the existing query/feed state and save functions from Discover to Settings without changing endpoints. Use `details` for `발견 소스` and `고급 관리`, but keep `연구 성향` open.

Replace parameter metadata with:

```ts
const PARAM_FIELDS = [
  { key: "familiarity", label: "익숙함", left: "새로운 영역", right: "기존 관심사" },
  { key: "researchDepth", label: "연구 깊이", left: "가벼운 탐색", right: "깊은 연구" },
  { key: "divergence", label: "예상 밖 연결", left: "정합적 연결", right: "뜻밖의 연결" },
  { key: "counterStrength", label: "반대 관점 강도", left: "약한 반대", right: "강한 반대 미학" },
  { key: "technicalPhotographic", label: "기술 ↔ 사진", left: "기술·시스템", right: "이미지·빛·물질" },
] as const;
```

Use Korean preset labels and preserve the current `PRESETS` values.

- [ ] **Step 5: Usage를 예산 안전장치로 재구성한다**

Show used, budget, and remaining amount in one compact header; use the progress bar with text label. Render purpose and model tables below. Keep daily bars only when at least two days exist. Add:

```ts
const budgetState = data.usedPct >= 100 ? "BLOCKED" : data.usedPct >= 80 ? "WARNING" : "NORMAL";
```

Use `role="alert"` only for WARNING and BLOCKED. State that Workers AI free allocation is not included, in Korean.

- [ ] **Step 6: 테스트와 빌드를 확인한다**

Run:

```bash
pnpm --filter @radar/web exec vitest run src/views/SettingsView.test.tsx src/views/UsageView.test.tsx
pnpm --filter @radar/web typecheck
pnpm --filter @radar/web build
```

Expected: PASS.

- [ ] **Step 7: 커밋한다**

```bash
git add web/src/views/SettingsView.tsx web/src/views/SettingsView.test.tsx web/src/views/UsageView.tsx web/src/views/UsageView.test.tsx web/src/styles/views.css
git commit -m "260821: 설정과 AI예산 보조화면 재구성"
```

---

### Task 10: 브라우저 핵심 흐름, 반응형, 문서 정합성

**Files:**
- Create: `web/playwright.config.ts`
- Create: `web/src/test/fixtures.ts`
- Create: `web/tests/e2e/core-reading-flow.spec.ts`
- Modify: `web/src/styles/base.css`
- Modify: `web/src/styles/shell.css`
- Modify: `web/src/styles/reading.css`
- Modify: `web/src/styles/views.css`
- Modify: `docs/SPEC.md:17-30`
- Modify: `docs/PROJECT_CONTEXT.md:40-63`

**Interfaces:**
- Consumes: all completed UI tasks
- Produces: browser-level acceptance evidence and updated source-of-truth docs

- [ ] **Step 1: Playwright config와 mock fixture를 작성한다**

Create `web/playwright.config.ts`:

```ts
import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  use: { baseURL: "http://127.0.0.1:4173", trace: "retain-on-failure" },
  webServer: { command: "pnpm build && pnpm preview --host 127.0.0.1", port: 4173, reuseExistingServer: true },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 1000 } } },
    { name: "narrow", use: { ...devices["Desktop Chrome"], viewport: { width: 820, height: 1000 } } },
  ],
});
```

`fixtures.ts` exports deterministic JSON objects matching every API response used by App, Radar, Discover, Reservoir, Distill, Inbox, Settings, and Usage.

- [ ] **Step 2: 핵심 읽기 흐름 E2E를 작성한다**

In `core-reading-flow.spec.ts`, route `/api/**` to fixtures and record POST bodies. The test must:

1. Confirm Korean sidebar and no `API: connected` debug copy.
2. Open `발견`, select a RISS candidate, verify `기관 인증 여부 확인`.
3. Click `보관하기`, verify the candidate action request.
4. Open `저장소`, select a source, verify `시스템 해석` and `원문에서 추출한 문장` are distinct.
5. Click `발전시키기`, verify `/api/signals` body.
6. Open `착즙`, verify reading queue precedes research gaps.
7. Select `read_next` and verify Re-Distill body.

Use accessible role/name locators only; do not select by CSS class.

- [ ] **Step 3: E2E가 발견하는 반응형 문제를 수정한다**

Run:

```bash
pnpm --filter @radar/web test:e2e
```

Expected before fixes: at least the narrow project exposes overflow or inaccessible decision actions. Adjust CSS until both projects pass. At 820px, the decision rail must appear as a labeled expandable panel and the source index must remain reachable without horizontal page scrolling.

- [ ] **Step 4: 접근성과 한글 copy 회귀를 검사한다**

Run:

```bash
rg -n 'Run |Save |Loading|No |Keep|Watch|Ignore|Retry|Summary|Questions|Research Gaps|Artwork Directions|Monthly|By purpose|By model' web/src --glob '*.tsx'
```

Expected: no user-facing English matches outside proper nouns and first-use product terms. Replace every remaining control/status string with the approved Korean copy.

Run:

```bash
rg -n 'style=\{\{' web/src/App.tsx web/src/views web/src/components
```

Expected: no layout or visual styling remains inline. Dynamic width/progress values may use CSS custom properties set through `style` with an explanatory local type.

- [ ] **Step 5: 문서의 D9와 현재 상태를 갱신한다**

In `docs/SPEC.md`, change D9 to:

```md
| D9 | UI 언어 | **한글** — 제품 고유 개념은 첫 노출에만 영문 병기, 원자료 고유명사는 원문 유지 | 2026-08-21 사용자 확정. 모든 CTA·상태·오류 문구 한글화 |
```

In `docs/PROJECT_CONTEXT.md`, add the new AppShell, shared reading workspace, Korean UI decision, and test commands:

```bash
pnpm --filter @radar/web test
pnpm --filter @radar/web test:e2e
pnpm typecheck
pnpm build
```

- [ ] **Step 6: 전체 검증을 실행한다**

Run:

```bash
pnpm --filter @radar/web test
pnpm --filter @radar/web test:e2e
pnpm typecheck
pnpm build
git diff --check
```

Expected: every command exits 0. Browser screenshots at 1440px and 820px show no clipped content, false reading link, duplicated primary CTA, or colored page wash.

- [ ] **Step 7: 최종 커밋한다**

```bash
git add web/playwright.config.ts web/src/test/fixtures.ts web/tests/e2e web/src/styles docs/SPEC.md docs/PROJECT_CONTEXT.md
git commit -m "260821: UI 핵심흐름 검증과 한글 사양 동기화"
```

---

## Spec Coverage Review

| 디자인 사양 영역 | 구현 task | 검토 결과 |
|---|---|---|
| 목적·핵심 흐름 | 4, 5, 6, 7, 8 | 레이더→읽기→판단→착즙 경로 포함 |
| 시각 원칙·토큰·언어 | 1, 2, 10 | 한글, 중립 배경, 단일 CTA, spectrum 포함 |
| App Shell·작업 상태 | 2 | nav, usage utility, Task Center 포함 |
| 레이더 | 7 | A안 편집 데스크와 verified 읽기 링크 포함 |
| 발견 | 5, 9 | 후보 읽기·분류와 source 설정 이동 포함 |
| 저장소 | 4 | 목록 유지형 읽기 작업 공간 포함 |
| 착즙 | 6 | Reading Queue 우선 문서와 section Re-Distill 포함 |
| 받은 자료 | 8 | 입력 panel, 처리 인덱스, 실패 복구 포함 |
| 설정·사용량 | 9 | 5개 파라미터, 고급 관리, 예산 안전장치 포함 |
| provenance·접근 상태 | 3, 4, 5, 6 | 원자료/해석 구분과 과장 없는 링크 판정 포함 |
| 오류·빈 상태 | 3~9 | 각 view의 복구 행동 포함 |
| 반응형·접근성 | 2, 3, 10 | 1440px/820px 자동 검증 포함 |
| 회귀·문서 정합성 | 10 | unit, E2E, typecheck, build, D9 갱신 포함 |

검토 결과 Worker API, D1/R2, 모델 설정 변경 없이 사양 전체를 구현할 수 있다. Discover에는 분석 본문이 없으므로 해당 화면은 메타데이터와 발견 경로만 표시하고, 분석 내용은 Keep 후 Reservoir에서 제공한다.

---

## Final Acceptance Checklist

- [ ] 레이더 기본 화면이 A안의 연구 편집 데스크 구조다.
- [ ] 발견과 저장소가 같은 목록·읽기·판단 패턴을 사용한다.
- [ ] 착즙은 Reading Queue를 앞세운 긴 문서 구조다.
- [ ] 원자료, 추출 문장, 시스템 해석, 종합 결과가 구분된다.
- [ ] 실제 링크가 없는 자료에 읽기 CTA가 나타나지 않는다.
- [ ] e-flux, RISS, OpenAlex, arXiv 접근 상태가 과장 없이 표시된다.
- [ ] 발전·보관·관찰·제외가 현재 API와 정확히 연결된다.
- [ ] 받은 자료의 실패 항목만 복구 행동을 강조한다.
- [ ] 설정의 primary 영역에는 5개 연구 파라미터만 노출된다.
- [ ] AI 사용량은 80% 경고와 100% 차단을 명확히 설명한다.
- [ ] 모든 사용자 문구가 한글이며 고유명사는 원문을 유지한다.
- [ ] 1440px와 820px 핵심 흐름 테스트가 통과한다.
- [ ] Worker, D1, R2, 모델 설정에는 변경이 없다.
- [ ] `pnpm typecheck`, `pnpm build`, unit, E2E, `git diff --check`가 모두 통과한다.

## Explicit Non-Goals

- Worker API 또는 D1 migration 변경
- 후보 abstract를 위한 새 외부 API 호출
- 전문 PDF viewer와 웹 원문 proxy
- React Router, 전역 상태 라이브러리, UI framework 도입
- 사용자 정의 taxonomy, 관리자 화면, 지식 그래프 UI
- 디자인 구현과 배포는 이 문서 작성 범위에 포함하지 않는다.
