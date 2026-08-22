# Discovery Lanes and Durable Research Jobs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task by task. Use `superpowers:test-driven-development` for each behavior change and `superpowers:verification-before-completion` before claiming completion.

**Goal:** 발견 탭에 오리지널·카운터 검색 방향, 저장·추천 키워드, 방향별 탐색 강도를 추가하고 발견·착즙·레이더·심층 정리 실행을 페이지 이동과 새로고침에도 유지되는 Cloudflare Workflows 작업으로 전환한다.

**Architecture:** 발견 설정은 D1 `kv`의 `discovery_profile_v2`에 저장하고, 기존 `discovery_queries_v1`은 최초 읽기 때 오리지널 레이어로 호환 이전한다. 추천은 D1에 이미 존재하는 키워드·착즙·연구 공백·검증 Counter 자료를 결정론적으로 집계한다. 장시간 실행은 `research_jobs` D1 행과 동일 ID의 Cloudflare Workflow instance를 결합하고, React AppShell이 `/api/jobs`를 polling하여 어느 페이지에서나 진행 상태를 복구한다.

**Tech Stack:** TypeScript, Hono, Cloudflare Workers, Cloudflare Workflows, D1, R2, React 19, Vite, Vitest, Testing Library, Playwright, pnpm workspaces.

**Approved design:** `docs/superpowers/specs/2026-08-22-discovery-lanes-background-jobs-design.md`

---

## 구현 불변 조건

- 기존 관련도 `0.65`, 무료 원문/PDF, 공학 전용 후보 차단, 회당 최대 후보 8개를 유지한다.
- 기존 검색어는 삭제하지 않고 오리지널 레이어로 읽는다.
- 검색어 추천을 위해 새로운 OpenAI 호출을 만들지 않는다.
- 기존 공개 연구 성향 5개는 유지하며, 신규 강도는 발견 탭 지역 설정으로만 둔다.
- `processing_jobs`는 ingestion 전용으로 유지하고 `research_jobs`와 합치지 않는다.
- Workflow에는 원문·긴 분석 결과를 복제하지 않고 결과 ID와 화면 참조만 저장한다.
- 모델명은 코드에 하드코딩하지 않고 기존 env/model settings를 그대로 사용한다.
- 장시간 작업에 `ctx.waitUntil()`을 사용하지 않는다.
- 페이지 이동, 새로고침, 브라우저 재접속 뒤에도 작업 상태를 D1에서 복원한다.
- 일반 스케줄러, 작업 취소·일시정지, 멀티유저 Admin은 추가하지 않는다.

## 확정 데이터 계약

```ts
export type DiscoveryLane = "ORIGINAL" | "COUNTER";
export type DiscoveryQuerySource = "SAVED" | "RECOMMENDED" | "MOMENTUM" | "FEED";

export interface DiscoveryLaneProfile {
  keywords: string[];
  strength: number;
}

export interface DiscoveryProfile {
  original: DiscoveryLaneProfile;
  counter: DiscoveryLaneProfile;
  updatedAt: string;
}

export type ResearchJobKind =
  | "DISCOVERY_RUN"
  | "DISTILL_RUN"
  | "RADAR_SYNTHESIS"
  | "DEEP_ANALYSIS";

export type ResearchJobStatus =
  | "QUEUED"
  | "RUNNING"
  | "SUCCEEDED"
  | "FAILED"
  | "BLOCKED";

export type ResearchJobResultRef =
  | { view: "DISCOVER" }
  | { view: "DISTILL"; sessionId: string }
  | { view: "RADAR"; period: "week" | "month" | "year"; snapshotId?: string }
  | { view: "RESERVOIR"; sourceId: string; analysisId: string };
```

---

### Task 1: 공유 타입, 정규화 규칙, 강도·quota 계산을 먼저 고정

**Files:**

- Modify: `shared/src/discovery.ts`
- Modify: `shared/src/index.ts`
- Create: `web/src/lib/discoveryProfile.test.ts`

**Step 1: 실패하는 순수 함수 테스트 작성**

`web/src/lib/discoveryProfile.test.ts`에서 다음 사례를 작성한다.

```ts
import {
  allocateDiscoveryLaneQuotas,
  normalizeDiscoveryProfile,
  strengthFetchLimit,
  strengthQueryLimit,
} from "@radar/shared/discovery";

it("normalizes duplicate keywords and clamps strengths", () => {
  expect(normalizeDiscoveryProfile({
    original: { keywords: [" 사진 이론 ", "사진 이론", "data", "시각문화"], strength: 104 },
    counter: { keywords: ["물질성 비판"], strength: -3 },
  }, "2026-08-22T00:00:00.000Z")).toEqual({
    original: { keywords: ["사진 이론", "시각문화"], strength: 100 },
    counter: { keywords: ["물질성 비판"], strength: 0 },
    updatedAt: "2026-08-22T00:00:00.000Z",
  });
});

it.each([
  [0, 0, 0],
  [20, 1, 2],
  [50, 2, 4],
  [80, 4, 6],
])("maps strength %i to query and fetch limits", (strength, queries, fetches) => {
  expect(strengthQueryLimit(strength)).toBe(queries);
  expect(strengthFetchLimit(strength)).toBe(fetches);
});

it("allocates 70:30 into six and two final slots", () => {
  expect(allocateDiscoveryLaneQuotas(70, 30, 8)).toEqual({ ORIGINAL: 6, COUNTER: 2 });
});

it("guarantees one slot to each active lane", () => {
  expect(allocateDiscoveryLaneQuotas(99, 1, 8)).toEqual({ ORIGINAL: 7, COUNTER: 1 });
});
```

**Step 2: 테스트가 실패하는지 확인**

Run:

```bash
pnpm --filter @radar/web exec vitest run src/lib/discoveryProfile.test.ts
```

Expected: 공유 함수 export가 없어 TypeScript 또는 import 오류로 FAIL.

**Step 3: 공유 계약과 순수 함수 구현**

`shared/src/discovery.ts`에 다음을 추가한다.

