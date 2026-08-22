# AI 모델 역할 선택 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 설정 탭에서 기본 모델과 상위 통합·반론 검증 모델을 선택하고, 이후 모든 OpenAI 호출이 저장된 역할 설정을 사용하도록 만든다.

**Architecture:** 기존 `high`·`deep` tier 인터페이스를 유지한다. Worker가 OpenAI 모델 목록을 서버에서 조회하고, 두 모델 ID를 기존 D1 `kv`에 저장한다. 호출 시 역할 설정을 우선 적용하고 없거나 잘못된 경우 기존 `MODEL_HIGH`·`MODEL_DEEP` 환경변수로 복귀한다.

**Tech Stack:** Hono, Cloudflare Workers, D1 KV table, OpenAI-compatible Chat Completions via Cloudflare AI Gateway, Vite, React, Vitest.

## Global Constraints

- 모델명은 화면·코드에 고정하지 않고 설정값 또는 `wrangler` vars로 관리한다.
- 원본·분석 provenance와 기존 분석 결과는 변경하지 않는다.
- 공개 설정 파라미터 5개와 기존 AI 예산 $10 guardrail을 유지한다.
- 브라우저에 OpenAI API 키를 전달하지 않는다.
- 커밋 메시지는 `YYMMDD: 변경 내용 요약` 형식을 사용한다.

---

### Task 1: 모델 역할 타입·저장 헬퍼와 API 계약 테스트

**Files:**
- Create: `worker/src/lib/modelSettings.ts`
- Create: `web/src/lib/modelSettings.ts`
- Test: `web/src/lib/modelSettings.test.ts`
- Modify: `shared/src/index.ts`

**Interfaces:**
- `AiModelRoles = { baseModel: string; reviewModel: string }`
- `loadModelRoles(db, env): Promise<AiModelRoles>`
- `isSelectableModelId(id: string): boolean`
- `filterSelectableModels(ids: string[]): string[]`

- [ ] **Step 1: Write the failing pure-function tests**

  Add tests proving that selectable text models are retained, audio/image/embedding/realtime IDs are filtered, blank IDs are rejected, and malformed saved values fall back to environment defaults.

- [ ] **Step 2: Run the focused test and verify RED**

  Run `pnpm --filter @radar/web exec vitest run src/lib/modelSettings.test.ts`.

  Expected: FAIL because the model-selection helpers do not exist.

- [ ] **Step 3: Implement the minimal shared contract and helpers**

  Add the shared `AiModelRoles` type, the KV key `ai_model_roles_v1`, JSON parsing with fallback values, and model ID filtering. Do not perform network calls in these helpers.

- [ ] **Step 4: Run the focused test and verify GREEN**

  Run `pnpm --filter @radar/web exec vitest run src/lib/modelSettings.test.ts`.

  Expected: all focused tests pass.

- [ ] **Step 5: Commit**

  Run `git add shared/src/index.ts worker/src/lib/modelSettings.ts web/src/lib/modelSettings.ts web/src/lib/modelSettings.test.ts && git commit -m "260822: AI 모델 역할 설정 계약 추가"`.

### Task 2: Worker 모델 목록·연결 시험·저장 API

**Files:**
- Modify: `worker/src/routes/settings.ts`
- Modify: `worker/src/env-secrets.d.ts`
- Modify: `worker/wrangler.jsonc`
- Test: `web/src/views/SettingsUsageView.test.tsx`

**Interfaces:**
- `GET /api/settings/models` returns `{ roles, models: [{ id, created, shutdownDate, pricingKnown }] }`.
- `POST /api/settings/models/test` accepts `{ modelId }` and returns `{ ok, model, pricingKnown, costUsd }`.
- `PUT /api/settings/models` accepts `{ baseModel, reviewModel }` and returns the saved roles.

- [ ] **Step 1: Extend the settings view test with the expected model API responses**

  Stub `/api/settings/models` with two model options and assert that the settings page renders both role labels and both model IDs.

- [ ] **Step 2: Run the focused view test and verify RED**

  Run `pnpm --filter @radar/web exec vitest run src/views/SettingsUsageView.test.tsx`.

  Expected: FAIL because the settings view has no model-role section.

- [ ] **Step 3: Add server-side model discovery and validation**

  Fetch `${OPENAI_BASE_URL}/models` using the existing OpenAI credentials, filter the result through `isSelectableModelId`, remove models with a past `shutdown_date`, and return only safe metadata. Add a `MODEL_PRICING_JSON` var plus conservative unknown-model rates in configuration. The test endpoint must call `callOpenAi` with `modelId`, `purpose: "model_validation"`, JSON mode, and `maxOutputTokens: 32`.

- [ ] **Step 4: Add D1 KV persistence for the two roles**

  Validate both IDs against the currently available selectable model list, write one JSON value to `ai_model_roles_v1`, and return the roles. If the model list cannot be fetched, return `503` and leave the previous setting unchanged.

- [ ] **Step 5: Run the focused view test and verify GREEN**

  Run `pnpm --filter @radar/web exec vitest run src/views/SettingsUsageView.test.tsx`.

  Expected: the API contract and rendered section tests pass.

