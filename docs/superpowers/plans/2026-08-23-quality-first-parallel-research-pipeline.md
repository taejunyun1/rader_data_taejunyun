# Quality-First Parallel Research Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Use `superpowers:test-driven-development` for every behavior change and `superpowers:verification-before-completion` before claiming completion. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 월 AI 예산 `$10` 안에서 결과 품질을 최대화하도록 심층 정리·착즙·발견·레이더를 재시도 가능한 단계형 Cloudflare Workflow DAG로 전환하고, 독립 단계는 병렬 처리하며 캐시·품질 게이트·자동 모델 승격·실제 진행률을 제공한다.

**Architecture:** `research_jobs`를 부모 작업 원장으로 유지하고, 신규 `research_job_stages`가 준비·병렬 분석·검증·통합·저장의 세부 상태를 기록한다. 각 Workflow 단계는 안정적인 이름과 입력 해시를 가지며, `Promise.all()`은 서로 의존하지 않는 `step.do()`에만 사용한다. AI 산출물은 `ai_artifact_cache`에 입력·프롬프트·모델·파라미터 해시와 함께 저장하고, 품질 점수가 기준 미만일 때만 상위 통합·반론 검증 모델로 한 번 승격한다.

**Tech Stack:** TypeScript 5.9, Hono 4, Cloudflare Workers, Cloudflare Workflows, D1, R2, Workers AI, Vectorize, AI Gateway, OpenAI API, React 19, Vite 8, Vitest 4, Testing Library, Playwright, pnpm workspaces.

## Global Constraints

- 제품 기준은 `docs/SPEC.md`가 `docs/spec-v0.1.txt`보다 우선하며, 운영 기준은 `docs/PROJECT_CONTEXT.md`를 따른다.
- Cloudflare-first, External-minimal, Serverless-first, Reservoir-first, Model-agnostic 원칙을 유지한다.
- 원본과 provenance가 AI 산출물보다 우선하며, 기존 R2 원본 보존·D1 active version 계약을 변경하지 않는다.
- 월 AI 예산은 `$10`, 80% 경고, 100% 신규 유료 AI 작업 차단을 유지한다.
- 사용자에게 자료별 모델 선택을 요구하지 않는다. 설정의 `기본 모델`과 `상위 통합·반론 검증 모델` 두 역할만 유지한다.
- 모델 ID와 가격은 `worker/wrangler.jsonc` vars 및 D1 모델 역할 설정에서 주입하며 소스에 하드코딩하지 않는다.
- 동일 입력의 활성 작업은 기존 `dedupe_key`로 재사용하고, 서로 다른 자료·작업 종류는 동시에 실행할 수 있어야 한다.
- Workflow 단계는 멱등적이어야 하며, 단계 이름은 같은 Workflow 재실행에서 변하지 않아야 한다.
- Workflow 단계 반환값은 ID·점수·짧은 메타데이터로 제한한다. 원문과 긴 JSON은 D1/R2에 저장하고 참조만 반환한다.
- 병렬 AI 호출은 작업당 최대 4개, 외부 원문 접근 확인은 작업당 최대 6개로 제한한다.
- 페이지 이동·새로고침·브라우저 재접속 후에도 작업과 단계 상태를 D1에서 복원한다.
- 일반 사용자용 취소·일시정지·Admin·멀티유저 기능은 이번 범위에 추가하지 않는다.
- 기존 발견 필터의 관련도 `0.65`, 무료 원문/PDF, 공학 전용 후보 차단, 회당 최대 8개를 유지한다.
- 기본 분석은 기존 Workers AI 계층을 유지하고, 유료 모델은 심층 정리·착즙·검증·레이더 최종 통합에만 사용한다.

## 확정 실행 흐름

```text
버튼 클릭
  → research_jobs 부모 작업 생성
  → 단계 정의와 예산·입력 해시 고정
  → 캐시 및 변경 자료 확인
  → 독립 단계 병렬 실행
  → 초안 생성
  → Critic / Counter / 근거 검증 병렬 실행
  → 품질 게이트
      통과: 최종 저장
      실패: 상위 모델로 실패 부분만 1회 교정
  → 결과 참조 저장
  → 작업센터에서 결과 열기
```

## 확정 진행률 가중치

| 작업 | 단계 | 가중치 |
|---|---|---:|
| 심층 정리 | 준비 5 + 청크 분석 40 + 통합 25 + 품질 검증 20 + 저장 10 | 100 |
| 착즙 | 맥락 준비 10 + 초안 30 + Critic/Counter 30 + 검증·교정 20 + 큐·저장 10 | 100 |
| 발견 | 방향 준비 10 + 공급자 수집 45 + 필터·중복 25 + 접근 검증 10 + 저장 10 | 100 |
| 레이더 | 기간 입력 20 + 변화·편향 집계 25 + 최종 통합 45 + 저장 10 | 100 |

`SKIPPED` 단계는 완료된 것으로 가중치에 포함한다. 조건부 교정이 생기더라도 전체 진행률은 역행하지 않는다.

---

### Task 1: Worker 테스트 기반과 공유 작업 단계 계약 고정

**Files:**

- Modify: `worker/package.json`
- Create: `worker/vitest.config.ts`
- Modify: `shared/src/discovery.ts`
- Modify: `shared/src/index.ts`
- Create: `worker/src/jobs/stageDefinitions.ts`
- Create: `worker/src/jobs/stageDefinitions.test.ts`
- Modify: `web/src/lib/researchJobs.ts`
- Create: `web/src/lib/researchJobStages.test.ts`

**Interfaces:**

- Produces: `ResearchJobStageStatus`, `ResearchJobStageLane`, `ResearchJobStage`, `ResearchJob.stages`.
- Produces: `stageDefinitionsFor(kind, input): readonly ResearchJobStageDefinition[]`.
- Consumed by: D1 store, Workflow runner, jobs API, Job Center.

- [ ] **Step 1: Worker Vitest 실행 계약을 추가한다.**

`worker/package.json`에 다음 스크립트와 개발 의존성을 추가한다.

```json
{
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "devDependencies": {
    "vitest": "^4.1.11"
  }
}
```

`worker/vitest.config.ts`는 Node 환경의 순수 함수·mock D1 테스트만 실행한다.

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
```

- [ ] **Step 2: 실패하는 단계 정의 테스트를 작성한다.**

`worker/src/jobs/stageDefinitions.test.ts`에 다음 핵심 사례를 작성한다.

```ts
import { describe, expect, it } from "vitest";
import { stageDefinitionsFor } from "./stageDefinitions";

describe("stageDefinitionsFor", () => {
  it("assigns exactly 100 weight to deep analysis", () => {
    const stages = stageDefinitionsFor("DEEP_ANALYSIS", { chunkCount: 4 });
    expect(stages.reduce((sum, stage) => sum + stage.weight, 0)).toBe(100);
    expect(stages.filter((stage) => stage.lane === "PARALLEL")).toHaveLength(7);
  });

  it("keeps correction conditional without changing total weight", () => {
    const stages = stageDefinitionsFor("DISTILL_RUN", { includeCounter: true });
    expect(stages.find((stage) => stage.key === "counter-repair")?.conditional).toBe(true);
    expect(stages.reduce((sum, stage) => sum + stage.weight, 0)).toBe(100);
  });
});
```

Run:

```bash
pnpm install
pnpm --filter @radar/worker test -- src/jobs/stageDefinitions.test.ts
```

Expected: 공유 타입과 `stageDefinitionsFor`가 없어 FAIL.

- [ ] **Step 3: 공유 단계 타입을 추가한다.**

`shared/src/discovery.ts`에 다음 계약을 추가하고 `ResearchJob`에 `stages`를 추가한다.

```ts
export type ResearchJobStageStatus =
  | "PENDING"
  | "RUNNING"
  | "SUCCEEDED"
  | "FAILED"
  | "BLOCKED"
  | "SKIPPED";