- `DiscoveryLane`, `DiscoveryQuerySource`
- `DiscoveryLaneProfile`, `DiscoveryProfile`
- `DiscoveryRecommendationSource`, `DiscoveryKeywordRecommendation`
- `normalizeDiscoveryKeywords(keywords, max = 4)`
- `normalizeDiscoveryProfile(value, updatedAt)`
- `strengthQueryLimit(strength)`
- `strengthFetchLimit(strength)`
- `allocateDiscoveryLaneQuotas(originalStrength, counterStrength, total = 8)`
- `ResearchJobKind`, `ResearchJobStatus`, `ResearchJobResultRef`, `ResearchJob`

정규화는 `normalizeDiscoveryTitle`로 대소문자·공백 중복을 판정하고 `isUsableDiscoveryQuery`로 일반어 단독 입력을 제거한다. quota는 두 레이어가 활성일 때 각각 최소 1개를 예약한 뒤 남은 슬롯을 강도 비율로 배분한다.

`shared/src/index.ts`에서 새 타입과 함수가 package export를 통해 노출되는지 확인한다. 현재 `@radar/shared/discovery` 직접 import를 유지해도 되지만 UI 공용 타입은 `shared/src/index.ts`에서도 재-export한다.

**Step 4: 단위 테스트 통과 확인**

Run:

```bash
pnpm --filter @radar/web exec vitest run src/lib/discoveryProfile.test.ts
pnpm --filter @radar/shared run typecheck
```

Expected: 모두 PASS.

**Step 5: 커밋**

```bash
git add shared/src/discovery.ts shared/src/index.ts web/src/lib/discoveryProfile.test.ts
git commit -m "260822: 발견 레이어 타입과 탐색 강도 계산 추가"
```

---

### Task 2: D1 스키마에 발견 provenance와 지속 작업 저장소 추가

**Files:**

- Create: `worker/migrations/0013_discovery_lanes_jobs.sql`

**Step 1: migration 작성**

```sql
ALTER TABLE discovery_candidates
  ADD COLUMN discovery_lane TEXT NOT NULL DEFAULT 'ORIGINAL';

ALTER TABLE discovery_candidates
  ADD COLUMN query_source TEXT NOT NULL DEFAULT 'MOMENTUM';

CREATE INDEX IF NOT EXISTS idx_discovery_lane_status
  ON discovery_candidates(discovery_lane, status, relevance_score DESC);

CREATE TABLE IF NOT EXISTS research_jobs (
  id TEXT PRIMARY KEY,
  workflow_instance_id TEXT UNIQUE,
  kind TEXT NOT NULL CHECK (kind IN (
    'DISCOVERY_RUN', 'DISTILL_RUN', 'RADAR_SYNTHESIS', 'DEEP_ANALYSIS'
  )),
  status TEXT NOT NULL CHECK (status IN (
    'QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'BLOCKED'
  )),
  progress INTEGER NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
  message TEXT,
  input_json TEXT NOT NULL,
  result_json TEXT,
  result_ref_json TEXT,
  error_code TEXT,
  error TEXT,
  retry_of TEXT REFERENCES research_jobs(id),
  requested_by TEXT,
  dedupe_key TEXT NOT NULL,
  dismissed_at TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_research_jobs_recent
  ON research_jobs(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_research_jobs_status
  ON research_jobs(status, updated_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_research_jobs_active_dedupe
  ON research_jobs(dedupe_key)
  WHERE status IN ('QUEUED', 'RUNNING');
```

**Step 2: 로컬 D1에 migration 적용**

Run:

```bash
pnpm --filter @radar/worker exec wrangler d1 migrations apply research-radar-db --local
```

Expected: `0013_discovery_lanes_jobs.sql`이 적용되고 오류 없음.

**Step 3: 스키마 확인**

Run:

```bash
pnpm --filter @radar/worker exec wrangler d1 execute research-radar-db --local --command "PRAGMA table_info(research_jobs);"
pnpm --filter @radar/worker exec wrangler d1 execute research-radar-db --local --command "PRAGMA table_info(discovery_candidates);"
```

Expected: `research_jobs.dismissed_at`, `discovery_candidates.discovery_lane`, `query_source`가 표시됨.

**Step 4: 커밋**

```bash
git add worker/migrations/0013_discovery_lanes_jobs.sql
git commit -m "260822: 발견 provenance와 지속 작업 D1 스키마 추가"
```

---

### Task 3: 발견 프로필 저장과 결정론적 추천 API 구현

**Files:**

- Create: `worker/src/discovery/profile.ts`
- Create: `worker/src/discovery/recommendations.ts`
- Modify: `worker/src/routes/discover.ts`
- Create: `web/src/lib/discoveryRecommendations.test.ts`

**Step 1: 추천 집계 순수 로직의 실패 테스트 작성**

`web/src/lib/discoveryRecommendations.test.ts`에 다음을 검증한다.

- 동일 키워드는 lane별 높은 score 한 건만 남는다.
- 저장 검색어는 `1.0`, Counter/Distill은 `0.9`, momentum/gap은 `0.8`, underrepresented는 `0.6`이다.
- 문장형 Counter 제안은 80자로 잘리고 일반어 단독 키워드는 제거된다.
- lane별 최대 8개다.

Run:

```bash
pnpm --filter @radar/web exec vitest run src/lib/discoveryRecommendations.test.ts
```

Expected: 추천 정규화 함수가 없어 FAIL.

**Step 2: 프로필 저장 모듈 구현**

`worker/src/discovery/profile.ts`에 다음 함수를 만든다.

```ts
const PROFILE_KEY = "discovery_profile_v2";
const LEGACY_KEY = "discovery_queries_v1";

export async function loadDiscoveryProfile(db: D1Database): Promise<DiscoveryProfile>;
export async function saveDiscoveryProfile(db: D1Database, value: unknown): Promise<DiscoveryProfile>;
```

동작:

1. `discovery_profile_v2`가 있으면 parse 후 정규화한다.
2. 없으면 `discovery_queries_v1`을 읽어 `original.keywords`로 사용한다.
3. 기본 강도는 original `70`, counter `30`이다.
4. 최초 legacy 읽기는 즉시 `discovery_profile_v2`로 저장해 다음 요청부터 동일 경로를 사용한다.
5. 저장 시 최대 4개, `0..100`, usable query 규칙을 서버에서 재검증한다.

**Step 3: 추천 데이터 조회 구현**

`worker/src/discovery/recommendations.ts`에서 D1을 조회하되 AI를 호출하지 않는다.

```ts
export async function buildDiscoveryRecommendations(
  db: D1Database,
  profile: DiscoveryProfile,
): Promise<{ original: DiscoveryKeywordRecommendation[]; counter: DiscoveryKeywordRecommendation[] }>;
```

조회 순서:

- original: profile saved → 최근 30일 `keywords` → 최신 `distill_sessions.output_json` keywords → `research_gaps` → homepage keywords
- counter: 최신 `distill_sessions.counter_output_json` 중 `validation.status`가 `verified` 또는 `corrected`인 opposing thesis/axes/suggestions → 같은 session의 critic warning → `sources.topics` JSON 저빈도 항목

Counter는 별도 테이블을 만들지 않는다. 기존 `distill_sessions.counter_output_json`, `critic_output_json`, `created_at`을 읽고 JSON parse 오류가 있는 session은 건너뛴다. 저빈도 topic은 `sources.topics` JSON을 메모리 집계하되 source 최대 500행으로 제한한다.

**Step 4: Discover API 추가**

`worker/src/routes/discover.ts`에 추가한다.

```text
GET /api/discover/profile
PUT /api/discover/profile
GET /api/discover/recommendations
```

응답:

```json
{
  "profile": {
    "original": { "keywords": ["사진 이론"], "strength": 70 },
    "counter": { "keywords": ["기술 결정론 비판"], "strength": 30 },
    "updatedAt": "2026-08-22T00:00:00.000Z"
  }
}
```

기존 `/queries` GET/PUT은 한 배포 주기 동안 호환 유지하되 내부에서 original profile을 읽고 쓴다. 새 UI는 `/queries`를 사용하지 않는다.

**Step 5: 테스트와 typecheck**

Run:

```bash
pnpm --filter @radar/web exec vitest run src/lib/discoveryRecommendations.test.ts src/lib/discoveryProfile.test.ts
pnpm --filter @radar/worker run typecheck
```

Expected: PASS.

**Step 6: 커밋**

```bash
git add shared/src/discovery.ts worker/src/discovery/profile.ts worker/src/discovery/recommendations.ts worker/src/routes/discover.ts web/src/lib/discoveryRecommendations.test.ts
git commit -m "260822: 발견 프로필 저장과 키워드 추천 API 구현"
```

---

### Task 4: 발견 수집 엔진을 오리지널·카운터 강도와 quota에 연결

**Files:**

- Modify: `shared/src/discovery.ts`
- Modify: `worker/src/discovery/run.ts`
- Modify: `worker/src/routes/discover.ts`
- Modify: `web/src/lib/discoveryFilter.test.ts`

**Step 1: lane-aware 선택 테스트 추가**

`web/src/lib/discoveryFilter.test.ts`에 다음을 추가한다.

- original 70/counter 30 후보가 충분하면 최종 6/2.
- counter 후보가 0이면 original로 최대 8개 보충.
- 둘 다 활성이고 counter 후보가 1개면 최소 1개 유지.
- 최종 결과에서도 OpenAlex 4/arXiv 2/RSS 2 quota 유지.
- 중복 제목은 lane이 달라도 하나만 남음.

Run:

```bash
pnpm --filter @radar/web exec vitest run src/lib/discoveryFilter.test.ts
```

Expected: lane 선택 함수가 없어 FAIL.

**Step 2: query descriptor와 선택 함수 구현**

```ts
interface DiscoveryQueryDescriptor {
  query: string;
  lane: DiscoveryLane;
  source: DiscoveryQuerySource;
}

interface LaneSelectableCandidate extends SelectableDiscoveryCandidate {
  lane: DiscoveryLane;
  querySource: DiscoveryQuerySource;
}
```

`shared/src/discovery.ts`의 기존 `selectDiscoveryCandidates`를 내부 provider quota 함수로 재사용하고, 공개 함수 `selectDiscoveryCandidatesByLane(candidates, strengths, divergence)`를 추가한다. 우선 lane quota만큼 선발하고 부족 슬롯을 반대 lane의 미선발 후보로 채우되 provider quota와 title dedup은 전체 결과에 한 번만 적용한다.

**Step 3: runDiscovery 입력을 profile snapshot으로 변경**

```ts
export async function runDiscovery(
  env: Env,
  input: { divergence: number; profile: DiscoveryProfile },
): Promise<DiscoveryRunResult>;
```

각 lane에서:

1. 강도에 따라 사용할 키워드 수를 선택한다.
2. 강도에 따라 provider별 query fetch limit을 결정한다.
3. original의 빈 자리는 momentum query로 보완한다.
4. counter는 저장·선택된 counter 키워드만 사용하고 자동 추천을 묵시적으로 실행하지 않는다.
5. RSS는 query가 아니라 feed source이므로 `lane = ORIGINAL`, `querySource = FEED`로 저장한다.

DB insert에 `discovery_lane`, `query_source`를 포함한다. 기존 maintenance는 이 두 값을 변경하지 않는다.

**Step 4: candidate 조회 필터 확장**

`GET /api/discover/candidates?status=CANDIDATE&lane=COUNTER`를 지원한다. lane 미지정은 전체다. 응답에 `discoveryLane`, `querySource`를 포함한다.

**Step 5: 테스트와 typecheck**

Run:

```bash
pnpm --filter @radar/web exec vitest run src/lib/discoveryFilter.test.ts
pnpm --filter @radar/worker run typecheck
```

Expected: PASS.