- [ ] **Step 6: Commit**

  Run `git add worker/src/routes/settings.ts worker/src/env-secrets.d.ts worker/wrangler.jsonc web/src/views/SettingsUsageView.test.tsx && git commit -m "260822: 모델 목록과 역할 설정 API 추가"`.

### Task 3: OpenAI 호출을 선택된 역할과 가격표에 연결

**Files:**
- Modify: `worker/src/lib/openai.ts`
- Modify: `worker/src/env-secrets.d.ts`
- Modify: `worker/wrangler.jsonc`
- Modify: `worker/src/analysis/deepAnalyze.ts`
- Test: `web/src/lib/modelSettings.test.ts`

**Interfaces:**
- `OpenAiCallOptions.modelId?: string` is used only by the model connection test.
- Existing `model: "low" | "high" | "deep"` call sites remain valid.
- Tier resolution order is saved role → environment fallback.

- [ ] **Step 1: Add failing tests for role resolution and unknown pricing**

  Test that a saved base/review role maps `high`/`deep` to the saved IDs, absent settings map to `MODEL_HIGH`/`MODEL_DEEP`, and unknown model IDs use conservative pricing rather than the old tier price.

- [ ] **Step 2: Run the focused tests and verify RED**

  Run `pnpm --filter @radar/web exec vitest run src/lib/modelSettings.test.ts`.

  Expected: FAIL because dynamic tier resolution and pricing helpers are absent.

- [ ] **Step 3: Implement dynamic resolution and price parsing**

  Update `callOpenAi` to resolve the selected ID from D1 for high/deep calls, honor `modelId` for validation, parse `MODEL_PRICING_JSON`, mark unknown pricing in the returned usage result, and calculate cost using the configured rate or conservative fallback. Keep low-tier behavior unchanged.

- [ ] **Step 4: Verify the existing deep path still uses only one role boundary**

  Keep chunk calls on the base tier and final synthesis on the review tier in `analyzeDeepSource`. Preserve the existing `MODEL_DEEP` fallback when no saved review model exists.

- [ ] **Step 5: Run tests and typecheck**

  Run `pnpm --filter @radar/web exec vitest run src/lib/modelSettings.test.ts && pnpm typecheck`.

  Expected: focused tests pass and both workspaces typecheck.

- [ ] **Step 6: Commit**

  Run `git add worker/src/lib/openai.ts worker/src/analysis/deepAnalyze.ts worker/src/env-secrets.d.ts worker/wrangler.jsonc web/src/lib/modelSettings.test.ts && git commit -m "260822: 선택 모델과 보수적 비용 계산 연결"`.

### Task 4: 설정 탭 모델 선택 UI 구현

**Files:**
- Modify: `web/src/views/SettingsView.tsx`
- Modify: `web/src/styles/views.css`
- Modify: `web/src/views/SettingsUsageView.test.tsx`

**Interfaces:**
- UI has exactly two selects: `기본 모델`, `상위 통합·반론 검증 모델`.
- UI has `모델 목록 새로고침`, `연결 확인`, and `모델 설정 저장` actions.
- Model names and unknown-pricing warning are visible; API credentials are never rendered.

- [ ] **Step 1: Implement loading state and role controls**

  Fetch `/api/settings/models` when the settings view mounts, initialize both selects from saved roles, and keep the existing research parameter settings independent from model settings.

- [ ] **Step 2: Implement connection tests and save feedback**

  Test both selected IDs before save, show per-role success/failure messages, block save when either test fails, and show a warning when pricing is unknown. Keep the current settings page status style and Korean copy.

- [ ] **Step 3: Add responsive model-role styling**

  Add a two-column desktop grid that collapses to one column under the existing mobile breakpoint. Use existing borders, accent, muted text, and button styles.

- [ ] **Step 4: Run view tests and build**

  Run `pnpm --filter @radar/web exec vitest run src/views/SettingsUsageView.test.tsx && pnpm --filter @radar/web run build`.

  Expected: model controls render, test/save states are covered, and the web build exits 0.

- [ ] **Step 5: Commit**

  Run `git add web/src/views/SettingsView.tsx web/src/styles/views.css web/src/views/SettingsUsageView.test.tsx && git commit -m "260822: 설정 탭 모델 역할 선택 UI 구현"`.

### Task 5: 전체 검증과 운영 문서 갱신

**Files:**
- Modify: `docs/PROJECT_CONTEXT.md`
- Modify: `docs/V1_GUIDE.md`

- [ ] **Step 1: Run the complete verification suite**

  Run `pnpm typecheck && pnpm build && pnpm --filter @radar/web exec vitest run && git diff --check`.

- [ ] **Step 2: Review the resulting diff**

  Confirm no API key, personal token, local test artifact, or untracked generated directory is added. Confirm the old environment fallback remains documented.

- [ ] **Step 3: Document operations**

  Document the two roles, the model list refresh behavior, the connection test, the unknown-pricing warning, the fallback to `MODEL_HIGH`/`MODEL_DEEP`, and the fact that changing the setting does not regenerate old analyses.

- [ ] **Step 4: Commit documentation**

  Run `git add docs/PROJECT_CONTEXT.md docs/V1_GUIDE.md && git commit -m "260822: 모델 역할 설정 운영 문서화"`.