export type ResearchJobStageLane = "SEQUENTIAL" | "PARALLEL" | "VALIDATION";

export interface ResearchJobStage {
  jobId: string;
  key: string;
  label: string;
  lane: ResearchJobStageLane;
  status: ResearchJobStageStatus;
  weight: number;
  progress: number;
  message: string | null;
  model: string | null;
  costUsd: number;
  qualityScore: number | null;
  attempts: number;
  error: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  updatedAt: string;
}
```

`ResearchJob`에는 `stages: ResearchJobStage[]`를 필수로 추가한다. `shared/src/index.ts`에서 타입을 재-export한다.

- [ ] **Step 4: 작업별 단계 정의를 구현한다.**

`worker/src/jobs/stageDefinitions.ts`에 다음 인터페이스와 함수를 만든다.

```ts
import type { ResearchJobKind, ResearchJobStageLane } from "@radar/shared/discovery";

export interface ResearchJobStageDefinition {
  key: string;
  label: string;
  lane: ResearchJobStageLane;
  weight: number;
  conditional?: boolean;
}

export function stageDefinitionsFor(
  kind: ResearchJobKind,
  input: { chunkCount?: number; includeCounter?: boolean } = {},
): readonly ResearchJobStageDefinition[];
```

단계 key와 가중치는 다음처럼 고정한다.

- 심층 정리: `deep-prepare` 5, `deep-chunk-0..3` 각 10, `deep-synthesis` 25, `deep-audit-grounding` 6, `deep-audit-coverage` 4, `deep-audit-consistency` 5, `deep-repair` 5, `deep-persist` 10.
- 착즙: `distill-context` 10, `distill-draft` 30, `distill-critic` 15, `counter-draft` 15, `distill-validation` 10, `counter-repair` 10, `queue-verify` 5, `distill-persist` 5.
- 발견: `discovery-prepare` 10, `provider-openalex` 15, `provider-arxiv` 15, `provider-rss` 15, `discovery-filter` 25, `access-verify` 10, `discovery-persist` 10.
- 레이더: `radar-period-stats` 10, `radar-distill-delta` 10, `radar-history-delta` 10, `radar-bias-analysis` 15, `radar-synthesis` 45, `radar-persist` 10.

착즙에서 Counter가 꺼진 경우 `counter-draft`와 `counter-repair`는 `SKIPPED` 처리하고, `distill-validation`은 Critic 해소 여부와 출처 추적만 검사한다. 모든 작업의 정의 가중치 합은 정확히 100이어야 한다.

- [ ] **Step 5: 프런트 정규화 테스트와 구현을 갱신한다.**

`web/src/lib/researchJobStages.test.ts`에서 stages가 없던 구형 응답은 `[]`로, 유효한 stages는 그대로 정규화되는지 검증한다. `normalizeResearchJob()`에 다음 규칙을 추가한다.

```ts
stages: Array.isArray(raw.stages)
  ? raw.stages.map(normalizeResearchJobStage).filter(Boolean)
  : [],
```

Run:

```bash
pnpm --filter @radar/worker test -- src/jobs/stageDefinitions.test.ts
pnpm --filter @radar/web exec vitest run src/lib/researchJobStages.test.ts
pnpm typecheck
```

Expected: 모두 PASS.

- [ ] **Step 6: 커밋한다.**

```bash
git add worker/package.json worker/vitest.config.ts shared/src/discovery.ts shared/src/index.ts worker/src/jobs/stageDefinitions.ts worker/src/jobs/stageDefinitions.test.ts web/src/lib/researchJobs.ts web/src/lib/researchJobStages.test.ts pnpm-lock.yaml
git commit -m "260823: 병렬 연구 작업 단계 계약과 테스트 기반 추가"
```

---

### Task 2: D1 단계 원장·AI 산출물 캐시·정확한 토큰 원장 추가

**Files:**

- Create: `worker/migrations/0014_parallel_quality_pipeline.sql`
- Create: `worker/src/jobs/stages.ts`
- Create: `worker/src/jobs/stages.test.ts`
- Create: `worker/src/jobs/artifactCache.ts`
- Create: `worker/src/jobs/artifactCache.test.ts`
- Modify: `worker/src/jobs/store.ts`

**Interfaces:**

- Produces: `ensureJobStages`, `markStageRunning`, `updateStageProgress`, `completeStage`, `failStage`, `skipStage`, `listJobStages`, `recomputeJobProgress`.
- Produces: `buildArtifactCacheKey`, `readArtifactCache`, `writeArtifactCache`.
- Consumed by: 공통 Workflow stage runner와 각 기능 flow.

- [ ] **Step 1: migration을 작성한다.**

`worker/migrations/0014_parallel_quality_pipeline.sql`에 다음 스키마를 작성한다.

```sql
CREATE TABLE IF NOT EXISTS research_job_stages (
  job_id TEXT NOT NULL REFERENCES research_jobs(id) ON DELETE CASCADE,
  stage_key TEXT NOT NULL,
  label TEXT NOT NULL,
  lane TEXT NOT NULL CHECK (lane IN ('SEQUENTIAL','PARALLEL','VALIDATION')),
  status TEXT NOT NULL CHECK (status IN ('PENDING','RUNNING','SUCCEEDED','FAILED','BLOCKED','SKIPPED')),
  weight INTEGER NOT NULL CHECK (weight BETWEEN 0 AND 100),
  progress INTEGER NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
  message TEXT,
  input_hash TEXT,
  output_ref_json TEXT,
  model TEXT,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  cached_input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0,
  quality_score REAL,
  attempts INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  started_at TEXT,
  finished_at TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (job_id, stage_key)
);

CREATE INDEX IF NOT EXISTS idx_research_job_stages_job_status
  ON research_job_stages(job_id, status, updated_at);