**Step 6: 커밋**

```bash
git add shared/src/discovery.ts worker/src/discovery/run.ts worker/src/routes/discover.ts web/src/lib/discoveryFilter.test.ts
git commit -m "260822: 발견 수집에 오리지널 카운터 강도와 quota 반영"
```

---

### Task 5: 발견 방향 패널과 후보 provenance UI 구현

**Files:**

- Create: `web/src/components/discovery/DiscoveryDirectionPanel.tsx`
- Create: `web/src/components/discovery/DiscoveryDirectionPanel.test.tsx`
- Modify: `web/src/views/DiscoverView.tsx`
- Modify: `web/src/views/DiscoverView.test.tsx`
- Modify: `web/src/styles/views.css`

**Step 1: 컴포넌트 실패 테스트 작성**

`DiscoveryDirectionPanel.test.tsx`에서 검증한다.

- 오리지널·카운터 카드가 모두 보인다.
- slider 값 70은 `깊게`, 30은 `가볍게`로 읽힌다.
- 추천 chip 클릭 시 해당 lane 저장 keyword로 이동한다.
- keyword는 lane당 4개에서 추가 차단된다.
- 제거 버튼과 dirty 상태가 접근 가능한 이름을 가진다.
- 저장 성공 callback 뒤 dirty 상태가 해제된다.

Run:

```bash
pnpm --filter @radar/web exec vitest run src/components/discovery/DiscoveryDirectionPanel.test.tsx
```

Expected: 컴포넌트가 없어 FAIL.

**Step 2: 패널 구현**

레이아웃 순서:

1. `발견 방향` 제목과 현재 설정 요약
2. original card
3. counter card
4. `검색 설정 저장`

slider는 `min=0`, `max=100`, `step=10`이며 숫자와 `꺼짐/가볍게/표준/깊게`를 함께 표시한다. 추천 chip에는 source badge와 짧은 reason tooltip을 넣는다. 색은 기존 accent 한 색만 쓰고 lane 차이는 라벨·테두리·아이콘으로 식별한다.

**Step 3: DiscoverView 연결**

mount 시 병렬 로드:

```text
/api/discover/profile
/api/discover/recommendations
/api/discover/candidates
/api/discover/feeds
/api/settings/homepage
```

기존 query textarea를 제거하고 panel로 교체한다. unsaved profile이면 `지금 새로 찾기`를 disabled 처리하고 `검색 설정을 먼저 저장하세요`를 보여준다.

후보 목록에:

- 오리지널/카운터 badge
- 실제 query
- 저장/추천/momentum/feed source
- `전체 / 오리지널 / 카운터` filter

를 추가한다.

**Step 4: DiscoverView 회귀 테스트 수정**

기존 실제 링크·발전시키기 테스트 mock에 profile/recommendations 응답을 추가한다. lane filter를 누르면 candidate 요청에 `lane=COUNTER`가 포함되는 테스트와 profile 저장 toast 테스트를 추가한다.

**Step 5: UI 테스트 통과 확인**

Run:

```bash
pnpm --filter @radar/web exec vitest run src/components/discovery/DiscoveryDirectionPanel.test.tsx src/views/DiscoverView.test.tsx
pnpm --filter @radar/web run typecheck
```

Expected: PASS.

**Step 6: 커밋**

```bash
git add web/src/components/discovery/DiscoveryDirectionPanel.tsx web/src/components/discovery/DiscoveryDirectionPanel.test.tsx web/src/views/DiscoverView.tsx web/src/views/DiscoverView.test.tsx web/src/styles/views.css
git commit -m "260822: 발견 방향 키워드 강도 패널과 레이어 필터 구현"
```

---

### Task 6: research_jobs 저장소와 API를 먼저 구현

**Files:**

- Create: `worker/src/jobs/store.ts`
- Create: `worker/src/jobs/enqueue.ts`
- Create: `worker/src/routes/jobs.ts`
- Modify: `worker/src/index.ts`
- Create: `web/src/lib/researchJobs.ts`
- Create: `web/src/lib/researchJobs.test.ts`

**Step 1: web job 정규화 실패 테스트 작성**

`web/src/lib/researchJobs.test.ts`에서 API snake/camel 형태를 하나로 정규화하고 active 여부를 판정하는 순수 함수를 먼저 테스트한다.

```ts
expect(isActiveResearchJob({ status: "QUEUED" })).toBe(true);
expect(isActiveResearchJob({ status: "RUNNING" })).toBe(true);
expect(isActiveResearchJob({ status: "BLOCKED" })).toBe(false);
```

Run:

```bash
pnpm --filter @radar/web exec vitest run src/lib/researchJobs.test.ts
```

Expected: helper가 없어 FAIL.

**Step 2: D1 store 구현**

`worker/src/jobs/store.ts`에 최소 API를 만든다.

```ts
export async function createResearchJob(db, input): Promise<ResearchJob>;
export async function findActiveJobByDedupeKey(db, dedupeKey): Promise<ResearchJob | null>;
export async function getResearchJob(db, id): Promise<ResearchJob | null>;
export async function listResearchJobs(db, requestedBy, limit = 20): Promise<ResearchJob[]>;
export async function markJobRunning(db, id, message): Promise<void>;
export async function updateJobProgress(db, id, progress, message): Promise<void>;
export async function completeResearchJob(db, id, result, resultRef): Promise<void>;
export async function failResearchJob(db, id, errorCode, error): Promise<void>;
export async function blockResearchJob(db, id, errorCode, error): Promise<void>;
export async function dismissResearchJob(db, id, requestedBy): Promise<boolean>;
```

모든 write는 `updated_at`을 갱신한다. 오류 문자열은 300자로 제한하고 JSON parse 실패는 API에서 500이 아니라 안정적인 빈 result로 정규화한다.

**Step 3: enqueue helper 구현**

`worker/src/jobs/enqueue.ts`의 입력은 kind별 discriminated union이다.

