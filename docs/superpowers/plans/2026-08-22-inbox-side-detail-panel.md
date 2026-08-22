# 받은 자료 우측 상세 패널 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 받은 자료 항목을 클릭하면 목록 오른쪽의 상세 패널에서 검수한다.

**Architecture:** `InboxView`가 선택·로딩·오류 상태를 유지하고, 기존 `IngestionReviewPane`을 우측 열에 렌더링한다. CSS 그리드는 데스크톱 3열과 협소 화면의 자연스러운 축소를 담당한다.

**Tech Stack:** React 19, TypeScript, Vite, Vitest, CSS Grid

## Global Constraints

- 원문과 버전 데이터 API는 변경하지 않는다.
- 데스크톱 클릭은 문서 전체 스크롤을 변경하지 않는다.
- 최신 상세 요청만 화면에 반영한다.

---

### Task 1: 우측 패널의 요청 상태 테스트

**Files:**
- Modify: `web/src/views/InboxView.test.tsx`

- [ ] **Step 1: Write the failing test**

```ts
await user.click(await screen.findByRole("button", { name: /검수할 메모/ }));
expect(screen.getByRole("status")).toHaveTextContent("자료를 여는 중입니다.");
expect(screen.getByLabelText("자료 검수")).toBeInTheDocument();
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -C web exec vitest run src/views/InboxView.test.tsx`
Expected: FAIL because the review panel is not rendered during loading.

- [ ] **Step 3: Write minimal implementation**

Render a right-panel loading state when `detailLoading` is true and no `detail` is available.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm -C web exec vitest run src/views/InboxView.test.tsx`
Expected: PASS.

### Task 2: 3열 레이아웃과 스크롤 제거

**Files:**
- Modify: `web/src/views/InboxView.tsx`
- Modify: `web/src/styles/views.css`

- [ ] **Step 1: Write the failing test**

```ts
expect(screen.getByLabelText("자료 검수")).toBeInTheDocument();
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -C web exec vitest run src/views/InboxView.test.tsx`
Expected: FAIL before the loading panel exists.

- [ ] **Step 3: Write minimal implementation**

Place list and review panel in a `.inbox-workspace` grid, remove `scrollIntoView`, and use a sticky `.inbox-review-panel` with a bounded internal scroll region.

- [ ] **Step 4: Run all checks**

Run: `pnpm -C web exec vitest run && pnpm typecheck && pnpm build && git diff --check`
Expected: all tests, type checks, build and whitespace checks pass.