CREATE TABLE IF NOT EXISTS ai_artifact_cache (
  cache_key TEXT PRIMARY KEY,
  artifact_kind TEXT NOT NULL,
  source_id TEXT REFERENCES sources(id),
  source_version_id TEXT REFERENCES source_versions(id),
  stage_key TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  params_hash TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  model_role TEXT NOT NULL,
  model TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  cached_input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0,
  quality_score REAL,
  hit_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  last_used_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ai_artifact_source_stage
  ON ai_artifact_cache(source_id, source_version_id, stage_key, last_used_at DESC);

ALTER TABLE ai_usage ADD COLUMN cached_input_tokens INTEGER NOT NULL DEFAULT 0;
```

- [ ] **Step 2: 로컬 migration을 적용하고 스키마를 확인한다.**

Run:

```bash
pnpm --filter @radar/worker exec wrangler d1 migrations apply research-radar-db --local
pnpm --filter @radar/worker exec wrangler d1 execute research-radar-db --local --command "PRAGMA table_info(research_job_stages);"
pnpm --filter @radar/worker exec wrangler d1 execute research-radar-db --local --command "PRAGMA table_info(ai_artifact_cache);"
```

Expected: migration 성공, 두 테이블과 `ai_usage.cached_input_tokens`가 표시됨.

- [ ] **Step 3: 진행률 계산의 실패 테스트를 작성한다.**

`worker/src/jobs/stages.test.ts`에서 다음을 검증한다.

```ts
it("computes weighted progress without moving backwards", () => {
  expect(weightedJobProgress([
    { weight: 10, progress: 100, status: "SUCCEEDED" },
    { weight: 40, progress: 50, status: "RUNNING" },
    { weight: 50, progress: 0, status: "PENDING" },
  ], 28)).toBe(30);
});

it("counts skipped conditional stages as complete", () => {
  expect(weightedJobProgress([
    { weight: 20, progress: 100, status: "SKIPPED" },
    { weight: 80, progress: 100, status: "SUCCEEDED" },
  ], 0)).toBe(100);
});
```

Expected: `weightedJobProgress`가 없어 FAIL.

- [ ] **Step 4: 단계 저장소를 구현한다.**

`worker/src/jobs/stages.ts`는 모든 update를 `job_id + stage_key`로 제한하고 다음 규칙을 지킨다.

- `ensureJobStages`: `INSERT ... ON CONFLICT DO NOTHING`으로 멱등 생성.
- `markStageRunning`: attempts를 1 증가시키고 기존 성공 단계를 RUNNING으로 되돌리지 않음.
- `completeStage`: 상태·토큰·비용·품질 점수·output ref를 한 번에 기록.
- `failStage`: 오류를 500자로 자르고 부모 작업은 Workflow 최상위 catch가 결정.
- `skipStage`: progress 100으로 기록.
- `recomputeJobProgress`: 가중 평균을 계산하고 기존 부모 progress보다 낮게 쓰지 않음.

- [ ] **Step 5: 산출물 캐시 키 테스트와 구현을 작성한다.**

`worker/src/jobs/artifactCache.test.ts`에서 property 순서가 달라도 같은 키가 생성되고, 모델·프롬프트·source version 중 하나라도 바뀌면 다른 키가 생성되는지 검증한다.

```ts
const key = await buildArtifactCacheKey({
  stageKey: "deep-chunk-0",
  sourceVersionId: "v1",
  inputHash: "body-hash",
  params: { profile: "maximum", index: 0 },
  promptVersion: "deep-chunk-v2",
  modelRole: "base",
  model: "configured-model-id",
});
expect(key).toMatch(/^[a-f0-9]{64}$/);
```

캐시는 exact match만 허용하며, hit 시 `hit_count + 1`, `last_used_at` 갱신을 수행한다. JSON parse 실패 행은 miss로 취급하고 새 결과로 덮어쓴다.

- [ ] **Step 6: 부모 작업 조회에 stages를 결합한다.**

`worker/src/jobs/store.ts`의 단건·목록 조회 후 `listJobStages()`를 호출한다. 최근 작업 30개 조회에서 N+1을 피하도록 `WHERE job_id IN (...)` 한 번으로 읽고 job별로 그룹화한다.

Run:

```bash
pnpm --filter @radar/worker test -- src/jobs/stages.test.ts src/jobs/artifactCache.test.ts
pnpm typecheck
```

Expected: 모두 PASS.

- [ ] **Step 7: 커밋한다.**

```bash
git add worker/migrations/0014_parallel_quality_pipeline.sql worker/src/jobs/stages.ts worker/src/jobs/stages.test.ts worker/src/jobs/artifactCache.ts worker/src/jobs/artifactCache.test.ts worker/src/jobs/store.ts
git commit -m "260823: 작업 단계 원장과 AI 산출물 캐시 추가"
```

---

### Task 3: 정확한 비용 집계와 품질 우선 자동 모델 승격 정책 구현

**Files:**

- Modify: `worker/src/lib/openai.ts`
- Modify: `worker/src/lib/modelSettings.ts`
- Create: `worker/src/lib/modelPolicy.ts`
- Create: `worker/src/lib/modelPolicy.test.ts`
- Modify: `worker/wrangler.jsonc`
- Modify: `worker/src/routes/usage.ts`
- Modify: `web/src/views/UsageView.tsx`
- Modify: `web/src/views/SettingsUsageView.test.tsx`

**Interfaces:**

- Produces: `ModelStage`, `QualityGateInput`, `chooseModelRole`, `shouldPromoteForRepair`.
- Extends: `OpenAiCallResult.cachedInputTokens` and cache-aware cost calculation.
- Consumed by: 심층 정리·착즙·레이더 flow.

- [ ] **Step 1: 모델 승격 정책의 실패 테스트를 작성한다.**

`worker/src/lib/modelPolicy.test.ts`에 다음을 고정한다.

```ts
it("uses review model for final integration", () => {
  expect(chooseModelRole({ stage: "FINAL_SYNTHESIS", markedImportant: false, budgetPct: 30 })).toBe("deep");
});

it("promotes only failed or important repair paths", () => {
  expect(shouldPromoteForRepair({ qualityScore: 0.79, fatalIssues: [], markedImportant: false })).toBe(true);
  expect(shouldPromoteForRepair({ qualityScore: 0.92, fatalIssues: [], markedImportant: false })).toBe(false);
  expect(shouldPromoteForRepair({ qualityScore: 0.92, fatalIssues: [], markedImportant: true })).toBe(true);
});

it("stops background maintenance before interactive quality work", () => {
  expect(chooseModelRole({ stage: "BACKGROUND_ENRICHMENT", markedImportant: false, budgetPct: 91 })).toBe("blocked");
  expect(chooseModelRole({ stage: "FINAL_SYNTHESIS", markedImportant: true, budgetPct: 91 })).toBe("deep");
});
```

- [ ] **Step 2: 품질 우선 예산 정책을 구현한다.**

`worker/src/lib/modelPolicy.ts`의 규칙은 다음과 같다.

- 0–79%: 기본 분석은 `base`, 최종 통합과 실패 교정은 `deep`.
- 80–89%: 경고 표시만 하고 사용자 실행 품질은 유지, 자동 야간 Batch만 중단.
- 90–99%: 발견 자동 enrichment 중단, 캐시 miss인 일반 재분석 차단, 사용자가 마크한 자료의 최종 통합·교정은 허용.
- 100% 이상: 기존 정책대로 신규 유료 호출 차단.
- 품질 기준은 `0.80`; fatal issue가 하나라도 있으면 점수와 무관하게 교정.
- 자동 교정은 단계당 최대 1회.

- [ ] **Step 3: OpenAI 사용량에서 캐시 입력 토큰을 분리한다.**

`worker/src/lib/openai.ts`의 응답 타입에 다음을 추가한다.

```ts
usage?: {
  prompt_tokens: number;
  completion_tokens: number;
  prompt_tokens_details?: { cached_tokens?: number };
};
```

비용은 `uncachedInputTokens * input price + cachedInputTokens * cachedInput price + outputTokens * output price`로 계산한다. `cachedInput` 가격이 config에 없으면 input 가격을 사용하여 과소 집계하지 않는다. `ai_usage.cached_input_tokens`에 실제 값을 기록한다.

`worker/src/lib/modelSettings.ts`의 가격 타입은 다음을 수용한다.

```ts
interface ModelPrice {
  input: number;
  cachedInput?: number;
  output: number;
}
```

`worker/wrangler.jsonc`의 `MODEL_PRICING_JSON`에는 현재 노출된 대표 모델의 `cachedInput`을 명시한다. 배포 전에 OpenAI 공식 가격표와 대조한다.

- [ ] **Step 4: 사용량 API와 UI에 품질 대비 비용을 추가한다.**

`/api/usage/summary`에 다음 값을 추가한다.

```ts
{
  cachedInputTokens: number;
  cacheHitPct: number;
  completedQualityJobs: number;
  averageQualityScore: number | null;
  usefulActionCostUsd: number | null;
}
```

`usefulActionCostUsd`는 해당 월의 AI 비용을 `keep + develop + select` 신호 수로 나눈 값이며 신호가 0이면 null이다. Usage UI는 비용 다음에 `캐시 적중률`, `평균 품질`, `유효 판단 1건당 비용`을 작은 지표로 표시한다.

Run:

```bash
pnpm --filter @radar/worker test -- src/lib/modelPolicy.test.ts
pnpm --filter @radar/web exec vitest run src/views/SettingsUsageView.test.tsx
pnpm typecheck
```

Expected: 모두 PASS.

- [ ] **Step 5: 커밋한다.**

```bash
git add worker/src/lib/openai.ts worker/src/lib/modelSettings.ts worker/src/lib/modelPolicy.ts worker/src/lib/modelPolicy.test.ts worker/wrangler.jsonc worker/src/routes/usage.ts web/src/views/UsageView.tsx web/src/views/SettingsUsageView.test.tsx
git commit -m "260823: 캐시 비용 집계와 품질 우선 모델 승격 정책 추가"
```

---

### Task 4: 공통 추적 Workflow stage runner와 작업별 flow 경계 도입

**Files:**

- Create: `worker/src/workflows/runTrackedStage.ts`
- Create: `worker/src/workflows/runTrackedStage.test.ts`
- Create: `worker/src/workflows/types.ts`
- Modify: `worker/src/workflows/researchJob.ts`
- Modify: `worker/src/jobs/enqueue.ts`

**Interfaces:**

- Produces: `runTrackedStage<T>()`, `runParallelStages<T>()`, `StageExecutionResult<T>`.
- Consumes: Task 2 stage store와 Task 3 모델 정책.
- Consumed by: 네 기능 flow 모듈.

- [ ] **Step 1: wrapper의 실패 테스트를 작성한다.**

mock `WorkflowStep`, stage store adapter, callback을 사용해 다음을 검증한다.

- callback 성공 시 RUNNING → SUCCEEDED 순서로 기록.
- callback 실패 시 FAILED 기록 후 원래 오류 rethrow.
- 같은 stage 성공 결과가 재생될 때 callback side effect가 중복되지 않음.
- 병렬 helper가 동시 실행 수 4를 넘지 않음.

- [ ] **Step 2: 공통 타입과 runner를 구현한다.**

`worker/src/workflows/types.ts`:

```ts
export interface StageExecutionMeta {
  outputRef?: Record<string, unknown>;
  model?: string;
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
  qualityScore?: number;
}

export interface StageExecutionResult<T> {
  value: T;
  meta?: StageExecutionMeta;
}
```

`runTrackedStage()`는 `markStageRunning()` 후 `step.do()` 내부에서 callback과 `completeStage()`를 함께 실행한다. retry config 기본값은 AI 단계 `limit 2 / exponential 5 seconds / timeout 15 minutes`, D1-only 단계 `limit 3 / exponential 1 second / timeout 2 minutes`다.

`runParallelStages()`는 최대 4개 promise만 동시에 활성화하는 `mapConcurrent()`를 사용하고, 각 promise는 반드시 `runTrackedStage()`를 호출한다.

- [ ] **Step 3: ResearchJobWorkflow를 kind별 flow 위임 구조로 바꾼다.**

`researchJob.ts`는 다음 역할만 가진다.

1. 부모 작업 조회.
2. 단계 정의 멱등 생성.
3. 부모 RUNNING 전환.
4. kind별 flow 호출.
5. 부모 complete/block/fail.

기존 `private execute()` 안의 기능별 구현은 Task 5–7에서 flow 파일로 이동한다. 이 Task에서는 기존 함수를 호출하는 얇은 adapter를 먼저 만들어 동작을 보존한다.

- [ ] **Step 4: 활성 중복 작업 재사용 경쟁 조건을 보강한다.**

`enqueueResearchJob()`에서 unique index 충돌이 발생하면 실패 처리하지 않고 동일 dedupe key의 활성 작업을 다시 조회해 반환한다. 다른 sourceId 또는 다른 kind는 별도 Workflow instance를 생성한다.

Run:

```bash
pnpm --filter @radar/worker test -- src/workflows/runTrackedStage.test.ts
pnpm typecheck
```

Expected: 모두 PASS, 기능별 API 계약 변화 없음.

- [ ] **Step 5: 커밋한다.**

```bash
git add worker/src/workflows/runTrackedStage.ts worker/src/workflows/runTrackedStage.test.ts worker/src/workflows/types.ts worker/src/workflows/researchJob.ts worker/src/jobs/enqueue.ts
git commit -m "260823: 재시도 가능한 공통 Workflow 단계 실행기 추가"
```

---

### Task 5: 심층 정리를 4청크 병렬 분석과 품질 게이트 DAG로 전환

**Files:**

- Create: `worker/src/analysis/deepStages.ts`
- Create: `worker/src/analysis/deepQuality.ts`
- Create: `worker/src/analysis/deepQuality.test.ts`
- Create: `worker/src/workflows/deepAnalysisFlow.ts`
- Modify: `worker/src/analysis/deepAnalyze.ts`
- Modify: `worker/src/analysis/deepPrompt.ts`
- Modify: `worker/src/workflows/researchJob.ts`
- Modify: `web/src/lib/deepAnalysis.test.ts`
- Modify: `web/src/views/ReservoirView.test.tsx`

**Interfaces:**

- Produces: `prepareDeepAnalysis`, `analyzeDeepChunk`, `synthesizeDeepAnalysis`, `auditDeepAnalysis`, `repairDeepAnalysis`, `persistDeepAnalysis`.
- Produces: `scoreDeepQuality()` and `DeepQualityAudit`.
- Result contract remains `{ analysisId, payload, model, costUsd }`.

- [ ] **Step 1: 품질 점수의 실패 테스트를 작성한다.**

`worker/src/analysis/deepQuality.test.ts`에 다음 규칙을 고정한다.

```ts
it("weights grounding, coverage, and consistency", () => {
  expect(scoreDeepQuality({ grounding: 1, coverage: 0.75, consistency: 0.8, fatalIssues: [] })).toBe(0.88);
});

it("forces repair when a quote cannot be traced", () => {
  expect(needsDeepRepair({ score: 0.91, fatalIssues: ["untraceable_quote"] }, false)).toBe(true);
});
```

점수는 `grounding 0.45 + coverage 0.30 + consistency 0.25`, 소수 둘째 자리 반올림이다.

- [ ] **Step 2: 기존 monolith를 순수 단계 함수로 분리한다.**

`deepStages.ts`의 계약을 다음처럼 고정한다.

```ts
export async function prepareDeepAnalysis(env: Env, sourceId: string, profile: unknown): Promise<PreparedDeepAnalysis>;
export async function analyzeDeepChunk(env: Env, prepared: PreparedDeepAnalysis, index: number): Promise<DeepChunkArtifact>;
export async function synthesizeDeepAnalysis(env: Env, prepared: PreparedDeepAnalysis, chunks: DeepChunkArtifact[]): Promise<DeepSynthesisArtifact>;
export async function auditDeepAnalysis(env: Env, prepared: PreparedDeepAnalysis, synthesis: DeepSynthesisArtifact, chunks: DeepChunkArtifact[]): Promise<DeepQualityAudit>;
export async function repairDeepAnalysis(env: Env, prepared: PreparedDeepAnalysis, synthesis: DeepSynthesisArtifact, audit: DeepQualityAudit): Promise<DeepSynthesisArtifact>;
export async function persistDeepAnalysis(env: Env, prepared: PreparedDeepAnalysis, final: DeepSynthesisArtifact, audit: DeepQualityAudit): Promise<DeepAnalysisResult>;
```

준비 단계는 active version ID, 원문 해시, 최대 4개 청크의 문자 범위를 고정한다. 청크 결과에는 원문 전체가 아니라 요약·질문·인용 후보와 char range만 둔다.

- [ ] **Step 3: 청크 캐시를 적용한다.**

각 청크 cache key는 `sourceVersionId + chunk text hash + chunk index + profile + deep-chunk prompt version + resolved base model`로 만든다. cache hit이면 유료 호출 없이 artifact를 반환하고 stage meta의 비용은 0, qualityScore는 저장값을 사용한다.

- [ ] **Step 4: Workflow DAG를 작성한다.**

`deepAnalysisFlow.ts`는 다음 순서를 지킨다.

1. `deep-prepare` 순차 실행.
2. `deep-chunk-0..3`을 `runParallelStages(..., concurrency=4)`로 실행.
3. `deep-synthesis`를 상위 통합 모델로 실행.
4. 다음 검증을 병렬 실행:
   - `deep-audit-grounding`: 인용문이 normalized text에 존재하는지 결정론적으로 검사.
   - `deep-audit-coverage`: 모든 유효 chunk가 최종 섹션에 반영됐는지 ID 기준 검사.
   - `deep-audit-consistency`: 기본 모델이 서로 충돌하는 주장과 과도한 일반화를 JSON으로 반환.
5. 품질 점수 `< 0.80`, fatal issue 존재, 또는 `다음 리서치` 마크 자료이면 `deep-repair`를 상위 모델로 한 번 실행.
6. 교정 불필요 시 `deep-repair`를 SKIPPED 처리.
7. `deep-persist`에서 기존 `source_analysis.analysis_type='deep'` 계약으로 저장.

- [ ] **Step 5: 기존 public 함수는 호환 adapter로 유지한다.**

`analyzeDeepSource()`는 직접 호출 테스트를 위해 순차 adapter로 남기되 실제 Workflow 경로는 `runDeepAnalysisFlow()`를 사용한다. 두 경로가 동일한 최종 payload validator와 persist 함수를 공유하도록 한다.

- [ ] **Step 6: 화면 계약 회귀 테스트를 갱신한다.**

Reservoir 테스트에서 작업 응답 직후 페이지를 이동해도 작업이 유지되고, 단계 응답이 들어오면 `청크 분석 2/4`, `품질 검증 중` 메시지가 표시되는 기반 데이터를 추가한다.

Run:

```bash
pnpm --filter @radar/worker test -- src/analysis/deepQuality.test.ts
pnpm --filter @radar/web exec vitest run src/lib/deepAnalysis.test.ts src/views/ReservoirView.test.tsx
pnpm typecheck
```

Expected: 모두 PASS.

- [ ] **Step 7: 커밋한다.**

```bash
git add worker/src/analysis/deepStages.ts worker/src/analysis/deepQuality.ts worker/src/analysis/deepQuality.test.ts worker/src/workflows/deepAnalysisFlow.ts worker/src/analysis/deepAnalyze.ts worker/src/analysis/deepPrompt.ts worker/src/workflows/researchJob.ts web/src/lib/deepAnalysis.test.ts web/src/views/ReservoirView.test.tsx
git commit -m "260823: 심층 정리 병렬 청크와 품질 교정 DAG 구현"
```

---

### Task 6: 착즙을 증분 맥락·Critic/Counter 병렬 검증 DAG로 전환

**Files:**

- Create: `worker/src/distill/stages.ts`
- Create: `worker/src/distill/quality.ts`
- Create: `worker/src/distill/quality.test.ts`
- Create: `worker/src/workflows/distillFlow.ts`
- Modify: `worker/src/distill/context.ts`
- Modify: `worker/src/distill/run.ts`
- Modify: `worker/src/distill/prompts.ts`
- Modify: `worker/src/workflows/researchJob.ts`
- Modify: `web/src/views/DistillView.test.tsx`

**Interfaces:**

- Produces: `buildIncrementalDistillContext`, `createDistillDraft`, `createCritic`, `createCounterDraft`, `validateDistill`, `repairCounter`, `persistDistillSession`.
- Keeps: 기존 `DistillRunResult`, `distill_sessions`, reading queue, research gap 계약.

- [ ] **Step 1: 증분 맥락 선택 테스트를 작성한다.**

다음 자료만 새 착즙 원문 맥락에 들어가도록 고정한다.

- 직전 착즙 이후 active version이 변경된 자료.
- 직전 착즙 이후 새로 들어온 자료.
- `keep`, `develop`, `select`로 다음 리서치 표시된 자료.
- semantic resurfacing 상위 자료 중 직전 session에 없던 자료.
- 직전 착즙 결과는 원문 전체가 아니라 키워드·질문·방향의 compact summary만 포함.

동일 source version과 동일 파라미터의 자료는 재전송하지 않고 이전 artifact를 참조한다. 최종 입력 제한 `26,000 chars`는 유지한다.

- [ ] **Step 2: 착즙 품질 점수 테스트를 작성한다.**

`distill/quality.test.ts`에 다음을 검증한다.

- schema completeness 0.20.
- source traceability 0.30.
- critic resolution 0.20.
- Counter 포함 시 direct opposition·non-strawman·grounding 0.30.
- Counter 미포함 시 마지막 0.30은 앞 세 항목 비율로 재분배.
- 검증된 Counter가 아니면 최종 제안으로 확정되지 않음.

- [ ] **Step 3: 단계 함수를 분리한다.**

Counter 초안은 Critic 결과를 입력으로 요구하지 않도록 바꾼다. 대신 동일한 distill draft와 source evidence를 사용한다. Critic warning은 병렬 완료 후 `distill-validation`에서 Counter 검증 입력에 합친다.

- [ ] **Step 4: 착즙 Workflow DAG를 구현한다.**

1. `distill-context`: 증분 맥락과 session seed ID 생성.
2. `distill-draft`: 기본 모델로 초안 생성, exact cache 적용.
3. `distill-critic`과 `counter-draft` 병렬 실행. Counter 토글이 꺼졌으면 Counter 관련 단계 SKIPPED.
4. `distill-validation`: deterministic schema 검사 후 상위 모델로 정합성 JSON 생성.
5. 품질 기준 미달이면 `counter-repair` 한 번 실행하고 재검증. 통과 시 SKIPPED.
6. `queue-verify` 한 단계 안에서 reading queue OpenAlex 검증을 최대 4개씩 병렬 실행한다. queue item별 결과는 reading queue 행에 저장하고 Workflow 단계 반환값에는 성공·실패 개수만 둔다.
7. `distill-persist`: session, queue, gaps를 한 D1 batch로 저장.

- [ ] **Step 5: 재착즙 캐시 무효화 규칙을 적용한다.**

사용자가 `keepElements`를 변경하면 final draft cache는 miss가 되어야 하지만, source context와 개별 source artifact는 재사용한다. `includeCounter` 변경은 Counter 단계에만 영향을 주고 distill draft cache를 무효화하지 않는다.

- [ ] **Step 6: UI 회귀 테스트를 실행한다.**

`DistillView.test.tsx`에 다음을 추가한다.

- Counter OFF 작업의 단계 목록에서 Counter 단계가 `SKIPPED`여도 전체 100% 완료.
- 착즙 실행 후 다른 view로 이동해도 jobs polling이 유지.
- 완료 결과 클릭 시 해당 session을 연다.

Run:

```bash
pnpm --filter @radar/worker test -- src/distill/quality.test.ts
pnpm --filter @radar/web exec vitest run src/views/DistillView.test.tsx
pnpm typecheck
```

Expected: 모두 PASS.

- [ ] **Step 7: 커밋한다.**

```bash
git add worker/src/distill/stages.ts worker/src/distill/quality.ts worker/src/distill/quality.test.ts worker/src/workflows/distillFlow.ts worker/src/distill/context.ts worker/src/distill/run.ts worker/src/distill/prompts.ts worker/src/workflows/researchJob.ts web/src/views/DistillView.test.tsx
git commit -m "260823: 증분 착즙과 Critic Counter 병렬 검증 구현"
```

---

### Task 7: 발견 공급자 수집과 레이더 입력 집계를 병렬화

**Files:**

- Create: `worker/src/discovery/providers.ts`
- Create: `worker/src/discovery/providers.test.ts`
- Create: `worker/src/workflows/discoveryFlow.ts`
- Modify: `worker/src/discovery/run.ts`
- Create: `worker/src/radar/context.ts`
- Create: `worker/src/radar/context.test.ts`
- Create: `worker/src/workflows/radarFlow.ts`
- Modify: `worker/src/radar/run.ts`
- Modify: `worker/src/radar/synthesize.ts`
- Modify: `worker/src/workflows/researchJob.ts`

**Interfaces:**

- Produces: `collectDiscoveryProviderBatch`, `mergeDiscoveryCandidates`, `buildRadarSynthesisContext`.
- Maintains: 발견 최대 8개·lane quota·접근 상태·기존 radar snapshot JSON 계약.

- [ ] **Step 1: 공급자 병합 테스트를 작성한다.**

`providers.test.ts`에서 OpenAlex·arXiv·RSS 결과가 순서와 무관하게 동일한 dedupe 결과를 만들고, 동일 제목은 접근성이 높은 `FREE_FULLTEXT > PDF > INSTITUTION > UNKNOWN` 순으로 남는지 검증한다.

- [ ] **Step 2: 발견 수집을 공급자 adapter로 분리한다.**

`providers.ts`는 다음 세 adapter를 제공한다.

```ts
collectOpenAlex(descriptors, limits): Promise<PendingCandidate[]>;
collectArxiv(descriptors, limits): Promise<PendingCandidate[]>;
collectFeeds(feedUrls): Promise<PendingCandidate[]>;
```

각 adapter 내부 query fan-out은 최대 4개로 제한한다. 공급자 한 곳의 실패는 해당 branch 결과를 빈 배열과 warning으로 반환하며 전체 발견 작업을 실패시키지 않는다. 모든 공급자가 실패했을 때만 job을 FAILED 처리한다.

- [ ] **Step 3: 발견 Workflow flow를 구현한다.**

1. 방향·query descriptor 준비.
2. OpenAlex·arXiv·RSS branch를 병렬 실행.
3. 결과 join 후 기존 필터·lane quota·dedupe 적용.
4. 최종 8개에 대해서만 접근 상태 검증.
5. D1 batch 저장.

기존 `runDiscovery()`는 cron 호환 adapter로 유지하고, 버튼 경로는 `runDiscoveryFlow()`를 사용한다.

- [ ] **Step 4: Radar 중복 집계를 제거하는 실패 테스트를 작성한다.**

현재 `synthesizeRadar()`와 `runRadarSynthesis()`가 `computeStats()`를 중복 호출하는 경로를 하나로 줄인다. `buildRadarSynthesisContext()`가 stats, 최근 distill compact outputs, all-time keyword bias를 한 번씩만 읽는지 mock call count로 검증한다.

- [ ] **Step 5: Radar 입력을 병렬 집계한다.**

`radar/context.ts`에서 다음을 `Promise.all()`로 읽는다.

- 기간 stats.
- 최근 착즙 3개 compact output.
- 전체 키워드 상위 20개.
- 직전 같은 기간 radar narrative와 bias watch.

최종 모델 입력에는 전체 이전 서사가 아니라 `새로 생긴 것`, `약해진 것`, `충돌한 것`의 delta를 포함한다. `synthesizeRadar()`는 완성된 context를 받아 모델 호출만 수행하고, `runRadarSynthesis()`는 동일 stats로 snapshot을 저장한다.

Run:

```bash
pnpm --filter @radar/worker test -- src/discovery/providers.test.ts src/radar/context.test.ts
pnpm typecheck
```

Expected: 모두 PASS.

- [ ] **Step 6: 커밋한다.**

```bash
git add worker/src/discovery/providers.ts worker/src/discovery/providers.test.ts worker/src/workflows/discoveryFlow.ts worker/src/discovery/run.ts worker/src/radar/context.ts worker/src/radar/context.test.ts worker/src/workflows/radarFlow.ts worker/src/radar/run.ts worker/src/radar/synthesize.ts worker/src/workflows/researchJob.ts
git commit -m "260823: 발견 공급자와 레이더 집계를 병렬 처리"
```

---

### Task 8: 다중 작업센터와 실제 단계 진행률 UX 구현

**Files:**

- Modify: `worker/src/routes/jobs.ts`
- Modify: `web/src/lib/researchJobs.ts`
- Modify: `web/src/components/layout/JobCenter.tsx`
- Modify: `web/src/components/layout/JobCenter.test.tsx`
- Modify: `web/src/components/layout/SidebarNav.tsx`
- Modify: `web/src/components/layout/AppShell.tsx`
- Modify: `web/src/components/layout/AppShell.test.tsx`
- Modify: `web/src/styles/shell.css`

**Interfaces:**

- Jobs API returns parent job with ordered `stages`.
- UI derives `activeCount`, current stage, parallel lane summary from persisted data only.

- [ ] **Step 1: Job Center 실패 테스트를 작성한다.**

다음을 Testing Library로 검증한다.

- 활성 작업 3개면 `3개 작업 진행 중` 표시.
- 심층 정리 4청크 중 2개 완료면 `청크 분석 2/4` 표시.
- 착즙 Critic·Counter 동시 RUNNING이면 `Critic · Counter 병렬 검증 중` 표시.
- 첫 작업을 펼쳐도 다른 작업이 사라지지 않음.
- 완료 작업은 `결과 보기`, 실패 작업은 `다시 실행` 유지.
- `aria-live="polite"` 영역에서 작업 시작·완료 메시지를 전달.

- [ ] **Step 2: jobs API stage ordering을 고정한다.**

`GET /api/jobs`와 `GET /api/jobs/:id`는 stage definition 순서로 stages를 반환한다. API가 stage row를 찾지 못하는 구형 완료 작업은 `stages: []`로 반환한다.

- [ ] **Step 3: Job Center를 compact summary + expandable detail로 변경한다.**

상단 기본 상태는 한 줄이다.

```text
● 3개 작업 진행 중 · 심층 정리 55% · 착즙 42% · 발견 대기
```

펼친 상태는 작업별 progress bar, 현재 단계, 병렬 branch 완료 수를 표시한다. 최근 완료·실패는 기존처럼 최대 5개까지 보이되 활성 작업은 모두 노출한다.

- [ ] **Step 4: Sidebar를 다중 작업 요약으로 변경한다.**

Sidebar에는 최대 3개의 활성 작업과 `외 2개`를 표시한다. 각 항목 클릭은 해당 view로만 이동하며 Workflow를 재시작하거나 polling state를 초기화하지 않는다.

- [ ] **Step 5: polling과 네트워크 복구 규칙을 유지한다.**

- 활성 작업이 있으면 2초 polling.
- 탭이 hidden이면 8초로 완화.
- visible 복귀 시 즉시 refresh.
- 네트워크 오류는 마지막 상태를 유지하고 다음 polling에서 복구.
- component unmount와 무관하게 `useResearchJobs()`는 App root에 한 번만 존재.

Run:

```bash
pnpm --filter @radar/web exec vitest run src/components/layout/JobCenter.test.tsx src/components/layout/AppShell.test.tsx
pnpm --filter @radar/web run build
```

Expected: 모두 PASS, build 성공.

- [ ] **Step 6: 커밋한다.**

```bash
git add worker/src/routes/jobs.ts web/src/lib/researchJobs.ts web/src/components/layout/JobCenter.tsx web/src/components/layout/JobCenter.test.tsx web/src/components/layout/SidebarNav.tsx web/src/components/layout/AppShell.tsx web/src/components/layout/AppShell.test.tsx web/src/styles/shell.css
git commit -m "260823: 다중 작업센터와 실제 단계 진행률 표시"
```

---

### Task 9: GPT-5.6 Luna 비교 평가와 비실시간 Batch 절감 계층 추가

**Files:**

- Create: `worker/migrations/0015_model_evaluations_batches.sql`
- Create: `worker/src/lib/modelEvaluation.ts`
- Create: `worker/src/lib/modelEvaluation.test.ts`
- Create: `worker/src/lib/openaiBatch.ts`
- Create: `worker/src/workflows/maintenanceWorkflow.ts`
- Modify: `worker/src/index.ts`
- Modify: `worker/wrangler.jsonc`
- Modify: `worker/src/routes/settings.ts`
- Modify: `web/src/views/SettingsView.tsx`
- Modify: `web/src/views/SettingsUsageView.test.tsx`

**Interfaces:**

- Adds a separate `MaintenanceWorkflow` binding so model evaluation and 24-hour Batch polling do not expand the interactive `ResearchJobKind` contract.
- Produces: `evaluateModelPair`, `createBatch`, `pollBatch`, `applyBatchResults`.

- [ ] **Step 1: 평가·Batch 상태 스키마를 추가한다.**

`0015_model_evaluations_batches.sql`에 다음을 작성한다.

```sql
CREATE TABLE IF NOT EXISTS model_evaluation_runs (
  id TEXT PRIMARY KEY,
  workflow_instance_id TEXT UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('QUEUED','RUNNING','SUCCEEDED','FAILED')),
  baseline_model TEXT NOT NULL,
  candidate_model TEXT NOT NULL,
  sample_count INTEGER NOT NULL DEFAULT 0,
  baseline_quality REAL,
  candidate_quality REAL,
  baseline_cost_usd REAL NOT NULL DEFAULT 0,
  candidate_cost_usd REAL NOT NULL DEFAULT 0,
  recommendation TEXT CHECK (recommendation IN ('KEEP_BASELINE','CANDIDATE_ELIGIBLE') OR recommendation IS NULL),
  error TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS model_evaluation_items (
  run_id TEXT NOT NULL REFERENCES model_evaluation_runs(id) ON DELETE CASCADE,
  source_id TEXT NOT NULL REFERENCES sources(id),
  source_version_id TEXT NOT NULL REFERENCES source_versions(id),
  source_group TEXT NOT NULL CHECK (source_group IN ('ACADEMIC','WEB','NOTE','LONG_PDF')),
  baseline_artifact_key TEXT NOT NULL REFERENCES ai_artifact_cache(cache_key),
  candidate_artifact_key TEXT NOT NULL REFERENCES ai_artifact_cache(cache_key),
  baseline_scores_json TEXT NOT NULL,
  candidate_scores_json TEXT NOT NULL,
  baseline_latency_ms INTEGER NOT NULL,
  candidate_latency_ms INTEGER NOT NULL,
  baseline_cost_usd REAL NOT NULL,
  candidate_cost_usd REAL NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (run_id, source_id)
);

CREATE TABLE IF NOT EXISTS maintenance_batches (
  id TEXT PRIMARY KEY,
  workflow_instance_id TEXT UNIQUE,
  openai_batch_id TEXT UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('QUEUED','CREATING','IN_PROGRESS','COMPLETED','PARTIAL','FAILED')),
  input_file_id TEXT,
  output_file_id TEXT,
  request_count INTEGER NOT NULL DEFAULT 0,
  applied_count INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  created_at TEXT NOT NULL,
  finished_at TEXT,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_model_evaluation_runs_recent
  ON model_evaluation_runs(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_maintenance_batches_status
  ON maintenance_batches(status, updated_at DESC);
```

평가 원문과 모델 전체 응답은 중복 저장하지 않고 기존 source version과 artifact cache를 참조한다.

- [ ] **Step 2: 모델 비교 점수 테스트와 구현을 작성한다.**

대표 자료는 다음 조건으로 결정론적으로 최대 20개 선택한다.

- 학술 논문 5.
- 웹/비평 5.
- 개인 메모·옵시디언 5.
- 길이가 긴 PDF 5.

평가 기준은 schema valid 20%, source grounding 30%, Korean clarity 20%, important fragment recall 15%, Counter non-strawman 15%다. 후보 모델은 평균 품질이 baseline의 98% 이상이고 비용이 20% 이상 낮을 때만 기본 역할 추천 대상으로 표시한다. 자동으로 모델 역할을 바꾸지는 않는다.

- [ ] **Step 3: Batch API adapter를 구현한다.**

Batch 대상은 다음으로 제한한다.

- 야간 제목·짧은 요약 한국어 정규화.
- 오래된 자료 재분류.
- 발견 후보 enrichment.

착즙·심층 정리·Radar 사용자 실행은 Batch로 보내지 않는다. Batch는 24시간 completion window를 사용하며 D1에 request custom ID와 source version을 저장한다.

- [ ] **Step 4: 별도 MaintenanceWorkflow를 구현한다.**

`maintenanceWorkflow.ts`의 event payload는 다음 두 종류만 허용한다.

```ts
type MaintenanceEvent =
  | { kind: "MODEL_EVALUATION"; runId: string }
  | { kind: "MAINTENANCE_BATCH"; batchId: string };
```

모델 평가는 sample별 baseline/candidate 호출을 최대 2쌍씩 병렬 처리하고 각 결과를 즉시 `model_evaluation_items`에 저장한다. Batch flow는 create → `step.sleep("batch-poll-wait", "30 minutes")` → poll을 반복하고 완료 후 apply한다. stable step name에는 poll 횟수만 사용하고 OpenAI batch ID를 넣지 않는다.

`worker/wrangler.jsonc`에 두 번째 Workflow binding을 추가하고 `pnpm cf:typegen`으로 `Env.MAINTENANCE_WORKFLOW` 타입을 생성한다.

- [ ] **Step 5: 야간 Workflow를 예산 조건부로 연결한다.**

기존 일일 cron에서 홈페이지 동기화가 끝난 뒤 다음 조건을 모두 만족할 때만 `MAINTENANCE_BATCH`를 enqueue한다.

- eligible item 20개 이상.
- 월 사용량 80% 미만.
- 같은 날짜 active/completed batch 없음.

`worker/src/index.ts`의 기존 일일 cron은 조건을 확인해 `maintenance_batches` 행을 만든 후 `MAINTENANCE_WORKFLOW.create()`를 호출한다. 부분 실패 결과는 성공 항목만 적용하고 오류 항목은 다음 batch 대상에 남긴다.

- [ ] **Step 6: 설정에서 전역 모델 비교를 실행하고 결과를 확인한다.**

`POST /api/settings/models/evaluate`는 현재 기본 모델과 사용자가 선택한 후보 모델로 evaluation run을 만들고 `MAINTENANCE_WORKFLOW`를 시작한다. 동일 모델 pair의 QUEUED/RUNNING run이 있으면 재사용한다. `GET /api/settings/models/evaluations/latest`는 최근 상태와 집계만 반환한다.

Settings UI에는 자료별 모델 선택이 아니라 전역 `대표 자료로 비교` 버튼과 `최근 비교: 품질 99%, 비용 -38%` 형식의 읽기 전용 결과만 추가한다. 평가 결과가 `CANDIDATE_ELIGIBLE`이어도 기존 두 역할을 자동 변경하지 않는다.

Run:

```bash
pnpm --filter @radar/worker test -- src/lib/modelEvaluation.test.ts
pnpm --filter @radar/web exec vitest run src/views/SettingsUsageView.test.tsx
pnpm typecheck
```

Expected: 모두 PASS.

- [ ] **Step 7: 커밋한다.**

```bash
git add worker/migrations/0015_model_evaluations_batches.sql worker/src/lib/modelEvaluation.ts worker/src/lib/modelEvaluation.test.ts worker/src/lib/openaiBatch.ts worker/src/workflows/maintenanceWorkflow.ts worker/src/index.ts worker/wrangler.jsonc worker/worker-configuration.d.ts worker/src/routes/settings.ts web/src/views/SettingsView.tsx web/src/views/SettingsUsageView.test.tsx
git commit -m "260823: 모델 품질 비교와 야간 Batch 절감 계층 추가"
```

---

### Task 10: 전체 회귀·실제 병렬성·배포 안전성 검증

**Files:**

- Modify: `web/tests/e2e/core-reading-flow.spec.ts`
- Create: `web/tests/e2e/parallel-jobs.spec.ts`
- Modify: `docs/PROJECT_CONTEXT.md`
- Modify: `docs/DEV_PLAN.md`

**Interfaces:**

- Verifies: 작업 생성 API → Workflow stage 상태 → 화면 복원 → 결과 열기 전체 흐름.
- Produces no new runtime interface.

- [ ] **Step 1: 다중 작업 E2E를 작성한다.**

`parallel-jobs.spec.ts`에서 API mock 또는 local Worker를 사용해 다음 흐름을 검증한다.

1. 자료 A 심층 정리 시작.
2. 착즙 화면으로 이동해 착즙 시작.
3. 발견 화면으로 이동해 발견 시작.
4. Sidebar와 Job Center에 세 작업이 동시에 표시.
5. 새로고침 후 같은 job IDs와 progress 복원.
6. 심층 정리 chunk 단계가 병렬 완료되며 progress가 20%에 고정되지 않음.
7. 완료된 착즙 `결과 보기`가 정확한 session을 엶.

- [ ] **Step 2: 캐시·재시도 E2E를 추가한다.**

- 동일 자료·profile 재실행은 active job을 재사용.
- 완료 후 동일 입력 재실행은 chunk cache hit로 AI 호출 수 감소.
- 한 chunk 429 실패 후 해당 chunk만 retry되고 성공한 chunk 결과는 재사용.
- Counter repair 실패는 전체 session을 허위 성공으로 표시하지 않고 FAILED 또는 unverified 결과로 남김.

- [ ] **Step 3: 전체 정적·단위·브라우저 테스트를 실행한다.**

Run:

```bash
pnpm typecheck
pnpm --filter @radar/worker test
pnpm --filter @radar/web exec vitest run
pnpm --filter @radar/web run build
pnpm --filter @radar/web exec playwright test tests/e2e/core-reading-flow.spec.ts tests/e2e/parallel-jobs.spec.ts
```

Expected: 모든 명령 exit code 0.

- [ ] **Step 4: 로컬 D1 migration과 Worker smoke test를 실행한다.**

Run:

```bash
pnpm --filter @radar/worker exec wrangler d1 migrations apply research-radar-db --local
pnpm --filter @radar/worker exec wrangler d1 migrations list research-radar-db --local
```

Expected: `0014`, `0015` 적용 완료, pending migration 없음.

- [ ] **Step 5: 문서를 현재 구현으로 갱신한다.**

`docs/PROJECT_CONTEXT.md`에 다음을 명시한다.

- 단계형 Workflow와 작업당 병렬 상한.
- 증분 착즙과 exact artifact cache.
- 품질 0.80 gate와 1회 자동 교정.
- 사용자 실행 우선 예산 정책.
- Job Center 진행률과 페이지 이동 후 복원.

`docs/DEV_PLAN.md`의 해당 Task를 완료 상태로 갱신하고 Batch는 실제 배포 시점과 운영 조건을 기록한다.

- [ ] **Step 6: 배포 전 원격 스키마 백업·migration 계획을 확인한다.**

원격 D1 변경 전 현재 migration 목록과 테이블 수를 읽기 전용으로 확인한다. migration은 `0014` 후 `0015` 순서로 적용하고, 실패 시 Worker deploy를 진행하지 않는다.

- [ ] **Step 7: 배포 검증 순서를 실행한다.**

Run:

```bash
pnpm db:migrate
pnpm deploy
```

Expected: D1 migration 성공 후 Worker deploy 성공. 배포 직후 `/api/jobs`, `/api/usage/summary`, 심층 정리 1건, Counter OFF 착즙 1건을 smoke test한다.

- [ ] **Step 8: 최종 커밋을 만든다.**

```bash
git add web/tests/e2e/core-reading-flow.spec.ts web/tests/e2e/parallel-jobs.spec.ts docs/PROJECT_CONTEXT.md docs/DEV_PLAN.md
git commit -m "260823: 병렬 연구 파이프라인 회귀 테스트와 운영 문서 갱신"
```

---

## 단계별 출시 순서

1. **Release A — 기반:** Task 1–4. 사용자 기능 변화 없이 단계 원장·캐시·정확한 비용 집계를 먼저 배포한다.
2. **Release B — 체감 개선:** Task 5와 Task 8. 심층 정리 병렬화와 실제 진행률을 함께 배포한다.
3. **Release C — 연구 품질:** Task 6–7. 증분 착즙·Counter 품질 게이트·발견·레이더 병렬화를 배포한다.
4. **Release D — 비용 최적화:** Task 9. 모델 비교 결과를 검토한 후 Luna 역할 변경과 Batch를 별도 활성화한다.
5. **Release E — 검증:** Task 10 전체 회귀 후 main push와 production smoke test를 수행한다.

## 완료 기준

- 서로 다른 심층 정리·착즙·발견 작업을 동시에 시작할 수 있다.
- 동일 입력의 중복 클릭은 Workflow를 추가 생성하지 않는다.
- 심층 정리 청크 4개와 발견 공급자 branch가 실제로 겹쳐 실행된다.
- 새로고침 후 부모·단계 progress와 현재 메시지가 동일하게 복원된다.
- 단계 실패 시 성공한 sibling stage는 재실행되지 않는다.
- 동일 source version 재분석에서 artifact cache hit가 기록되고 유료 호출이 감소한다.
- 착즙은 변경 자료만 새로 읽고 Counter OFF 시 Counter 비용이 0이다.
- 품질 점수 0.80 미만 또는 fatal issue에서만 상위 모델 교정이 한 번 실행된다.
- 사용량 화면에서 캐시 입력, 품질 점수, 유효 판단당 비용을 확인할 수 있다.
- 기존 저장소·받은 자료·발견·레이더·착즙 핵심 흐름의 회귀 테스트가 모두 통과한다.