```ts
export async function enqueueResearchJob(
  env: Env,
  request: ResearchJobRequest,
  requestedBy: string,
): Promise<{ job: ResearchJob; reused: boolean }>;
```

순서:

1. 결정론적 `dedupe_key` 생성.
2. active job 조회, 있으면 `reused: true` 반환.
3. 새 D1 QUEUED job 삽입.
4. `env.RESEARCH_JOBS_WORKFLOW.create({ id: job.id, params: { jobId: job.id } })`.
5. workflow instance ID 저장.
6. create 실패 시 job을 FAILED 처리하고 오류를 다시 throw.

dedupe key:

- discovery: `DISCOVERY_RUN:{profile.updatedAt}`
- distill: `DISTILL_RUN:{redistillOf ?? 'new'}:{includeCounter}:{sortedKeepElements}`
- radar: `RADAR_SYNTHESIS:{period}`
- deep analysis: `DEEP_ANALYSIS:{sourceId}:{profile}`

**Step 4: jobs route 추가**

```text
GET   /api/jobs?status=active|recent
GET   /api/jobs/:id
POST  /api/jobs/:id/retry
PATCH /api/jobs/:id/dismiss
```

- 목록은 `dismissed_at IS NULL`만 반환한다.
- retry는 원 job의 `input_json`을 재사용하되 새 ID와 `retry_of`를 기록한다.
- requested user는 `c.get("identity")?.email ?? "local"`이다.
- 다른 requested_by의 job은 반환·수정하지 않는다.

**Step 5: index route 등록과 client helper 구현**

`worker/src/index.ts`에 `app.route("/api/jobs", jobsRoute)`를 등록한다. `web/src/lib/researchJobs.ts`에는 API 정규화, `isActiveResearchJob`, job label/result target 매핑 순수 함수를 둔다.

**Step 6: 테스트와 typecheck**

Run:

```bash
pnpm --filter @radar/web exec vitest run src/lib/researchJobs.test.ts
pnpm --filter @radar/worker run typecheck
```

Expected: Workflow binding 전에는 Env type이 없어 Worker typecheck가 실패할 수 있다. 그 경우 Task 7의 binding/typegen을 연속 수행한 뒤 두 Task를 함께 검증하되, 임시 `any`나 수동 Env 선언은 추가하지 않는다.

**Step 7: 커밋**

Task 7 typegen과 함께 typecheck가 통과한 뒤 커밋한다.

---

### Task 7: Cloudflare Workflow binding과 실행 클래스 추가

**Files:**

- Create: `worker/src/workflows/researchJob.ts`
- Modify: `worker/src/index.ts`
- Modify: `worker/wrangler.jsonc`
- Regenerate: `worker/worker-configuration.d.ts`

**Step 1: wrangler workflow binding 추가**

`worker/wrangler.jsonc`에 기존 binding을 유지하고 다음을 추가한다.

```jsonc
"workflows": [
  {
    "name": "research-radar-jobs",
    "binding": "RESEARCH_JOBS_WORKFLOW",
    "class_name": "ResearchJobWorkflow"
  }
]
```

**Step 2: Workflow class skeleton 구현**

```ts
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";

export class ResearchJobWorkflow extends WorkflowEntrypoint<Env, { jobId: string }> {
  async run(event: WorkflowEvent<{ jobId: string }>, step: WorkflowStep): Promise<void> {
    const { jobId } = event.payload;
    // D1 job load → RUNNING → kind dispatch → SUCCEEDED/BLOCKED/FAILED
  }
}
```

실행 규칙:

- 시작 step: D1 job을 `RUNNING`, progress `5`로 변경.
- 실행 step: `{ retries: { limit: 1, delay: "5 seconds", backoff: "exponential" }, timeout: "15 minutes" }`.
- AI 작업은 실행 직전 기존 budget helper로 재검증.
- 예산 소진 오류는 `BLOCKED/monthly_budget_exhausted`.
- 일반 오류는 outer catch에서 `FAILED`, 오류 300자 저장 후 throw.
- 완료는 result/resultRef 저장, progress `100`.
- 각 step callback은 외부 scope의 mutable 값을 사용하지 않고 D1 job input을 다시 읽어 재시작 안전성을 유지한다.

**Step 3: Worker export 추가**

`worker/src/index.ts`에서 default Hono app export를 유지하면서 named export를 추가한다.

```ts
export { ResearchJobWorkflow } from "./workflows/researchJob";
```

**Step 4: Env type 재생성**

Run:

```bash
pnpm cf:typegen
```

Expected: `worker/worker-configuration.d.ts`의 `Env`에 `RESEARCH_JOBS_WORKFLOW: Workflow<...>`가 생성됨. `worker/src/env-secrets.d.ts`에 binding을 수동 추가하지 않는다.

**Step 5: Task 6과 7 typecheck**

Run:

```bash
pnpm --filter @radar/worker run typecheck
pnpm --filter @radar/web exec vitest run src/lib/researchJobs.test.ts
```

Expected: PASS.

**Step 6: 커밋**

```bash
git add worker/src/jobs/store.ts worker/src/jobs/enqueue.ts worker/src/routes/jobs.ts worker/src/workflows/researchJob.ts worker/src/index.ts worker/wrangler.jsonc worker/worker-configuration.d.ts web/src/lib/researchJobs.ts web/src/lib/researchJobs.test.ts
git commit -m "260822: Cloudflare Workflow 기반 지속 연구 작업 코어 구현"
```

---

### Task 8: 네 개 장시간 Worker 동작을 Workflow job으로 전환

**Files:**

- Create: `worker/src/radar/run.ts`
- Modify: `worker/src/routes/discover.ts`
- Modify: `worker/src/routes/distill.ts`
- Modify: `worker/src/routes/radar.ts`
- Modify: `worker/src/routes/reservoir.ts`
- Modify: `worker/src/discovery/run.ts`
- Modify: `worker/src/distill/run.ts`
- Modify: `worker/src/analysis/deepAnalyze.ts`
- Modify: `worker/src/workflows/researchJob.ts`

**Step 1: route handler에서 domain runner 분리**

각 runner는 HTTP 객체를 받지 않고 JSON serializable input과 Env만 받는다.

```ts
runDiscovery(env, { divergence, profile })
runDistill(env, { includeCounter, redistillOf, keepElements })
runRadarSynthesis(env, { period })
analyzeDeepSource(env, sourceId, profile)
```

`worker/src/routes/radar.ts`에 섞여 있는 snapshot 생성 로직은 `worker/src/radar/run.ts`로 옮긴다. 기존 cron이 부르는 함수가 있다면 동일 runner를 재사용한다. `analyzeDeepSource`는 insert 전에 `analysisId = uuid()`를 만들고 반환 타입에 `analysisId`를 추가해 Workflow resultRef가 정확한 결과를 가리키게 한다.

**Step 2: Workflow kind dispatch 연결**

반환 resultRef:

- discovery: `{ view: "DISCOVER" }`
- distill: `{ view: "DISTILL", sessionId }`
- radar: `{ view: "RADAR", period, snapshotId }`
- deep analysis: `{ view: "RESERVOIR", sourceId, analysisId }`

진행률은 도메인별 3~4개의 안정된 단계에서만 갱신한다. provider item마다 D1 write하지 않는다.

**Step 3: POST route를 enqueue 응답으로 변경**

다음 endpoint는 작업을 기다리지 않고 `202`를 반환한다.

```text
POST /api/discover/run
POST /api/distill/run
POST /api/radar/synthesize
POST /api/reservoir/:sourceId/deep-analysis
```

표준 응답:

```json
{
  "job": {
    "id": "...",
    "kind": "DISCOVERY_RUN",
    "status": "QUEUED",
    "progress": 0
  },
  "reused": false
}
```

오류:

- 빈 발견 profile: `400 discovery_profile_empty`
- 예산 사전 차단: job을 만들지 않고 `429 monthly_budget_exhausted`
- active 중복: 기존 job과 `reused: true`, HTTP `202`

**Step 4: 기존 결과 조회 API 유지**

착즙 session, radar snapshot, deep analysis GET endpoint는 변경하지 않는다. Workflow는 기존 저장 동작을 실행한 뒤 ID만 job에 기록한다.

**Step 5: 짧은 waitUntil 정리**

distill 후 검증이 현재 `c.executionCtx.waitUntil()`에 있다면 Workflow 안의 별도 `step.do("verify counter", ...)`로 옮긴다. 요청 context에 의존하는 장시간 실행을 남기지 않는다.

**Step 6: typecheck와 local API smoke**

Run:

```bash
pnpm --filter @radar/worker run typecheck
pnpm --filter @radar/worker exec wrangler dev --local
```

별도 터미널에서:

```bash
curl -i -X POST http://127.0.0.1:8787/api/discover/run
curl -s http://127.0.0.1:8787/api/jobs?status=active
```

Expected: 첫 요청 `202`, jobs 응답에 동일 job ID와 `QUEUED` 또는 `RUNNING` 상태.

**Step 7: 커밋**

```bash
git add worker/src/radar/run.ts worker/src/routes/discover.ts worker/src/routes/distill.ts worker/src/routes/radar.ts worker/src/routes/reservoir.ts worker/src/discovery/run.ts worker/src/distill/run.ts worker/src/analysis/deepAnalyze.ts worker/src/workflows/researchJob.ts
git commit -m "260822: 발견 착즙 레이더 심층 정리를 지속 작업으로 전환"
```

---

### Task 9: 전역 Job Center로 브라우저 메모리 작업을 교체

**Files:**

- Modify: `web/src/lib/researchJobs.ts`
- Create: `web/src/components/layout/JobCenter.tsx`
- Create: `web/src/components/layout/JobCenter.test.tsx`
- Modify: `web/src/App.tsx`
- Modify: `web/src/components/layout/AppShell.tsx`
- Modify: `web/src/components/layout/AppShell.test.tsx`
- Delete: `web/src/components/layout/TaskCenter.tsx`
- Delete: `web/src/lib/tasks.ts`
- Modify: `web/src/styles/shell.css`

**Step 1: Job Center 실패 테스트 작성**

검증:

- RUNNING job은 label, progress, message를 표시한다.
- SUCCEEDED는 `결과 보기`와 닫기를 표시한다.
- BLOCKED는 일반 실패와 다른 `설정 확인` 문구를 표시한다.
- 닫기는 `/api/jobs/:id/dismiss` PATCH 호출 후 목록에서 제거한다.
- 결과 보기는 resultRef에 맞는 `View`와 focus payload를 App callback으로 전달한다.

Run:

```bash
pnpm --filter @radar/web exec vitest run src/components/layout/JobCenter.test.tsx
```

Expected: 컴포넌트가 없어 FAIL.

**Step 2: useResearchJobs 구현**

`web/src/lib/researchJobs.ts`:

```ts
export function useResearchJobs(): {
  jobs: ResearchJob[];
  refresh: () => Promise<void>;
  dismiss: (id: string) => Promise<void>;
  retry: (id: string) => Promise<void>;
};
```

polling 규칙:

- App mount 즉시 recent 20개 조회.
- active job이 있으면 2초 후 다시 조회.
- active job이 없으면 polling timer 제거.
- unmount 시 timer/AbortController 해제.
- 이전 render에서 보이지 않던 SUCCEEDED/FAILED/BLOCKED 전환은 toast로 한 번만 알림.
- polling 오류는 기존 job을 지우지 않고 다음 5초에 재시도.

**Step 3: AppShell 연결**

`App.tsx`가 `useResearchJobs`를 한 번만 호출한다. `AppShell`은 jobs와 result navigation callback을 받아 sidebar 밖 content 상단에 JobCenter를 유지한다.

정확한 결과 focus를 위해 App에 다음 상태를 둔다.

```ts
type ViewFocus =
  | { view: "DISTILL"; sessionId: string }
  | { view: "RADAR"; period: "week" | "month" | "year" }
  | { view: "RESERVOIR"; sourceId: string }
  | null;
```

각 View는 optional focus prop을 받고 사용 후 clear callback을 호출한다. 단순 discovery 결과는 view 이동만 한다.

**Step 4: 기존 TaskCenter 제거**

모든 `runTask/useTasks/isTaskRunning` import가 사라진 뒤 `tasks.ts`, `TaskCenter.tsx`를 삭제한다. 임시로 두 시스템을 병행하지 않는다.

**Step 5: 테스트**

Run:

```bash
pnpm --filter @radar/web exec vitest run src/components/layout/JobCenter.test.tsx src/components/layout/AppShell.test.tsx src/lib/researchJobs.test.ts
pnpm --filter @radar/web run typecheck
```

Expected: PASS.

**Step 6: 커밋**

```bash
git add web/src/lib/researchJobs.ts web/src/components/layout/JobCenter.tsx web/src/components/layout/JobCenter.test.tsx web/src/App.tsx web/src/components/layout/AppShell.tsx web/src/components/layout/AppShell.test.tsx web/src/styles/shell.css
git rm web/src/components/layout/TaskCenter.tsx web/src/lib/tasks.ts
git commit -m "260822: 전역 지속 작업 센터와 결과 이동 UX 구현"
```

---

### Task 10: 네 화면의 실행 버튼을 202 job UX로 연결

**Files:**

- Modify: `web/src/views/DiscoverView.tsx`
- Modify: `web/src/views/DiscoverView.test.tsx`
- Modify: `web/src/views/DistillView.tsx`
- Modify: `web/src/views/DistillView.test.tsx`
- Modify: `web/src/views/RadarView.tsx`
- Modify: `web/src/views/RadarView.test.tsx`
- Modify: `web/src/views/ReservoirView.tsx`
- Modify: `web/src/views/ReservoirView.test.tsx`

**Step 1: 각 화면 테스트를 202 응답 기준으로 변경**

각 View test에서 POST mock을 다음처럼 바꾼다.

```json
{
  "job": { "id": "job-1", "kind": "DISCOVERY_RUN", "status": "QUEUED", "progress": 0 },
  "reused": false
}
```

검증:

- 클릭 후 `백그라운드에서 발견을 시작했습니다` toast.
- 응답을 기다려 View 데이터를 즉시 덮어쓰지 않는다.
- 동일 kind active job이 전역 jobs에 있으면 버튼을 disabled하고 `실행 중` 표시.
- reused이면 중복 toast 대신 `이미 실행 중인 작업을 표시했습니다`.
- Distill focus sessionId, Radar period, Reservoir sourceId가 결과 보기로 정확히 열린다.

**Step 2: View props 확장**

`App.tsx`에서 각 View에 active jobs와 focus를 필요한 만큼 전달한다. View가 별도 polling을 만들지 않고 전역 상태를 참조하도록 한다.

**Step 3: 완료 결과 refresh**

Job Center의 결과 보기를 클릭했을 때만:

- Discover: candidate 목록 reload
- Distill: sessionId open + session list reload
- Radar: period 변경 + snapshot reload
- Reservoir: sourceId detail open + 최신 analysis reload

자동 완료 시 현재 읽던 문서를 강제로 바꾸지 않는다.

**Step 4: View 테스트 전체 실행**

Run:

```bash
pnpm --filter @radar/web exec vitest run src/views/DiscoverView.test.tsx src/views/DistillView.test.tsx src/views/RadarView.test.tsx src/views/ReservoirView.test.tsx
```

Expected: PASS.

**Step 5: 커밋**

```bash
git add web/src/App.tsx web/src/views/DiscoverView.tsx web/src/views/DiscoverView.test.tsx web/src/views/DistillView.tsx web/src/views/DistillView.test.tsx web/src/views/RadarView.tsx web/src/views/RadarView.test.tsx web/src/views/ReservoirView.tsx web/src/views/ReservoirView.test.tsx
git commit -m "260822: 장시간 실행 버튼을 백그라운드 작업 UX로 연결"
```

---

### Task 11: 페이지 이동·새로고침 지속성 E2E와 접근성 회귀 검증

**Files:**

- Create: `web/tests/e2e/background-jobs.spec.ts`
- Modify: `web/tests/e2e/core-reading-flow.spec.ts`

**Step 1: 실패하는 E2E 작성**

Playwright route mock이 job 상태를 호출 횟수에 따라 `QUEUED → RUNNING → SUCCEEDED`로 전환하도록 한다.

시나리오:

1. 발견 탭에서 저장된 profile을 표시한다.
2. original/counter 강도와 keyword를 저장한다.
3. `지금 새로 찾기` 클릭.
4. 저장소로 이동해도 Job Center가 RUNNING을 표시한다.
5. page reload.
6. `/api/jobs`를 다시 읽어 RUNNING을 복구한다.
7. SUCCEEDED가 되면 `결과 보기`가 나타난다.
8. 클릭 시 발견 탭으로 이동하고 후보 목록을 reload한다.
9. 닫고 다시 reload해도 dismissed job이 보이지 않는다.

추가 시나리오:

- counter strength 0이면 실행 profile에 counter keyword가 있어도 counter query가 생성되지 않는다.
- 70/30 결과에 original/counter badge가 모두 표시된다.
- slider와 keyword remove 버튼을 keyboard로 조작할 수 있다.

**Step 2: E2E 실패 확인**

Run:

```bash
pnpm --filter @radar/web exec playwright test tests/e2e/background-jobs.spec.ts
```

Expected: 구현 연결 전 FAIL.

**Step 3: 필요한 selector·aria만 보완**

테스트를 통과시키기 위한 시각적 재설계는 하지 않는다. `aria-label`, status text, stable role을 보완하고 data-testid는 외부에서 구분할 수 없는 경우에만 사용한다.

**Step 4: E2E 통과 확인**

Run:

```bash
pnpm --filter @radar/web exec playwright test tests/e2e/background-jobs.spec.ts tests/e2e/core-reading-flow.spec.ts
```

Expected: PASS.

**Step 5: 커밋**

```bash
git add web/tests/e2e/background-jobs.spec.ts web/tests/e2e/core-reading-flow.spec.ts web/src
git commit -m "260822: 발견 레이어와 지속 작업 E2E 회귀 검증 추가"
```

---

### Task 12: 운영 문서, 전체 검증, 원격 migration, push, deploy

**Files:**

- Modify: `docs/PROJECT_CONTEXT.md`
- Modify: `docs/DEV_PLAN.md`
- Modify: `docs/SPEC.md`
- Modify: `docs/V1_GUIDE.md`

**Step 1: Source of Truth 문서 갱신**

문서에는 다음만 반영한다.

- 발견은 original/counter profile과 strength를 사용함.
- 최종 후보 8개와 기존 quality gate는 유지함.
- 사용자 장시간 작업은 `research_jobs + Workflows`임.
- ingestion의 `processing_jobs`는 별도임.
- 운영자가 보는 endpoint, migration, workflow binding 이름.
- 현재 배포·provenance 문서에 새 migration과 job 상태를 기록함.

새 기능 범위를 넘어 챗봇·semantic search·멀티유저 요구사항은 추가하지 않는다.

**Step 2: 전체 정적·단위·빌드 검증**

Run:

```bash
pnpm typecheck
pnpm --filter @radar/web exec vitest run
pnpm build
pnpm --filter @radar/web exec playwright test tests/e2e/background-jobs.spec.ts tests/e2e/core-reading-flow.spec.ts
```

Expected: 모두 exit code 0.

**Step 3: 로컬 migration 재실행의 멱등성 확인**

Run:

```bash
pnpm --filter @radar/worker exec wrangler d1 migrations apply research-radar-db --local
```

Expected: 적용할 새 migration 없음.

**Step 4: 최종 문서 커밋**

```bash
git add docs/SPEC.md docs/DEV_PLAN.md docs/PROJECT_CONTEXT.md docs/V1_GUIDE.md docs/superpowers/specs/2026-08-22-discovery-lanes-background-jobs-design.md docs/superpowers/plans/2026-08-22-discovery-lanes-background-jobs.md
git commit -m "260822: 발견 레이어와 지속 작업 운영 문서 확정"
```

**Step 5: push 전 상태 확인**

Run:

```bash
git status --short
git log -6 --oneline
git diff origin/main...HEAD --stat
```

Expected: 의도한 파일만 commit되어 있고 기존 `.playwright-cli/`, `.pnpm-store/`, `.superpowers/`, `output/`, `web/test-results/` 생성물은 commit되지 않음.

**Step 6: main push**

Run:

```bash
git push origin main
```

Expected: remote `main`이 현재 HEAD로 갱신됨.

**Step 7: 원격 D1 migration**

새 컬럼·테이블 추가는 기존 배포와 역호환이므로 코드 배포 전에 적용한다.

Run:

```bash
pnpm --filter @radar/worker exec wrangler d1 migrations apply research-radar-db --remote
```

Expected: `0013_discovery_lanes_jobs.sql` 적용 성공.

**Step 8: Cloudflare deploy**

Run:

```bash
pnpm deploy
```

Expected: static assets와 Worker가 배포되고 `research-radar-jobs` workflow binding이 생성·연결됨.

**Step 9: 운영 smoke 검증**

Cloudflare Access에 로그인된 브라우저에서:

1. 발견 profile 저장 후 toast 확인.
2. original 70/counter 30으로 발견 실행.
3. 즉시 저장소로 이동하고 Job Center 진행 확인.
4. 새로고침 후 동일 job ID 복구 확인.
5. 완료 후 결과 보기로 발견 후보 이동.
6. candidate provenance와 8개 제한 확인.
7. 착즙, 레이더, 심층 정리 각각 한 번 실행해 202와 결과 링크 확인.
8. 중복 클릭이 새 job을 만들지 않는지 확인.

운영 CLI 확인:

```bash
pnpm --filter @radar/worker exec wrangler deployments list
pnpm --filter @radar/worker exec wrangler d1 execute research-radar-db --remote --command "SELECT kind, status, progress, created_at FROM research_jobs ORDER BY created_at DESC LIMIT 10;"
```

Expected: 최신 deployment와 SUCCEEDED job 행 확인.

**Step 10: 롤백 기준**

- UI/API 오류가 있으면 직전 Worker deployment로 rollback한다.
- migration은 additive이므로 down migration을 실행하지 않는다. 이전 코드는 새 컬럼·테이블을 무시한다.
- workflow 생성만 실패하면 발견/착즙/레이더/심층 정리 버튼을 비활성화하고 job 오류를 표시하며 동기 실행으로 묵시적 fallback하지 않는다.

---

## 완료 조건

- [ ] 기존 검색어가 오리지널 키워드로 보존된다.
- [ ] 오리지널·카운터 각각 최대 4개 저장 및 최대 8개 추천이 가능하다.
- [ ] 각 강도가 실제 query 수·provider fetch 깊이·최종 8개 quota를 바꾼다.
- [ ] 카운터도 동일한 무료 접근·관련도·공학 차단 품질 gate를 통과한다.
- [ ] 후보에서 lane, query, query source, provider, 접근 상태를 확인할 수 있다.
- [ ] 네 장시간 작업이 HTTP 202 후 Workflow에서 계속된다.
- [ ] 페이지 이동·새로고침 뒤 동일 job 상태가 복원된다.
- [ ] 중복 실행은 기존 active job을 재사용한다.
- [ ] 예산 소진은 `BLOCKED`로 구분된다.
- [ ] 완료 결과 보기로 정확한 화면과 자료를 연다.
- [ ] 닫은 작업은 새로고침 후 다시 나타나지 않는다.
- [ ] 전체 typecheck, Vitest, build, Playwright가 통과한다.
- [ ] 원격 D1 migration, Git push, Cloudflare deploy, 운영 smoke가 완료된다.
