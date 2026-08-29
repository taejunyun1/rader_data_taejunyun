# Reservoir Permanent Source Deletion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 저장소 상세 화면에서 제목 재입력 확인을 거쳐 선택 자료와 그 자료가 소유한 D1/R2 데이터를 영구 삭제하되, 다른 자료와 병합 그룹은 손상하지 않는다.

**Architecture:** `worker/src/reservoir/deleteSource.ts`가 삭제 사전 점검, R2 키 수집·삭제, 병합 복구, D1 의존성 역순 삭제를 전담한다. Hono route는 JSON 검증과 오류 코드 매핑만 담당하고, React에서는 접근 가능한 전용 확인 모달을 `ReservoirView`에 연결한다. R2 삭제가 모두 성공한 뒤에만 하나의 D1 batch를 실행하며, 재시도는 R2 delete의 멱등성을 이용한다.

**Tech Stack:** TypeScript 5.9, Hono 4, Cloudflare Workers/D1/R2, React 19, Vitest 4, Testing Library, pnpm workspaces

## Global Constraints

- 기준 명세는 `docs/superpowers/specs/2026-08-29-reservoir-permanent-source-deletion-design.md`다.
- 사용자가 확인한 B안만 구현한다: 제목을 정확히 재입력한 뒤 즉시 영구 삭제한다. 휴지통, 유예 기간, 복구 기능은 추가하지 않는다.
- 병합 자료는 선택한 자료만 삭제한다. 다른 구성원과 그 R2 객체는 보존한다.
- `ignore` 판단은 계속 가역적 분류이며 삭제로 취급하지 않는다.
- 과거 `distill_sessions`, snapshot, 완료된 `research_jobs`의 JSON 결과는 수정하지 않는다.
- `discovery_candidates` 행은 보존하고 삭제 자료를 가리키는 nullable `source_id`만 `NULL`로 바꾼다. `discovery_field_signals.source_id`는 Reservoir source ID가 아니므로 건드리지 않는다.
- R2 삭제 중 하나라도 실패하면 D1 batch를 호출하지 않는다. D1 실패는 성공으로 응답하지 않는다.
- 원문, R2 key, SQL 오류 전문을 API 응답·toast·새 로그에 노출하지 않는다.
- 새 외부 dependency와 새 D1 migration은 필요하지 않다.
- 기존 작업트리에 다른 변경이 있으면 보존한다. 각 커밋은 이 계획에서 지정한 파일만 stage한다.
- 구현 및 검증만 수행한다. 배포, `git push`, 원격 D1 migration은 별도 사용자 요청 없이는 실행하지 않는다.
- 커밋 메시지는 `YYMMDD: 주요 내용` 형식을 사용한다.

## File Map

| File | Responsibility |
| --- | --- |
| `worker/src/reservoir/canonicalSource.ts` | 기존 저장소 정리와 삭제가 함께 쓰는 대표 자료 선정 규칙 |
| `worker/src/reservoir/canonicalSource.test.ts` | 대표 선정 우선순위 회귀 테스트 |
| `worker/src/reservoir/deleteSource.ts` | 삭제 preview, 활성 작업 차단, R2 key 수집·삭제, 병합 복구, D1 purge |
| `worker/src/reservoir/deleteSource.test.ts` | 실제 test D1/R2를 이용한 삭제 서비스 통합 테스트 |
| `worker/src/reservoir/refresh.ts` | 기존 private 대표 선정 함수를 공통 모듈 import로 교체 |
| `worker/src/routes/reservoir.ts` | 상세 응답의 삭제 preview와 `DELETE /:sourceId` route |
| `worker/src/routes/reservoir.test.ts` | HTTP validation/status/payload 계약 테스트 |
| `worker/vitest.config.ts` | 새 worker 테스트 파일을 runtime suite에 포함 |
| `web/src/components/reservoir/SourceDeleteDialog.tsx` | 제목 확인형 영구 삭제 모달과 병합 영향 안내 |
| `web/src/components/reservoir/SourceDeleteDialog.test.tsx` | 모달 확인, 접근성, pending 동작 테스트 |
| `web/src/views/ReservoirView.tsx` | 상세 위험 영역, DELETE 호출, 성공 후 목록 복귀·재조회 |
| `web/src/views/ReservoirView.test.tsx` | API 요청, 오류, stale 응답, 성공 후 UI 동작 테스트 |
| `web/src/styles/views.css` | 위험 영역·위험 버튼·삭제 모달 스타일 |
| `docs/PROJECT_CONTEXT.md` | 구현 완료 상태와 영구 삭제 경계 기록 |

---

### Task 1: 대표 자료 선정 규칙을 공통 모듈로 분리

**Files:**
- Create: `worker/src/reservoir/canonicalSource.ts`
- Create: `worker/src/reservoir/canonicalSource.test.ts`
- Modify: `worker/src/reservoir/refresh.ts:15,360-397`
- Modify: `worker/vitest.config.ts`

**Interfaces:**
- Consumes: `D1Database`, `sources`, `source_versions`, `user_signals`, `thread_links`
- Produces: `selectCanonicalSourceId(db: D1Database, sourceIds: string[]): Promise<string>`

- [ ] **Step 1: 새 테스트 파일을 runtime test include에 등록한다**

`worker/vitest.config.ts`의 `include` 배열에 다음 두 경로를 추가한다. Task 2에서 만들 테스트도 지금 등록해 이후 red/green 명령이 정확히 작동하게 한다.

```ts
"src/reservoir/canonicalSource.test.ts",
"src/reservoir/deleteSource.test.ts",
```

- [ ] **Step 2: 대표 선정 우선순위의 실패 테스트를 작성한다**

`worker/src/reservoir/canonicalSource.test.ts`를 생성한다.

```ts
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { selectCanonicalSourceId } from "./canonicalSource";

async function insertCandidate(input: {
  id: string;
  createdAt: string;
  signalCount?: number;
  threadCount?: number;
  readyFullText?: boolean;
  textLength?: number;
}): Promise<void> {
  const versionId = `${input.id}-v1`;
  await env.DB.prepare(
    `INSERT INTO sources
     (id, kind, title, reliability, status, quality_status, active_version_id, created_at, updated_at)
     VALUES (?, 'WEB', ?, 'PRIMARY', 'stored', ?, ?, ?, ?)`,
  ).bind(
    input.id,
    input.id,
    input.readyFullText ? "READY" : "REVIEW",
    versionId,
    input.createdAt,
    input.createdAt,
  ).run();
  await env.DB.prepare(
    `INSERT INTO source_versions
     (id, source_id, version, normalized_text, char_count, normalization_status,
      version_origin, review_status, text_scope, extraction_method, created_at)
     VALUES (?, ?, 1, ?, ?, 'READY', 'INITIAL_INGEST', 'ACTIVE', ?, 'MANUAL_TEXT', ?)`,
  ).bind(
    versionId,
    input.id,
    "x".repeat(input.textLength ?? 0),
    input.textLength ?? 0,
    input.readyFullText ? "FULLTEXT" : "PARTIAL",
    input.createdAt,
  ).run();
  for (let index = 0; index < (input.signalCount ?? 0); index += 1) {
    await env.DB.prepare(
      "INSERT INTO user_signals (id, source_id, action, created_at) VALUES (?, ?, 'keep', ?)",
    ).bind(`${input.id}-signal-${index}`, input.id, input.createdAt).run();
  }
  for (let index = 0; index < (input.threadCount ?? 0); index += 1) {
    const threadId = `${input.id}-thread-${index}`;
    await env.DB.prepare(
      "INSERT INTO threads (id, title, status, created_at) VALUES (?, ?, 'SEED', ?)",
    ).bind(threadId, threadId, input.createdAt).run();
    await env.DB.prepare(
      "INSERT INTO thread_links (thread_id, source_id, created_at) VALUES (?, ?, ?)",
    ).bind(threadId, input.id, input.createdAt).run();
  }
}

describe("selectCanonicalSourceId", () => {
  it("orders by user/thread evidence, ready full text, text length, age, and id", async () => {
    const prefix = crypto.randomUUID();
    const ids = {
      weak: `${prefix}-weak`,
      evidence: `${prefix}-evidence`,
      ready: `${prefix}-ready`,
      longer: `${prefix}-longer`,
    };
    await insertCandidate({ id: ids.weak, createdAt: "2026-08-01T00:00:00.000Z", textLength: 200 });
    await insertCandidate({ id: ids.ready, createdAt: "2026-08-02T00:00:00.000Z", readyFullText: true, textLength: 2_000 });
    await insertCandidate({ id: ids.longer, createdAt: "2026-08-03T00:00:00.000Z", readyFullText: true, textLength: 3_000 });
    await insertCandidate({ id: ids.evidence, createdAt: "2026-08-04T00:00:00.000Z", signalCount: 1, textLength: 50 });

    await expect(selectCanonicalSourceId(env.DB, Object.values(ids))).resolves.toBe(ids.evidence);
    await expect(selectCanonicalSourceId(env.DB, [ids.ready, ids.longer])).resolves.toBe(ids.longer);
    await expect(selectCanonicalSourceId(env.DB, [ids.weak])).resolves.toBe(ids.weak);
  });

  it("rejects an empty or missing candidate set", async () => {
    await expect(selectCanonicalSourceId(env.DB, [])).rejects.toThrow("canonical_source_not_found");
    await expect(selectCanonicalSourceId(env.DB, [`missing-${crypto.randomUUID()}`]))
      .rejects.toThrow("canonical_source_not_found");
  });
});
```

- [ ] **Step 3: 테스트가 모듈 부재로 실패하는지 확인한다**

Run:

```bash
pnpm --filter @radar/worker exec vitest run --config vitest.config.ts src/reservoir/canonicalSource.test.ts
```

Expected: FAIL with `Cannot find module './canonicalSource'`.

- [ ] **Step 4: 공통 대표 선정 모듈을 구현한다**

`worker/src/reservoir/canonicalSource.ts`를 생성한다.

```ts
const MAX_SOURCE_IDS_PER_QUERY = 90;

function chunks<T>(items: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    result.push(items.slice(index, index + size));
  }
  return result;
}

export async function selectCanonicalSourceId(
  db: D1Database,
  sourceIds: string[],
): Promise<string> {
  const uniqueIds = [...new Set(sourceIds)];
  const candidates: Array<{
    id: string;
    signalCount: number;
    fullText: number;
    textLength: number;
    createdAt: string;
  }> = [];

  for (const group of chunks(uniqueIds, MAX_SOURCE_IDS_PER_QUERY)) {
    if (group.length === 0) continue;
    const placeholders = group.map(() => "?").join(", ");
    const rows = await db.prepare(
      `SELECT s.id, s.created_at AS createdAt,
              ((SELECT COUNT(*) FROM user_signals us WHERE us.source_id = s.id) +
               (SELECT COUNT(*) FROM thread_links tl WHERE tl.source_id = s.id)) AS signalCount,
              CASE WHEN s.quality_status = 'READY' AND v.text_scope = 'FULLTEXT' THEN 1 ELSE 0 END AS fullText,
              LENGTH(COALESCE(v.normalized_text, '')) AS textLength
       FROM sources s
       LEFT JOIN source_versions v ON v.id = s.active_version_id
       WHERE s.id IN (${placeholders})`,
    ).bind(...group).all<{
      id: string;
      signalCount: number;
      fullText: number;
      textLength: number;
      createdAt: string;
    }>();
    candidates.push(...(rows.results ?? []));
  }

  candidates.sort((left, right) =>
    Number(right.signalCount) - Number(left.signalCount) ||
    Number(right.fullText) - Number(left.fullText) ||
    Number(right.textLength) - Number(left.textLength) ||
    left.createdAt.localeCompare(right.createdAt) ||
    left.id.localeCompare(right.id));

  const canonical = candidates[0];
  if (!canonical) throw new Error("canonical_source_not_found");
  return canonical.id;
}
```

- [ ] **Step 5: refresh의 중복 구현을 제거하고 공통 함수를 import한다**

`worker/src/reservoir/refresh.ts` 상단에 다음 import를 추가한다.

```ts
import { selectCanonicalSourceId } from "./canonicalSource";
```

기존 `async function selectCanonicalSourceId(...)` 전체를 삭제한다. 다른 `chunks` 호출과 `MAX_CANONICAL_SOURCE_IDS_PER_QUERY`는 자동 병합 작성 경로에서 계속 사용하므로 삭제하지 않는다.

- [ ] **Step 6: 새 테스트와 기존 refresh/merge 회귀 테스트를 실행한다**

Run:

```bash
pnpm --filter @radar/worker exec vitest run --config vitest.config.ts src/reservoir/canonicalSource.test.ts src/reservoir/refresh.test.ts src/reservoir/mergeGroups.test.ts
```

Expected: all tests PASS.

- [ ] **Step 7: Task 1을 커밋한다**

```bash
git add worker/src/reservoir/canonicalSource.ts worker/src/reservoir/canonicalSource.test.ts worker/src/reservoir/refresh.ts worker/vitest.config.ts
git commit -m "260829: 대표 자료 선정 규칙 공통화"
```

---

### Task 2: 삭제 사전 점검, R2 정리, D1 영구 삭제 서비스 구현

**Files:**
- Create: `worker/src/reservoir/deleteSource.ts`
- Create: `worker/src/reservoir/deleteSource.test.ts`

**Interfaces:**
- Consumes: `selectCanonicalSourceId`, `Env.DB`, `Env.ORIGINALS`
- Produces:
  - `getSourceDeletionPreview(db: D1Database, sourceId: string): Promise<SourceDeletionPreview | null>`
  - `deleteSourcePermanently(env: Pick<Env, "DB" | "ORIGINALS">, input: DeleteSourceInput): Promise<DeleteSourceResult>`
  - `SourceDeletionError` with stable `code`

- [ ] **Step 1: preview, confirmation, active-work, R2-failure 테스트를 먼저 작성한다**

`worker/src/reservoir/deleteSource.test.ts`를 생성하고 다음 공통 helper와 첫 테스트 묶음을 작성한다.

```ts
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { createLogicalMerge } from "./mergeGroups";
import {
  deleteSourcePermanently,
  getSourceDeletionPreview,
  SourceDeletionError,
} from "./deleteSource";

async function insertSource(id: string, title: string, r2Key: string | null = null): Promise<string> {
  const now = new Date().toISOString();
  const versionId = `${id}-v1`;
  await env.DB.prepare(
    `INSERT INTO sources
     (id, kind, title, reliability, status, quality_status, active_version_id, r2_key, created_at, updated_at)
     VALUES (?, 'WEB', ?, 'PRIMARY', 'stored', 'READY', ?, ?, ?, ?)`,
  ).bind(id, title, versionId, r2Key, now, now).run();
  await env.DB.prepare(
    `INSERT INTO source_versions
     (id, source_id, version, r2_key, normalized_text, char_count, normalization_status,
      version_origin, review_status, text_scope, extraction_method, created_at)
     VALUES (?, ?, 1, ?, 'full text', 9, 'READY', 'INITIAL_INGEST', 'ACTIVE', 'FULLTEXT', 'MANUAL_TEXT', ?)`,
  ).bind(versionId, id, r2Key, now).run();
  if (r2Key) await env.ORIGINALS.put(r2Key, `original:${id}`);
  return versionId;
}

async function expectDeletionError(
  promise: Promise<unknown>,
  code: SourceDeletionError["code"],
): Promise<void> {
  await expect(promise).rejects.toMatchObject({ name: "SourceDeletionError", code });
}

describe("source deletion preflight", () => {
  it("describes standalone, member, and canonical merge impact", async () => {
    const prefix = crypto.randomUUID();
    const canonicalId = `${prefix}-canonical`;
    const memberId = `${prefix}-member`;
    const standaloneId = `${prefix}-standalone`;
    await insertSource(canonicalId, "대표 자료");
    await insertSource(memberId, "병합 구성원");
    await insertSource(standaloneId, "단독 자료");
    await createLogicalMerge(env.DB, {
      canonicalSourceId: canonicalId,
      memberSourceIds: [memberId],
      mode: "MANUAL",
      confidence: 1,
      reasons: ["manual_review"],
    });

    await expect(getSourceDeletionPreview(env.DB, standaloneId)).resolves.toMatchObject({
      sourceId: standaloneId,
      title: "단독 자료",
      mergeRole: "NONE",
      mergeMemberCount: 1,
    });
    await expect(getSourceDeletionPreview(env.DB, canonicalId)).resolves.toMatchObject({
      mergeRole: "CANONICAL",
      mergeMemberCount: 2,
    });
    await expect(getSourceDeletionPreview(env.DB, memberId)).resolves.toMatchObject({
      mergeRole: "MEMBER",
      mergeMemberCount: 2,
    });
  });

  it("rejects missing source and exact-title mismatch before touching R2", async () => {
    const sourceId = `${crypto.randomUUID()}-confirm`;
    await insertSource(sourceId, "정확한 제목", `tests/delete/${sourceId}/v1`);
    const deleteObject = vi.fn();
    const testEnv = { DB: env.DB, ORIGINALS: { delete: deleteObject } } as unknown as Pick<Env, "DB" | "ORIGINALS">;

    await expectDeletionError(
      deleteSourcePermanently(testEnv, { sourceId: `${sourceId}-missing`, confirmTitle: "정확한 제목" }),
      "source_not_found",
    );
    await expectDeletionError(
      deleteSourcePermanently(testEnv, { sourceId, confirmTitle: "정확한 제목 " }),
      "source_delete_confirmation_mismatch",
    );
    expect(deleteObject).not.toHaveBeenCalled();
  });

  it("blocks queued research work and active visual extraction", async () => {
    const sourceId = `${crypto.randomUUID()}-busy`;
    const versionId = await insertSource(sourceId, "작업 중 자료");
    const now = new Date().toISOString();
    await env.DB.prepare(
      `INSERT INTO research_jobs
       (id, kind, status, progress, input_json, dedupe_key, created_at, updated_at)
       VALUES (?, 'DEEP_ANALYSIS', 'QUEUED', 0, ?, ?, ?, ?)`,
    ).bind(`${sourceId}-job`, JSON.stringify({ sourceId }), `${sourceId}-job`, now, now).run();

    await expectDeletionError(
      deleteSourcePermanently(env, { sourceId, confirmTitle: "작업 중 자료" }),
      "source_delete_active_work",
    );

    await env.DB.prepare("UPDATE research_jobs SET status = 'FAILED' WHERE id = ?").bind(`${sourceId}-job`).run();
    await env.DB.prepare(
      `INSERT INTO visual_extraction_runs
       (id, parent_source_id, parent_version_id, origin_kind, status, created_at, updated_at)
       VALUES (?, ?, ?, 'PDF_PAGE_CROP', 'RUNNING', ?, ?)`,
    ).bind(`${sourceId}-run`, sourceId, versionId, now, now).run();
    await expectDeletionError(
      deleteSourcePermanently(env, { sourceId, confirmTitle: "작업 중 자료" }),
      "source_delete_active_work",
    );
  });

  it("collects deduplicated source/version/visual/temp keys and leaves D1 unchanged when R2 fails", async () => {
    const sourceId = `${crypto.randomUUID()}-r2-fail`;
    const sourceKey = `tests/delete/${sourceId}/source`;
    const versionId = await insertSource(sourceId, "R2 실패 자료", sourceKey);
    const now = new Date().toISOString();
    const assetId = `${sourceId}-asset`;
    const visualKey = `tests/delete/${sourceId}/visual`;
    const tempKey = `tests/delete/${sourceId}/temp`;
    await env.DB.prepare(
      `INSERT INTO visual_assets
       (id, parent_source_id, parent_version_id, origin_kind, source_url, asset_role, visual_kind,
        selection_status, rights_status, is_personal_work, assignment_status, storage_state,
        processing_status, created_at, updated_at)
       VALUES (?, ?, ?, 'WEB_EMBED', 'https://example.com/a.jpg', 'REFERENCE', 'PHOTO',
               'SELECTED', 'PERMITTED', 0, 'ASSIGNED', 'ARCHIVAL', 'READY', ?, ?)`,
    ).bind(assetId, sourceId, versionId, now, now).run();
    await env.DB.prepare(
      `INSERT INTO visual_asset_versions
       (id, visual_asset_id, version, variant, r2_key, mime_type, byte_size, content_hash, created_at)
       VALUES (?, ?, 1, 'ORIGINAL', ?, 'image/jpeg', 3, ?, ?)`,
    ).bind(`${assetId}-v1`, assetId, visualKey, `${assetId}-hash`, now).run();
    await env.DB.prepare(
      `INSERT INTO visual_extraction_runs
       (id, parent_source_id, parent_version_id, origin_kind, status, created_at, updated_at)
       VALUES (?, ?, ?, 'WEB_EMBED', 'FAILED', ?, ?)`,
    ).bind(`${sourceId}-run`, sourceId, versionId, now, now).run();
    await env.DB.prepare(
      `INSERT INTO visual_extraction_units
       (id, run_id, unit_number, candidate_key, status, temp_r2_key, created_at)
       VALUES (?, ?, 1, 'candidate-1', 'FAILED', ?, ?)`,
    ).bind(`${sourceId}-unit`, `${sourceId}-run`, tempKey, now).run();
    const deleteObject = vi.fn(async () => { throw new Error("r2 unavailable"); });
    const testEnv = { DB: env.DB, ORIGINALS: { delete: deleteObject } } as unknown as Pick<Env, "DB" | "ORIGINALS">;

    await expectDeletionError(
      deleteSourcePermanently(testEnv, { sourceId, confirmTitle: "R2 실패 자료" }),
      "source_delete_r2_failed",
    );
    expect(deleteObject).toHaveBeenCalledWith(expect.arrayContaining([sourceKey, visualKey, tempKey]));
    expect(await env.DB.prepare("SELECT id FROM sources WHERE id = ?").bind(sourceId).first()).not.toBeNull();
    expect(await env.DB.prepare("SELECT id FROM visual_assets WHERE id = ?").bind(assetId).first()).not.toBeNull();
  });
});
```

- [ ] **Step 2: 테스트가 서비스 부재로 실패하는지 확인한다**

Run:

```bash
pnpm --filter @radar/worker exec vitest run --config vitest.config.ts src/reservoir/deleteSource.test.ts
```

Expected: FAIL with `Cannot find module './deleteSource'`.

- [ ] **Step 3: 오류·preview·삭제 계획 타입을 구현한다**

`worker/src/reservoir/deleteSource.ts` 상단에 다음 계약을 작성한다.

```ts
import { selectCanonicalSourceId } from "./canonicalSource";

export type SourceDeletionMergeRole = "NONE" | "CANONICAL" | "MEMBER";
export type SourceDeletionErrorCode =
  | "source_not_found"
  | "source_delete_confirmation_mismatch"
  | "source_delete_active_work"
  | "source_delete_state_changed"
  | "source_delete_r2_failed"
  | "source_delete_d1_failed";

export interface SourceDeletionPreview {
  sourceId: string;
  title: string;
  mergeRole: SourceDeletionMergeRole;
  mergeMemberCount: number;
}

export interface DeleteSourceInput {
  sourceId: string;
  confirmTitle: string;
}

export interface DeleteSourceMergeResult {
  groupId: string;
  action: "MEMBER_REMOVED" | "CANONICAL_REASSIGNED" | "GROUP_REMOVED";
  canonicalSourceId: string | null;
}

export interface DeleteSourceResult {
  deletedSourceId: string;
  merge: DeleteSourceMergeResult | null;
}

export class SourceDeletionError extends Error {
  readonly code: SourceDeletionErrorCode;

  constructor(code: SourceDeletionErrorCode, cause?: unknown) {
    super(code, cause === undefined ? undefined : { cause });
    this.name = "SourceDeletionError";
    this.code = code;
  }
}

interface ActiveMergeSnapshot {
  groupId: string;
  canonicalSourceId: string;
  role: "CANONICAL" | "MEMBER";
  memberSourceIds: string[];
}

interface SourceDeletionPlan {
  sourceId: string;
  title: string;
  r2Keys: string[];
  merge: ActiveMergeSnapshot | null;
}
```

- [ ] **Step 4: merge snapshot과 preview loader를 구현한다**

같은 파일에 다음 함수를 추가한다.

```ts
async function loadActiveMergeSnapshot(
  db: D1Database,
  sourceId: string,
): Promise<ActiveMergeSnapshot | null> {
  const membership = await db.prepare(
    `SELECT g.id AS groupId, g.canonical_source_id AS canonicalSourceId, m.role
     FROM source_merge_members m
     JOIN source_merge_groups g ON g.id = m.group_id
     WHERE m.source_id = ? AND g.reversed_at IS NULL
     ORDER BY g.created_at DESC LIMIT 1`,
  ).bind(sourceId).first<{
    groupId: string;
    canonicalSourceId: string;
    role: "CANONICAL" | "MEMBER";
  }>();
  if (!membership) return null;
  const members = await db.prepare(
    "SELECT source_id AS sourceId FROM source_merge_members WHERE group_id = ? ORDER BY source_id",
  ).bind(membership.groupId).all<{ sourceId: string }>();
  return {
    ...membership,
    memberSourceIds: (members.results ?? []).map((row) => row.sourceId),
  };
}

export async function getSourceDeletionPreview(
  db: D1Database,
  sourceId: string,
): Promise<SourceDeletionPreview | null> {
  const source = await db.prepare("SELECT id, title FROM sources WHERE id = ?")
    .bind(sourceId).first<{ id: string; title: string }>();
  if (!source) return null;
  const merge = await loadActiveMergeSnapshot(db, sourceId);
  return {
    sourceId: source.id,
    title: source.title,
    mergeRole: merge?.role ?? "NONE",
    mergeMemberCount: merge?.memberSourceIds.length ?? 1,
  };
}
```

- [ ] **Step 5: 활성 작업 검사와 모든 source-owned R2 key 수집을 구현한다**

```ts
async function hasActiveWork(db: D1Database, sourceId: string): Promise<boolean> {
  const row = await db.prepare(
    `SELECT 1 AS active
     FROM research_jobs
     WHERE status IN ('QUEUED', 'RUNNING')
       AND json_extract(input_json, '$.sourceId') = ?
     UNION ALL
     SELECT 1 AS active
     FROM visual_extraction_runs
     WHERE parent_source_id = ? AND status IN ('UPLOADING', 'QUEUED', 'RUNNING')
     UNION ALL
     SELECT 1 AS active
     FROM visual_asset_operations operation
     JOIN visual_assets asset ON asset.id = operation.visual_asset_id
     WHERE (asset.parent_source_id = ?
            OR asset.parent_version_id IN (SELECT id FROM source_versions WHERE source_id = ?))
       AND operation.status = 'PENDING'
     LIMIT 1`,
  ).bind(sourceId, sourceId, sourceId, sourceId).first<{ active: number }>();
  return Boolean(row);
}

async function loadR2Keys(db: D1Database, sourceId: string): Promise<string[]> {
  const rows = await db.prepare(
    `SELECT r2_key AS r2Key FROM sources WHERE id = ? AND r2_key IS NOT NULL
     UNION
     SELECT r2_key AS r2Key FROM source_versions WHERE source_id = ? AND r2_key IS NOT NULL
     UNION
     SELECT version.r2_key AS r2Key
     FROM visual_asset_versions version
     JOIN visual_assets asset ON asset.id = version.visual_asset_id
     WHERE (asset.parent_source_id = ?
            OR asset.parent_version_id IN (SELECT id FROM source_versions WHERE source_id = ?))
       AND version.r2_key IS NOT NULL
     UNION
     SELECT unit.temp_r2_key AS r2Key
     FROM visual_extraction_units unit
     JOIN visual_extraction_runs run ON run.id = unit.run_id
     WHERE run.parent_source_id = ? AND unit.temp_r2_key IS NOT NULL`,
  ).bind(sourceId, sourceId, sourceId, sourceId, sourceId).all<{ r2Key: string }>();
  return [...new Set((rows.results ?? []).map((row) => row.r2Key).filter(Boolean))].sort();
}

async function loadDeletionPlan(db: D1Database, input: DeleteSourceInput): Promise<SourceDeletionPlan> {
  const source = await db.prepare("SELECT id, title FROM sources WHERE id = ?")
    .bind(input.sourceId).first<{ id: string; title: string }>();
  if (!source) throw new SourceDeletionError("source_not_found");
  if (source.title !== input.confirmTitle) {
    throw new SourceDeletionError("source_delete_confirmation_mismatch");
  }
  if (await hasActiveWork(db, input.sourceId)) {
    throw new SourceDeletionError("source_delete_active_work");
  }
  return {
    sourceId: source.id,
    title: source.title,
    r2Keys: await loadR2Keys(db, source.id),
    merge: await loadActiveMergeSnapshot(db, source.id),
  };
}

async function deleteR2Keys(bucket: R2Bucket, keys: string[]): Promise<void> {
  const batchSize = 1_000;
  try {
    for (let index = 0; index < keys.length; index += batchSize) {
      await bucket.delete(keys.slice(index, index + batchSize));
    }
  } catch (error) {
    throw new SourceDeletionError("source_delete_r2_failed", error);
  }
}
```

- [ ] **Step 6: 단독 자료의 모든 직접 D1 의존성과 발견 후보 link 정리 테스트를 추가한다**

`worker/src/reservoir/deleteSource.test.ts`에 다음 테스트를 추가한다. 각 insert는 실제 migration의 NOT NULL/enum을 그대로 채운다.

```ts
describe("source deletion D1 purge", () => {
  it("removes source-owned D1 rows and clears the discovery candidate link", async () => {
    const sourceId = `${crypto.randomUUID()}-purge`;
    const title = "완전 삭제 자료";
    await insertSource(sourceId, title, `tests/delete/${sourceId}/v1`);
    const now = new Date().toISOString();
    const threadId = `${sourceId}-thread`;
    const otherSourceId = `${sourceId}-other`;
    await insertSource(otherSourceId, "보존할 다른 자료");
    await env.DB.prepare("INSERT INTO threads (id, title, status, created_at) VALUES (?, ?, 'SEED', ?)")
      .bind(threadId, threadId, now).run();
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO source_analysis
         (id, source_id, version_id, analysis_type, payload_json, created_at)
         VALUES (?, ?, ?, 'basic', '{}', ?)`,
      ).bind(`${sourceId}-analysis`, sourceId, `${sourceId}-v1`, now),
      env.DB.prepare("INSERT INTO keywords (id, source_id, keyword, created_at) VALUES (?, ?, 'photo', ?)")
        .bind(`${sourceId}-keyword`, sourceId, now),
      env.DB.prepare("INSERT INTO questions (id, source_id, question, created_at) VALUES (?, ?, 'why?', ?)")
        .bind(`${sourceId}-question`, sourceId, now),
      env.DB.prepare("INSERT INTO fragments (id, source_id, text, created_at) VALUES (?, ?, 'fragment', ?)")
        .bind(`${sourceId}-fragment`, sourceId, now),
      env.DB.prepare("INSERT INTO thread_links (thread_id, source_id, created_at) VALUES (?, ?, ?)")
        .bind(threadId, sourceId, now),
      env.DB.prepare("INSERT INTO user_signals (id, source_id, action, created_at) VALUES (?, ?, 'keep', ?)")
        .bind(`${sourceId}-signal`, sourceId, now),
      env.DB.prepare("INSERT INTO processing_jobs (id, source_id, status, created_at, updated_at) VALUES (?, ?, 'analyzed', ?, ?)")
        .bind(`${sourceId}-processing`, sourceId, now, now),
      env.DB.prepare("INSERT INTO source_embeddings (source_id, model, created_at) VALUES (?, 'test-model', ?)")
        .bind(sourceId, now),
      env.DB.prepare("INSERT INTO source_identity_keys (identity_kind, identity_value, source_id, created_at) VALUES ('DOI', ?, ?, ?)")
        .bind(`10.1000/${sourceId}`, sourceId, now),
      env.DB.prepare("INSERT INTO source_fingerprints (source_id, kind, value, created_at) VALUES (?, 'DOI', ?, ?)")
        .bind(sourceId, `10.1000/${sourceId}`, now),
      env.DB.prepare(
        `INSERT INTO discovery_candidates
         (id, title, relevance_score, status, query_used, created_at, provider, source_id)
         VALUES (?, '발견 후보', 0.9, 'KEPT', 'photo', ?, 'openalex', ?)`,
      ).bind(`${sourceId}-candidate`, now, sourceId),
      env.DB.prepare(
        `INSERT INTO source_duplicate_candidates
         (id, left_source_id, right_source_id, decision, score, reasons_json, status, created_at)
         VALUES (?, ?, ?, 'REVIEW', 0.9, '[]', 'PENDING', ?)`,
      ).bind(`${sourceId}-duplicate`, sourceId, otherSourceId, now),
    ]);

    const result = await deleteSourcePermanently(env, { sourceId, confirmTitle: title });

    expect(result).toEqual({ deletedSourceId: sourceId, merge: null });
    expect(await env.DB.prepare("SELECT id FROM sources WHERE id = ?").bind(sourceId).first()).toBeNull();
    for (const table of [
      "source_versions", "source_analysis", "keywords", "questions", "fragments", "thread_links",
      "user_signals", "processing_jobs", "source_embeddings", "source_identity_keys", "source_fingerprints",
    ]) {
      const row = await env.DB.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE source_id = ?`)
        .bind(sourceId).first<{ count: number }>();
      expect(Number(row?.count ?? 0), table).toBe(0);
    }
    await expect(env.DB.prepare("SELECT source_id FROM discovery_candidates WHERE id = ?")
      .bind(`${sourceId}-candidate`).first<{ source_id: string | null }>())
      .resolves.toEqual({ source_id: null });
    expect(await env.DB.prepare("SELECT id FROM source_duplicate_candidates WHERE id = ?")
      .bind(`${sourceId}-duplicate`).first()).toBeNull();
    expect(await env.DB.prepare("SELECT id FROM sources WHERE id = ?").bind(otherSourceId).first()).not.toBeNull();
  });
});
```

- [ ] **Step 7: 병합 구성원·대표·마지막 구성원 테스트를 추가한다**

같은 describe에 다음 세 검증을 추가한다.

```ts
it("deletes one noncanonical member and preserves the remaining group", async () => {
  const prefix = crypto.randomUUID();
  const canonicalId = `${prefix}-canonical`;
  const memberId = `${prefix}-member`;
  await insertSource(canonicalId, "유지 대표");
  await insertSource(memberId, "삭제 구성원");
  const groupId = await createLogicalMerge(env.DB, {
    canonicalSourceId: canonicalId,
    memberSourceIds: [memberId],
    mode: "MANUAL",
    confidence: 1,
    reasons: ["manual_review"],
  });

  await expect(deleteSourcePermanently(env, { sourceId: memberId, confirmTitle: "삭제 구성원" }))
    .resolves.toEqual({
      deletedSourceId: memberId,
      merge: { groupId, action: "MEMBER_REMOVED", canonicalSourceId: canonicalId },
    });
  expect(await env.DB.prepare("SELECT canonical_source_id FROM source_merge_groups WHERE id = ?")
    .bind(groupId).first()).toEqual({ canonical_source_id: canonicalId });
  expect(await env.DB.prepare("SELECT id FROM sources WHERE id = ?").bind(canonicalId).first()).not.toBeNull();
});

it("reassigns a deleted canonical source using the shared ordering", async () => {
  const prefix = crypto.randomUUID();
  const canonicalId = `${prefix}-old-canonical`;
  const weakId = `${prefix}-weak`;
  const strongId = `${prefix}-strong`;
  await insertSource(canonicalId, "기존 대표");
  await insertSource(weakId, "약한 후보");
  await insertSource(strongId, "새 대표");
  const now = new Date().toISOString();
  await env.DB.prepare("INSERT INTO user_signals (id, source_id, action, created_at) VALUES (?, ?, 'keep', ?)")
    .bind(`${strongId}-signal`, strongId, now).run();
  const groupId = await createLogicalMerge(env.DB, {
    canonicalSourceId: canonicalId,
    memberSourceIds: [weakId, strongId],
    mode: "MANUAL",
    confidence: 1,
    reasons: ["manual_review"],
  });

  await expect(deleteSourcePermanently(env, { sourceId: canonicalId, confirmTitle: "기존 대표" }))
    .resolves.toEqual({
      deletedSourceId: canonicalId,
      merge: { groupId, action: "CANONICAL_REASSIGNED", canonicalSourceId: strongId },
    });
  expect(await env.DB.prepare("SELECT canonical_source_id FROM source_merge_groups WHERE id = ?")
    .bind(groupId).first()).toEqual({ canonical_source_id: strongId });
  expect(await env.DB.prepare("SELECT role FROM source_merge_members WHERE group_id = ? AND source_id = ?")
    .bind(groupId, strongId).first()).toEqual({ role: "CANONICAL" });
});

it("removes an active group when the selected source is its only remaining member", async () => {
  const prefix = crypto.randomUUID();
  const sourceId = `${prefix}-last`;
  const deletedMemberId = `${prefix}-already-removed`;
  await insertSource(sourceId, "마지막 구성원");
  await insertSource(deletedMemberId, "선행 구성원");
  const groupId = await createLogicalMerge(env.DB, {
    canonicalSourceId: sourceId,
    memberSourceIds: [deletedMemberId],
    mode: "MANUAL",
    confidence: 1,
    reasons: ["manual_review"],
  });
  await env.DB.prepare("DELETE FROM source_merge_members WHERE group_id = ? AND source_id = ?")
    .bind(groupId, deletedMemberId).run();
  await env.DB.prepare("DELETE FROM source_versions WHERE source_id = ?").bind(deletedMemberId).run();
  await env.DB.prepare("DELETE FROM sources WHERE id = ?").bind(deletedMemberId).run();

  await expect(deleteSourcePermanently(env, { sourceId, confirmTitle: "마지막 구성원" }))
    .resolves.toEqual({
      deletedSourceId: sourceId,
      merge: { groupId, action: "GROUP_REMOVED", canonicalSourceId: null },
    });
  expect(await env.DB.prepare("SELECT id FROM source_merge_groups WHERE id = ?").bind(groupId).first()).toBeNull();
});

it("leaves D1 intact and returns a stable error when the deletion batch fails", async () => {
  const sourceId = `${crypto.randomUUID()}-d1-fail`;
  await insertSource(sourceId, "D1 실패 자료");
  const failingDb = {
    prepare: env.DB.prepare.bind(env.DB),
    batch: vi.fn(async () => { throw new Error("forced D1 failure"); }),
  } as unknown as D1Database;
  await expectDeletionError(
    deleteSourcePermanently(
      { DB: failingDb, ORIGINALS: env.ORIGINALS },
      { sourceId, confirmTitle: "D1 실패 자료" },
    ),
    "source_delete_d1_failed",
  );
  expect(await env.DB.prepare("SELECT id FROM sources WHERE id = ?").bind(sourceId).first()).not.toBeNull();
});

it("detects a title change inside the guarded D1 batch without deleting children", async () => {
  const sourceId = `${crypto.randomUUID()}-state-change`;
  await insertSource(sourceId, "변경 전 제목");
  const staleDb = {
    prepare: env.DB.prepare.bind(env.DB),
    batch: vi.fn(async (statements: D1PreparedStatement[]) => {
      await env.DB.prepare("UPDATE sources SET title = '변경 후 제목' WHERE id = ?").bind(sourceId).run();
      return env.DB.batch(statements);
    }),
  } as unknown as D1Database;
  await expectDeletionError(
    deleteSourcePermanently(
      { DB: staleDb, ORIGINALS: env.ORIGINALS },
      { sourceId, confirmTitle: "변경 전 제목" },
    ),
    "source_delete_state_changed",
  );
  expect(await env.DB.prepare("SELECT id FROM source_versions WHERE source_id = ?")
    .bind(sourceId).first()).not.toBeNull();
});
```

- [ ] **Step 8: 전체 삭제 계약 테스트가 아직 구현되지 않은 함수 때문에 실패하는지 다시 확인한다**

Run:

```bash
pnpm --filter @radar/worker exec vitest run --config vitest.config.ts src/reservoir/deleteSource.test.ts -t "source deletion D1 purge|noncanonical|reassigns|only remaining"
```

Expected: FAIL because `deleteSourcePermanently` is not exported yet. 이 실패를 확인하기 전에는 production DELETE route를 추가하지 않는다.

- [ ] **Step 9: merge state 동일성 검사와 결과 계산을 구현한다**

`worker/src/reservoir/deleteSource.ts`에 다음 helper를 추가한다.

```ts
function mergeFingerprint(merge: ActiveMergeSnapshot | null): string {
  if (!merge) return "NONE";
  return JSON.stringify({
    groupId: merge.groupId,
    canonicalSourceId: merge.canonicalSourceId,
    role: merge.role,
    memberSourceIds: [...merge.memberSourceIds].sort(),
  });
}

async function assertPlanStillCurrent(db: D1Database, plan: SourceDeletionPlan): Promise<void> {
  const source = await db.prepare("SELECT title FROM sources WHERE id = ?")
    .bind(plan.sourceId).first<{ title: string }>();
  const currentMerge = await loadActiveMergeSnapshot(db, plan.sourceId);
  if (!source || source.title !== plan.title || mergeFingerprint(currentMerge) !== mergeFingerprint(plan.merge)) {
    throw new SourceDeletionError("source_delete_state_changed");
  }
  if (await hasActiveWork(db, plan.sourceId)) {
    throw new SourceDeletionError("source_delete_active_work");
  }
}

function deletionGuard(
  db: D1Database,
  plan: SourceDeletionPlan,
): D1PreparedStatement {
  if (!plan.merge) {
    return db.prepare(
      `SELECT CASE WHEN
         EXISTS (SELECT 1 FROM sources WHERE id = ? AND title = ?)
         AND NOT EXISTS (
           SELECT 1 FROM source_merge_members member
           JOIN source_merge_groups merge_group ON merge_group.id = member.group_id
           WHERE member.source_id = ? AND merge_group.reversed_at IS NULL
         )
       THEN 1 ELSE json('source_delete_guard_failed') END AS valid`,
    ).bind(plan.sourceId, plan.title, plan.sourceId);
  }
  return db.prepare(
    `SELECT CASE WHEN
       EXISTS (SELECT 1 FROM sources WHERE id = ? AND title = ?)
       AND EXISTS (
         SELECT 1 FROM source_merge_members member
         JOIN source_merge_groups merge_group ON merge_group.id = member.group_id
         WHERE member.source_id = ?
           AND member.group_id = ?
           AND member.role = ?
           AND merge_group.canonical_source_id = ?
           AND merge_group.reversed_at IS NULL
           AND (SELECT COUNT(*) FROM source_merge_members WHERE group_id = ?) = ?
       )
     THEN 1 ELSE json('source_delete_guard_failed') END AS valid`,
  ).bind(
    plan.sourceId,
    plan.title,
    plan.sourceId,
    plan.merge.groupId,
    plan.merge.role,
    plan.merge.canonicalSourceId,
    plan.merge.groupId,
    plan.merge.memberSourceIds.length,
  );
}

async function mergeMutation(
  db: D1Database,
  plan: SourceDeletionPlan,
): Promise<{ statements: D1PreparedStatement[]; result: DeleteSourceMergeResult | null }> {
  if (!plan.merge) return { statements: [], result: null };
  const remainingIds = plan.merge.memberSourceIds.filter((id) => id !== plan.sourceId);
  if (remainingIds.length === 0) {
    return {
      statements: [
        db.prepare("DELETE FROM source_duplicate_candidates WHERE merge_group_id = ?").bind(plan.merge.groupId),
        db.prepare("DELETE FROM source_merge_members WHERE group_id = ?").bind(plan.merge.groupId),
        db.prepare("DELETE FROM source_merge_groups WHERE id = ?").bind(plan.merge.groupId),
      ],
      result: { groupId: plan.merge.groupId, action: "GROUP_REMOVED", canonicalSourceId: null },
    };
  }
  if (plan.merge.role === "MEMBER") {
    return {
      statements: [
        db.prepare("DELETE FROM source_merge_members WHERE group_id = ? AND source_id = ?")
          .bind(plan.merge.groupId, plan.sourceId),
      ],
      result: {
        groupId: plan.merge.groupId,
        action: "MEMBER_REMOVED",
        canonicalSourceId: plan.merge.canonicalSourceId,
      },
    };
  }
  const canonicalSourceId = await selectCanonicalSourceId(db, remainingIds);
  return {
    statements: [
      db.prepare("UPDATE source_merge_groups SET canonical_source_id = ? WHERE id = ? AND canonical_source_id = ?")
        .bind(canonicalSourceId, plan.merge.groupId, plan.sourceId),
      db.prepare("UPDATE source_merge_members SET role = 'MEMBER' WHERE group_id = ?")
        .bind(plan.merge.groupId),
      db.prepare("UPDATE source_merge_members SET role = 'CANONICAL' WHERE group_id = ? AND source_id = ?")
        .bind(plan.merge.groupId, canonicalSourceId),
      db.prepare("DELETE FROM source_merge_members WHERE group_id = ? AND source_id = ?")
        .bind(plan.merge.groupId, plan.sourceId),
    ],
    result: { groupId: plan.merge.groupId, action: "CANONICAL_REASSIGNED", canonicalSourceId },
  };
}
```

- [ ] **Step 10: 의존성 역순 D1 batch와 공개 delete 함수를 구현한다**

`deleteD1Records`를 다음 구현으로 추가한다. SQL은 source ID만 bind하고 asset/version ID 목록은 subquery로 처리해 D1 parameter limit를 피한다.

```ts
async function deleteD1Records(
  db: D1Database,
  plan: SourceDeletionPlan,
): Promise<DeleteSourceMergeResult | null> {
  await assertPlanStillCurrent(db, plan);
  const merge = await mergeMutation(db, plan);
  const sourceId = plan.sourceId;
  const ownedAssets = `SELECT id FROM visual_assets
    WHERE parent_source_id = ?
       OR parent_version_id IN (SELECT id FROM source_versions WHERE source_id = ?)`;
  const historicalCanonicalGroups = `SELECT id FROM source_merge_groups
    WHERE canonical_source_id = ? AND reversed_at IS NOT NULL`;
  const statements: D1PreparedStatement[] = [
    deletionGuard(db, plan),
    db.prepare("UPDATE discovery_candidates SET source_id = NULL WHERE source_id = ?").bind(sourceId),
    db.prepare(
      `DELETE FROM visual_relations
       WHERE related_source_id = ?
          OR from_visual_asset_id IN (${ownedAssets})
          OR to_visual_asset_id IN (${ownedAssets})`,
    ).bind(sourceId, sourceId, sourceId, sourceId, sourceId),
    db.prepare(`DELETE FROM visual_embeddings WHERE visual_asset_id IN (${ownedAssets})`)
      .bind(sourceId, sourceId),
    db.prepare(`DELETE FROM visual_analyses WHERE visual_asset_id IN (${ownedAssets})`)
      .bind(sourceId, sourceId),
    db.prepare(`DELETE FROM visual_asset_operations WHERE visual_asset_id IN (${ownedAssets})`)
      .bind(sourceId, sourceId),
    db.prepare(`DELETE FROM visual_asset_versions WHERE visual_asset_id IN (${ownedAssets})`)
      .bind(sourceId, sourceId),
    db.prepare(`DELETE FROM visual_assets WHERE id IN (${ownedAssets})`)
      .bind(sourceId, sourceId),
    db.prepare(
      `DELETE FROM visual_extraction_units
       WHERE run_id IN (SELECT id FROM visual_extraction_runs WHERE parent_source_id = ?)`,
    ).bind(sourceId),
    db.prepare("DELETE FROM visual_extraction_runs WHERE parent_source_id = ?").bind(sourceId),
    db.prepare("DELETE FROM source_analysis WHERE source_id = ?").bind(sourceId),
    db.prepare("DELETE FROM keywords WHERE source_id = ?").bind(sourceId),
    db.prepare("DELETE FROM questions WHERE source_id = ?").bind(sourceId),
    db.prepare("DELETE FROM fragments WHERE source_id = ?").bind(sourceId),
    db.prepare("DELETE FROM thread_links WHERE source_id = ?").bind(sourceId),
    db.prepare("DELETE FROM user_signals WHERE source_id = ?").bind(sourceId),
    db.prepare("DELETE FROM processing_jobs WHERE source_id = ?").bind(sourceId),
    db.prepare("DELETE FROM source_embeddings WHERE source_id = ?").bind(sourceId),
    db.prepare("DELETE FROM source_identity_keys WHERE source_id = ?").bind(sourceId),
    db.prepare("DELETE FROM source_fingerprints WHERE source_id = ?").bind(sourceId),
    db.prepare(
      "DELETE FROM source_duplicate_candidates WHERE left_source_id = ? OR right_source_id = ?",
    ).bind(sourceId, sourceId),
    db.prepare(
      `DELETE FROM source_duplicate_candidates WHERE merge_group_id IN (${historicalCanonicalGroups})`,
    ).bind(sourceId),
    db.prepare(
      `DELETE FROM source_merge_members WHERE group_id IN (${historicalCanonicalGroups})`,
    ).bind(sourceId),
    db.prepare(
      `DELETE FROM source_merge_groups WHERE id IN (${historicalCanonicalGroups})`,
    ).bind(sourceId),
    db.prepare(
      "DELETE FROM source_merge_members WHERE source_id = ? AND group_id IN (SELECT id FROM source_merge_groups WHERE reversed_at IS NOT NULL)",
    ).bind(sourceId),
    ...merge.statements,
    db.prepare("DELETE FROM source_versions WHERE source_id = ?").bind(sourceId),
    db.prepare("DELETE FROM sources WHERE id = ?").bind(sourceId),
  ];
  try {
    await db.batch(statements);
    return merge.result;
  } catch (error) {
    if (error instanceof SourceDeletionError) throw error;
    try {
      const current = await db.prepare("SELECT title FROM sources WHERE id = ?")
        .bind(plan.sourceId).first<{ title: string }>();
      const currentMerge = await loadActiveMergeSnapshot(db, plan.sourceId);
      if (!current || current.title !== plan.title || mergeFingerprint(currentMerge) !== mergeFingerprint(plan.merge)) {
        throw new SourceDeletionError("source_delete_state_changed", error);
      }
    } catch (inspectionError) {
      if (inspectionError instanceof SourceDeletionError) throw inspectionError;
    }
    throw new SourceDeletionError("source_delete_d1_failed", error);
  }
}
```

Implementation note: `ownedAssets` is repeated with its own two binds each time. Do not replace these with a JavaScript `IN (...)` list; large sources must not hit D1's bind limit.

같은 파일 마지막에 공개 orchestration 함수를 추가한다. R2가 모두 정리되기 전에는 `deleteD1Records`를 호출하지 않는다.

```ts
export async function deleteSourcePermanently(
  env: Pick<Env, "DB" | "ORIGINALS">,
  input: DeleteSourceInput,
): Promise<DeleteSourceResult> {
  const plan = await loadDeletionPlan(env.DB, input);
  await deleteR2Keys(env.ORIGINALS, plan.r2Keys);
  const merge = await deleteD1Records(env.DB, plan);
  return { deletedSourceId: plan.sourceId, merge };
}
```

- [ ] **Step 11: 시각 자산 전체와 R2 실제 삭제 성공 테스트를 추가한다**

Task 2의 R2 fixture를 성공 bucket으로 실행하는 테스트를 추가한다. 최소 assertions는 다음과 같다.

```ts
it("deletes visual descendants and all existing R2 objects", async () => {
  const sourceId = `${crypto.randomUUID()}-visual-success`;
  const sourceKey = `tests/delete/${sourceId}/source`;
  const versionId = await insertSource(sourceId, "시각 포함 자료", sourceKey);
  const fixture = await insertVisualDeletionFixture(sourceId, versionId);
  await deleteSourcePermanently(env, { sourceId, confirmTitle: "시각 포함 자료" });
  expect(await env.ORIGINALS.get(sourceKey)).toBeNull();
  expect(await env.ORIGINALS.get(fixture.visualKey)).toBeNull();
  expect(await env.ORIGINALS.get(fixture.tempKey)).toBeNull();
  expect(await env.DB.prepare("SELECT id FROM sources WHERE id = ?").bind(sourceId).first()).toBeNull();
  expect(await env.DB.prepare("SELECT id FROM visual_assets WHERE id = ?").bind(fixture.assetId).first()).toBeNull();
  expect(await env.DB.prepare("SELECT id FROM visual_extraction_runs WHERE parent_source_id = ?")
    .bind(sourceId).first()).toBeNull();
});
```

R2 failure 테스트의 asset/version/unit fixture를 다음 helper로 추출해 성공 테스트에서도 그대로 사용한다.

```ts
async function insertVisualDeletionFixture(sourceId: string, versionId: string): Promise<{
  assetId: string;
  visualKey: string;
  tempKey: string;
}> {
  const now = new Date().toISOString();
  const assetId = `${sourceId}-asset`;
  const visualKey = `tests/delete/${sourceId}/visual`;
  const tempKey = `tests/delete/${sourceId}/temp`;
  const runId = `${sourceId}-run`;
  await env.DB.prepare(
    `INSERT INTO visual_assets
     (id, parent_source_id, parent_version_id, origin_kind, source_url, asset_role, visual_kind,
      selection_status, rights_status, is_personal_work, assignment_status, storage_state,
      processing_status, created_at, updated_at)
     VALUES (?, ?, ?, 'WEB_EMBED', 'https://example.com/a.jpg', 'REFERENCE', 'PHOTO',
             'SELECTED', 'PERMITTED', 0, 'ASSIGNED', 'ARCHIVAL', 'READY', ?, ?)`,
  ).bind(assetId, sourceId, versionId, now, now).run();
  await env.DB.prepare(
    `INSERT INTO visual_asset_versions
     (id, visual_asset_id, version, variant, r2_key, mime_type, byte_size, content_hash, created_at)
     VALUES (?, ?, 1, 'ORIGINAL', ?, 'image/jpeg', 3, ?, ?)`,
  ).bind(`${assetId}-v1`, assetId, visualKey, `${assetId}-hash`, now).run();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO visual_analyses
       (id, visual_asset_id, visual_version_id, analysis_type, provenance_class,
        payload_json, cost_usd, review_status, created_at)
       VALUES (?, ?, ?, 'AUTO_SUGGESTION', 'INTERPRETATION', '{}', 0, 'PENDING', ?)`,
    ).bind(`${assetId}-analysis`, assetId, `${assetId}-v1`, now),
    env.DB.prepare(
      `INSERT INTO visual_embeddings
       (id, visual_asset_id, visual_version_id, basis, model_id, dimensions, vector_id, created_at)
       VALUES (?, ?, ?, 'ANALYSIS_TEXT', 'test-model', 3, ?, ?)`,
    ).bind(`${assetId}-embedding`, assetId, `${assetId}-v1`, `${assetId}-vector`, now),
    env.DB.prepare(
      `INSERT INTO visual_relations
       (id, from_visual_asset_id, related_source_id, relation_kind, created_by, created_at)
       VALUES (?, ?, ?, 'SOURCE_CONTEXT', 'USER', ?)`,
    ).bind(`${assetId}-relation`, assetId, sourceId, now),
    env.DB.prepare(
      `INSERT INTO visual_asset_operations
       (id, visual_asset_id, operation_kind, from_state, to_state, status, created_at, finished_at)
       VALUES (?, ?, 'DELETE_CAPSULE', 'ARCHIVAL', 'TEXT_ONLY', 'SUCCEEDED', ?, ?)`,
    ).bind(`${assetId}-operation`, assetId, now, now),
  ]);
  await env.DB.prepare(
    `INSERT INTO visual_extraction_runs
     (id, parent_source_id, parent_version_id, origin_kind, status, created_at, updated_at)
     VALUES (?, ?, ?, 'WEB_EMBED', 'FAILED', ?, ?)`,
  ).bind(runId, sourceId, versionId, now, now).run();
  await env.DB.prepare(
    `INSERT INTO visual_extraction_units
     (id, run_id, unit_number, candidate_key, status, temp_r2_key, created_at)
     VALUES (?, ?, 1, 'candidate-1', 'FAILED', ?, ?)`,
  ).bind(`${sourceId}-unit`, runId, tempKey, now).run();
  await env.ORIGINALS.put(visualKey, "visual");
  await env.ORIGINALS.put(tempKey, "temp");
  return { assetId, visualKey, tempKey };
}
```

R2 failure 테스트의 inline fixture를 이 helper 호출로 교체한다. 성공 테스트에서는 반환된 `visualKey`, `tempKey`가 모두 `ORIGINALS.get(...) === null`인지 확인한다. 또한 `visual_assets`, `visual_asset_versions`, `visual_analyses`, `visual_embeddings`, `visual_relations`, `visual_asset_operations`, `visual_extraction_runs`, `visual_extraction_units` 각각에 fixture ID가 남지 않았는지 assertion을 작성한다. 테스트 helper는 fixture 구성만 담당하며 production 삭제 함수를 호출하지 않는다.

- [ ] **Step 12: 전체 deletion service 테스트와 typecheck를 실행한다**

Run:

```bash
pnpm --filter @radar/worker exec vitest run --config vitest.config.ts src/reservoir/deleteSource.test.ts src/reservoir/canonicalSource.test.ts src/reservoir/refresh.test.ts src/reservoir/mergeGroups.test.ts
pnpm --filter @radar/worker run typecheck
```

Expected: all tests PASS and TypeScript exits 0.

- [ ] **Step 13: Task 2를 커밋한다**

```bash
git add worker/src/reservoir/deleteSource.ts worker/src/reservoir/deleteSource.test.ts
git commit -m "260829: 저장소 원본과 연결 데이터 영구 삭제"
```

---

### Task 3: Reservoir 상세 preview와 DELETE API 계약 추가

**Files:**
- Modify: `worker/src/routes/reservoir.ts:1-20,435-530`
- Modify: `worker/src/routes/reservoir.test.ts`

**Interfaces:**
- Consumes: `getSourceDeletionPreview`, `deleteSourcePermanently`, `SourceDeletionError`
- Produces:
  - `GET /api/reservoir/:sourceId` field `deletion`
  - `DELETE /api/reservoir/:sourceId` with `{ confirmTitle: string }`

- [ ] **Step 1: route validation과 상태 매핑 테스트를 추가한다**

`worker/src/routes/reservoir.test.ts`에 DELETE helper와 테스트를 추가한다.

```ts
async function deleteRequest(path: string, body: unknown, bindings: Env = env): Promise<Response> {
  return app.request(path, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }, bindings);
}

describe("reservoir permanent deletion route", () => {
  it("exposes merge deletion impact in source detail", async () => {
    const sourceId = `${crypto.randomUUID()}-detail-delete`;
    await insertSource({ id: sourceId, title: "삭제 preview" });
    const response = await app.request(`/api/reservoir/${sourceId}`, undefined, env);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      deletion: { sourceId, title: "삭제 preview", mergeRole: "NONE", mergeMemberCount: 1 },
    });
  });

  it("rejects an invalid body and an exact-title mismatch", async () => {
    const sourceId = `${crypto.randomUUID()}-route-confirm`;
    await insertSource({ id: sourceId, title: "정확한 제목" });
    const invalid = await deleteRequest(`/api/reservoir/${sourceId}`, {});
    expect(invalid.status).toBe(400);
    await expect(invalid.json()).resolves.toMatchObject({ error: "invalid_source_delete_confirmation" });
    const mismatch = await deleteRequest(`/api/reservoir/${sourceId}`, { confirmTitle: "다른 제목" });
    expect(mismatch.status).toBe(409);
    await expect(mismatch.json()).resolves.toMatchObject({ error: "source_delete_confirmation_mismatch" });
  });

  it("returns only deletion identifiers on success", async () => {
    const sourceId = `${crypto.randomUUID()}-route-success`;
    await insertSource({ id: sourceId, title: "API 삭제" });
    const response = await deleteRequest(`/api/reservoir/${sourceId}`, { confirmTitle: "API 삭제" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ deletedSourceId: sourceId, merge: null });
  });

  it("maps R2 failure to 502 without exposing keys or raw errors", async () => {
    const sourceId = `${crypto.randomUUID()}-route-r2`;
    await insertSource({ id: sourceId, title: "R2 route 실패" });
    await env.DB.prepare("UPDATE sources SET r2_key = ? WHERE id = ?")
      .bind(`tests/delete/${sourceId}/secret`, sourceId).run();
    const failingEnv = {
      DB: env.DB,
      ORIGINALS: { delete: async () => { throw new Error("secret/key/path"); } },
    } as unknown as Env;
    const response = await deleteRequest(
      `/api/reservoir/${sourceId}`,
      { confirmTitle: "R2 route 실패" },
      failingEnv,
    );
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "source_delete_r2_failed" });
  });
});
```

- [ ] **Step 2: 새 route 테스트가 404/응답 누락으로 실패하는지 확인한다**

Run:

```bash
pnpm --filter @radar/worker exec vitest run --config vitest.config.ts src/routes/reservoir.test.ts -t "reservoir permanent deletion route"
```

Expected: FAIL because DELETE route and `deletion` field do not exist.

- [ ] **Step 3: 서비스 import와 DELETE route를 구현한다**

`worker/src/routes/reservoir.ts`에 import를 추가한다.

```ts
import {
  deleteSourcePermanently,
  getSourceDeletionPreview,
  SourceDeletionError,
} from "../reservoir/deleteSource";
```

`GET /:sourceId`보다 앞에 다음 route를 추가한다.

```ts
reservoir.delete("/:sourceId", async (c) => {
  const body = (await readJson<{ confirmTitle?: unknown }>(c)) ?? {};
  if (typeof body.confirmTitle !== "string" || body.confirmTitle.length === 0) {
    return c.json({ error: "invalid_source_delete_confirmation" }, 400);
  }
  try {
    const result = await deleteSourcePermanently(c.env, {
      sourceId: c.req.param("sourceId"),
      confirmTitle: body.confirmTitle,
    });
    return c.json(result);
  } catch (error) {
    if (!(error instanceof SourceDeletionError)) throw error;
    if (error.code === "source_not_found") return c.json({ error: error.code }, 404);
    if (error.code === "source_delete_r2_failed") return c.json({ error: error.code }, 502);
    if (error.code === "source_delete_d1_failed") return c.json({ error: error.code }, 500);
    return c.json({ error: error.code }, 409);
  }
});
```

- [ ] **Step 4: 상세 응답에 deletion preview를 추가한다**

`GET /:sourceId`에서 `src` 존재 확인 직후 다음을 실행한다.

```ts
const deletion = await getSourceDeletionPreview(c.env.DB, id);
if (!deletion) return c.json({ error: "not_found" }, 404);
```

마지막 응답 객체에 다음 field를 추가한다.

```ts
deletion,
```

- [ ] **Step 5: route 및 전체 worker 테스트를 실행한다**

Run:

```bash
pnpm --filter @radar/worker exec vitest run --config vitest.config.ts src/routes/reservoir.test.ts src/reservoir/deleteSource.test.ts
pnpm --filter @radar/worker run typecheck
```

Expected: all tests PASS and typecheck exits 0.

- [ ] **Step 6: Task 3을 커밋한다**

```bash
git add worker/src/routes/reservoir.ts worker/src/routes/reservoir.test.ts
git commit -m "260829: 저장소 영구 삭제 API와 상태 계약"
```

---

### Task 4: 접근 가능한 제목 확인 삭제 모달 구현

**Files:**
- Create: `web/src/components/reservoir/SourceDeleteDialog.tsx`
- Create: `web/src/components/reservoir/SourceDeleteDialog.test.tsx`

**Interfaces:**
- Consumes: `useModalAccessibility`
- Produces: `SourceDeleteDialog` component and `SourceDeleteDialogProps`

- [ ] **Step 1: 확인 입력, 병합 안내, focus/escape, pending 테스트를 작성한다**

`web/src/components/reservoir/SourceDeleteDialog.test.tsx`를 생성한다.

```tsx
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import SourceDeleteDialog from "./SourceDeleteDialog";

const baseProps = {
  open: true,
  sourceId: "source-1",
  title: "자료 A",
  mergeRole: "NONE" as const,
  mergeMemberCount: 1,
  pending: false,
  error: "",
  onClose: vi.fn(),
  onConfirm: vi.fn(),
};

describe("SourceDeleteDialog", () => {
  it("requires the exact title and submits it", async () => {
    const onConfirm = vi.fn();
    render(<SourceDeleteDialog {...baseProps} onConfirm={onConfirm} />);
    const dialog = screen.getByRole("dialog", { name: "자료 영구 삭제" });
    const confirm = within(dialog).getByRole("button", { name: "영구 삭제" });
    expect(confirm).toBeDisabled();
    await userEvent.type(within(dialog).getByLabelText("확인을 위해 자료 제목 입력"), "자료 A ");
    expect(confirm).toBeDisabled();
    await userEvent.clear(within(dialog).getByLabelText("확인을 위해 자료 제목 입력"));
    await userEvent.type(within(dialog).getByLabelText("확인을 위해 자료 제목 입력"), "자료 A");
    expect(confirm).toBeEnabled();
    await userEvent.click(confirm);
    expect(onConfirm).toHaveBeenCalledWith("자료 A");
  });

  it("explains canonical reassignment and member-only deletion", () => {
    const { rerender } = render(
      <SourceDeleteDialog {...baseProps} mergeRole="CANONICAL" mergeMemberCount={3} />,
    );
    expect(screen.getByText(/남은 2개 자료 중 새 대표를 선정/)).toBeInTheDocument();
    rerender(<SourceDeleteDialog {...baseProps} mergeRole="MEMBER" mergeMemberCount={3} />);
    expect(screen.getByText(/이 자료만 병합 그룹에서 제거/)).toBeInTheDocument();
  });

  it("focuses the title input, closes on Escape, and locks controls while pending", async () => {
    const onClose = vi.fn();
    const { rerender } = render(<SourceDeleteDialog {...baseProps} onClose={onClose} />);
    const input = screen.getByLabelText("확인을 위해 자료 제목 입력");
    expect(input).toHaveFocus();
    await userEvent.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledOnce();
    rerender(<SourceDeleteDialog {...baseProps} pending onClose={onClose} />);
    expect(screen.getByLabelText("확인을 위해 자료 제목 입력")).toBeDisabled();
    expect(screen.getByRole("button", { name: "삭제 중…" })).toBeDisabled();
    await userEvent.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("shows a retryable error without closing", () => {
    render(<SourceDeleteDialog {...baseProps} error="원본 저장소 정리에 실패했습니다. 다시 시도해 주세요." />);
    expect(screen.getByRole("alert")).toHaveTextContent("원본 저장소 정리에 실패했습니다.");
  });
});
```

- [ ] **Step 2: 테스트가 component 부재로 실패하는지 확인한다**

Run:

```bash
pnpm --filter @radar/web exec vitest run src/components/reservoir/SourceDeleteDialog.test.tsx
```

Expected: FAIL with module-not-found.

- [ ] **Step 3: 모달 component를 구현한다**

`web/src/components/reservoir/SourceDeleteDialog.tsx`를 생성한다.

```tsx
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useModalAccessibility } from "../reading/modalAccessibility";

export interface SourceDeleteDialogProps {
  open: boolean;
  sourceId: string;
  title: string;
  mergeRole: "NONE" | "CANONICAL" | "MEMBER";
  mergeMemberCount: number;
  pending: boolean;
  error: string;
  onClose: () => void;
  onConfirm: (confirmTitle: string) => void | Promise<void>;
}

function mergeMessage(role: SourceDeleteDialogProps["mergeRole"], count: number): string {
  if (role === "CANONICAL" && count > 1) {
    return `현재 병합 그룹의 대표 자료입니다. 삭제 후 남은 ${count - 1}개 자료 중 새 대표를 선정합니다.`;
  }
  if (role === "MEMBER") {
    return "이 자료만 병합 그룹에서 제거하며 대표 자료와 다른 구성원은 보존합니다.";
  }
  return "다른 자료와 병합 관계가 없는 단독 자료입니다.";
}

export default function SourceDeleteDialog(props: SourceDeleteDialogProps) {
  const { open, sourceId, title, mergeRole, mergeMemberCount, pending, error, onClose, onConfirm } = props;
  const [confirmTitle, setConfirmTitle] = useState("");
  const layerRef = useRef<HTMLDivElement | null>(null);
  const dialogRef = useRef<HTMLElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const safeClose = () => { if (!pending) onClose(); };

  useEffect(() => {
    if (open) setConfirmTitle("");
  }, [open, sourceId]);

  const { handleKeyDown } = useModalAccessibility({
    open,
    dialogRef,
    layerRef,
    onClose: safeClose,
    getInitialFocusTarget: () => inputRef.current,
    initialFocusDeps: [sourceId],
  });

  if (!open || !globalThis.document.body) return null;
  return createPortal(
    <div ref={layerRef} className="source-delete-layer">
      <button
        type="button"
        className="source-delete-dialog__scrim"
        aria-label="자료 삭제 닫기"
        disabled={pending}
        onClick={safeClose}
      />
      <section
        ref={dialogRef}
        className="source-delete-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="source-delete-title"
        aria-describedby="source-delete-description"
        tabIndex={-1}
        onKeyDown={handleKeyDown}
      >
        <h2 id="source-delete-title">자료 영구 삭제</h2>
        <p id="source-delete-description">
          원문, 모든 버전, 분석, 키워드·질문·메모, 연결된 시각 자료와 R2 파일을 삭제합니다. 이 작업은 되돌릴 수 없습니다.
        </p>
        <div className="source-delete-dialog__source"><span>삭제 대상</span><strong>{title}</strong></div>
        <p className="source-delete-dialog__merge">{mergeMessage(mergeRole, mergeMemberCount)}</p>
        <label htmlFor="source-delete-confirmation">
          확인을 위해 자료 제목 입력
          <input
            ref={inputRef}
            id="source-delete-confirmation"
            value={confirmTitle}
            disabled={pending}
            autoComplete="off"
            onChange={(event) => setConfirmTitle(event.target.value)}
          />
        </label>
        {error && <p className="source-delete-dialog__error" role="alert">{error}</p>}
        <div className="source-delete-dialog__actions">
          <button type="button" className="ui-button-secondary" disabled={pending} onClick={safeClose}>취소</button>
          <button
            type="button"
            className="ui-button-danger"
            disabled={pending || confirmTitle !== title}
            onClick={() => void onConfirm(confirmTitle)}
          >
            {pending ? "삭제 중…" : "영구 삭제"}
          </button>
        </div>
      </section>
    </div>,
    globalThis.document.body,
  );
}
```

- [ ] **Step 4: component 테스트와 web typecheck를 실행한다**

Run:

```bash
pnpm --filter @radar/web exec vitest run src/components/reservoir/SourceDeleteDialog.test.tsx
pnpm --filter @radar/web run typecheck
```

Expected: all tests PASS and typecheck exits 0.

- [ ] **Step 5: Task 4를 커밋한다**

```bash
git add web/src/components/reservoir/SourceDeleteDialog.tsx web/src/components/reservoir/SourceDeleteDialog.test.tsx
git commit -m "260829: 제목 확인형 자료 삭제 모달"
```

---

### Task 5: Reservoir 상세 화면에 삭제 동선 연결

**Files:**
- Modify: `web/src/views/ReservoirView.tsx:47-78,221-270,350-380,820-885`
- Modify: `web/src/views/ReservoirView.test.tsx`
- Modify: `web/src/styles/views.css:1-35,341`

**Interfaces:**
- Consumes: detail payload `deletion`, `SourceDeleteDialog`, DELETE API
- Produces: 상세 위험 영역, 성공 후 목록 복귀·reload, 안정적인 사용자 오류 문구

- [ ] **Step 1: view fixture에 deletion payload와 DELETE mock 상태를 추가한다**

`web/src/views/ReservoirView.test.tsx`의 `sourceDetail`에 다음 field를 추가한다.

```ts
deletion: {
  sourceId: "source-1",
  title: "자료 A",
  mergeRole: "NONE" as const,
  mergeMemberCount: 1,
},
```

test module state에 다음을 추가하고 `beforeEach`에서 초기화한다.

```ts
let deleteResult: { status: number; body: Record<string, unknown> };
let pendingDelete: Promise<Response> | null;

deleteResult = { status: 200, body: { deletedSourceId: "source-1", merge: null } };
pendingDelete = null;
```

fetch stub의 source detail 분기보다 앞에 다음 분기를 넣는다.

```ts
if (url === "/api/reservoir/source-1" && init?.method === "DELETE") {
  if (pendingDelete) return pendingDelete;
      if (deleteResult.status === 200 || deleteResult.body.error === "source_not_found") {
        reservoirItems = reservoirItems.filter((item) => item.id !== "source-1");
      }
  return Promise.resolve(new Response(JSON.stringify(deleteResult.body), { status: deleteResult.status }));
}
```

- [ ] **Step 2: 성공·오류·pending UI 테스트를 먼저 추가한다**

```tsx
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
```

- [ ] **Step 3: 새 view 테스트가 삭제 UI 부재로 실패하는지 확인한다**

Run:

```bash
pnpm --filter @radar/web exec vitest run src/views/ReservoirView.test.tsx -t "permanently deletes|storage cleanup failure|locks the delete dialog"
```

Expected: FAIL because `자료 삭제` button does not exist.

- [ ] **Step 4: SourceDetail 타입, 상태, 오류 번역, API action을 구현한다**

`ReservoirView.tsx`에 import를 추가한다.

```ts
import SourceDeleteDialog from "../components/reservoir/SourceDeleteDialog";
```

`SourceDetail`에 다음 field를 추가한다.

```ts
deletion: {
  sourceId: string;
  title: string;
  mergeRole: "NONE" | "CANONICAL" | "MEMBER";
  mergeMemberCount: number;
};
```

component state와 request ref를 추가한다.

```ts
const [deleteOpen, setDeleteOpen] = useState(false);
const [deletePending, setDeletePending] = useState(false);
const [deleteError, setDeleteError] = useState("");
const deleteRequest = useRef(0);
```

`resetSelection()`에 다음 초기화를 추가한다.

```ts
setDeleteOpen(false);
setDeletePending(false);
setDeleteError("");
deleteRequest.current += 1;
```

component 바깥 helper로 오류 번역을 추가한다.

```ts
function sourceDeleteErrorMessage(code: string): string {
  if (code === "source_delete_confirmation_mismatch") return "자료 제목이 변경됐습니다. 상세 화면을 다시 불러와 주세요.";
  if (code === "source_delete_active_work") return "이 자료의 처리 작업이 진행 중입니다. 작업이 끝난 뒤 다시 시도해 주세요.";
  if (code === "source_delete_state_changed") return "병합 또는 자료 상태가 변경됐습니다. 상세 화면을 다시 불러와 주세요.";
  if (code === "source_delete_r2_failed") return "원본 저장소 정리에 실패했습니다. 자료는 삭제되지 않았습니다.";
  if (code === "source_not_found") return "이미 삭제된 자료입니다.";
  return "자료를 삭제하지 못했습니다. 잠시 후 다시 시도해 주세요.";
}
```

component 안에 action을 추가한다.

```ts
async function deleteCurrentSource(confirmTitle: string) {
  if (!detail) return;
  const sourceId = String(detail.source.id);
  const requestId = deleteRequest.current + 1;
  deleteRequest.current = requestId;
  setDeletePending(true);
  setDeleteError("");
  try {
    const response = await fetch(`/api/reservoir/${encodeURIComponent(sourceId)}`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ confirmTitle }),
    });
    const data = await response.json() as { error?: string; deletedSourceId?: string };
    if (deleteRequest.current !== requestId || selectedIdRef.current !== sourceId) return;
    if (response.status === 404 && data.error === "source_not_found") {
      setItems((current) => current.filter((item) => item.id !== sourceId));
      startInteraction();
      resetSelection();
      setMsg("이미 삭제된 자료라 저장소 목록을 새로 불러왔습니다.");
      await load(filterIntentRef.current);
      return;
    }
    if (!response.ok) throw new Error(data.error ?? "source_delete_failed");
    setItems((current) => current.filter((item) => item.id !== sourceId));
    startInteraction();
    resetSelection();
    setMsg("자료를 영구 삭제했습니다.");
    await load(filterIntentRef.current);
  } catch (error) {
    if (deleteRequest.current !== requestId || selectedIdRef.current !== sourceId) return;
    setDeleteError(sourceDeleteErrorMessage(error instanceof Error ? error.message : "source_delete_failed"));
  } finally {
    if (deleteRequest.current === requestId) setDeletePending(false);
  }
}
```

주의: 성공 경로에서 `resetSelection()`이 `deleteRequest.current`를 증가시키므로 `finally`가 새 화면 state를 덮어쓰지 않는다. `load(filterIntentRef.current)`는 현재 필터 세대를 그대로 사용한다.

- [ ] **Step 5: 상세 위험 영역과 dialog를 render한다**

`ReadingPane`과 source visual panel 뒤, document fragment 안에 다음 위험 영역을 추가한다.

```tsx
{detail && <section className="source-delete-zone" aria-labelledby="source-delete-zone-title">
  <div>
    <h3 id="source-delete-zone-title">위험 영역</h3>
    <p>이 자료의 원본, 분석, 버전과 연결된 시각 자료를 영구 삭제합니다.</p>
  </div>
  <button
    type="button"
    className="ui-button-danger-outline"
    disabled={actionPending || deepPending || pdfExtractionPending}
    onClick={() => { setDeleteError(""); setDeleteOpen(true); }}
  >
    자료 삭제
  </button>
</section>}
```

기존 `DecisionBottomSheet` 다음에 dialog를 추가한다.

```tsx
{detail && <SourceDeleteDialog
  open={deleteOpen}
  sourceId={detail.deletion.sourceId}
  title={detail.deletion.title}
  mergeRole={detail.deletion.mergeRole}
  mergeMemberCount={detail.deletion.mergeMemberCount}
  pending={deletePending}
  error={deleteError}
  onClose={() => { if (!deletePending) { setDeleteOpen(false); setDeleteError(""); } }}
  onConfirm={deleteCurrentSource}
/>}
```

- [ ] **Step 6: danger styles와 mobile layout을 추가한다**

`web/src/styles/views.css`의 공통 button 영역과 source detail 영역에 다음 CSS를 추가한다.

```css
.ui-button-danger, .ui-button-danger-outline { min-height: var(--control-height); border-radius: var(--radius-sm); padding: 8px 13px; font-size: 12px; font-weight: 750; }
.ui-button-danger { border: 1px solid var(--color-danger); background: var(--color-danger); color: white; }
.ui-button-danger-outline { border: 1px solid color-mix(in srgb, var(--color-danger) 55%, var(--color-line)); background: var(--color-surface); color: var(--color-danger); }
.ui-button-danger:disabled, .ui-button-danger-outline:disabled { cursor: not-allowed; opacity: .5; }
.source-delete-zone { display: flex; align-items: center; justify-content: space-between; gap: 18px; max-width: 760px; margin: 32px auto 0; padding: 16px; border: 1px solid color-mix(in srgb, var(--color-danger) 35%, var(--color-line)); background: color-mix(in srgb, var(--color-danger) 4%, var(--color-surface)); }
.source-delete-zone h3, .source-delete-zone p { margin: 0; }
.source-delete-zone h3 { color: var(--color-danger); font-size: 12px; }
.source-delete-zone p { margin-top: 5px; color: var(--color-muted); font-size: 10px; line-height: 1.5; }
.source-delete-layer { position: fixed; z-index: 80; inset: 0; display: grid; place-items: center; padding: 20px; }
.source-delete-dialog__scrim { position: absolute; inset: 0; width: 100%; border: 0; background: rgb(17 18 22 / 58%); }
.source-delete-dialog { position: relative; display: grid; gap: 14px; width: min(520px, 100%); max-height: calc(100vh - 40px); overflow: auto; padding: 24px; border: 1px solid var(--color-line); border-radius: var(--radius-md); background: var(--color-surface); box-shadow: 0 22px 70px rgb(17 18 22 / 28%); }
.source-delete-dialog h2, .source-delete-dialog p { margin: 0; }
.source-delete-dialog h2 { color: var(--color-danger); font-size: 18px; }
.source-delete-dialog > p { color: var(--color-muted); font-size: 11px; line-height: 1.65; }
.source-delete-dialog__source { display: grid; gap: 4px; padding: 12px; background: var(--color-soft); }
.source-delete-dialog__source span { color: var(--color-muted); font-size: 9px; }
.source-delete-dialog__source strong { overflow-wrap: anywhere; font-size: 13px; }
.source-delete-dialog label { display: grid; gap: 6px; font-size: 11px; font-weight: 700; }
.source-delete-dialog input { width: 100%; box-sizing: border-box; min-height: var(--control-height); padding: 8px 10px; border: 1px solid var(--color-line); border-radius: var(--radius-sm); background: var(--color-surface); color: var(--color-ink); font: inherit; }
.source-delete-dialog__error { color: var(--color-danger) !important; }
.source-delete-dialog__actions { display: flex; justify-content: end; gap: 8px; }
```

기존 `@media (max-width: 640px)` block에 다음 rule을 추가한다.

```css
.source-delete-zone { align-items: stretch; flex-direction: column; }
.source-delete-zone button, .source-delete-dialog__actions button { width: 100%; }
.source-delete-dialog__actions { flex-direction: column-reverse; }
```

- [ ] **Step 7: UI tests와 typecheck를 실행한다**

Run:

```bash
pnpm --filter @radar/web exec vitest run src/components/reservoir/SourceDeleteDialog.test.tsx src/views/ReservoirView.test.tsx
pnpm --filter @radar/web run typecheck
```

Expected: all tests PASS and typecheck exits 0.

- [ ] **Step 8: Task 5를 커밋한다**

```bash
git add web/src/views/ReservoirView.tsx web/src/views/ReservoirView.test.tsx web/src/styles/views.css
git commit -m "260829: 저장소 상세 영구 삭제 동선 연결"
```

---

### Task 6: 문서 동기화와 전체 회귀 검증

**Files:**
- Modify: `docs/PROJECT_CONTEXT.md`
- Verify only: repository-wide source and test files

**Interfaces:**
- Consumes: Tasks 1-5의 최종 동작
- Produces: 다음 작업자가 삭제 경계를 오해하지 않는 현재 운영 문서와 검증 증거

- [ ] **Step 1: PROJECT_CONTEXT의 저장소 현재 상태를 갱신한다**

`docs/PROJECT_CONTEXT.md`의 “현재 기능 묶음”에서 Ingestion/Reservoir 설명 끝에 다음 내용을 추가한다.

```markdown
저장소 상세의 `자료 삭제`는 제목을 정확히 재입력해야 실행되는 영구 삭제다. 선택 source가 소유한 source/version/analysis/index/visual D1 행과 R2 원본·시각·임시 객체를 제거한다. 활성 research/visual 작업이 있거나 R2 정리에 실패하면 D1을 변경하지 않는다. 병합 구성원 삭제는 선택 자료에만 적용하고, 대표 삭제 시 기존 대표 선정 규칙으로 남은 구성원을 승격한다. Discovery 후보와 과거 Distill/snapshot/job 결과는 보존하며 후보의 nullable `source_id` 연결만 해제한다. 이 동작은 휴지통이나 `ignore` 판단과 다르며 복구할 수 없다.
```

문서의 migration 범위가 여전히 `0001~0016`으로 적혀 있으면 현재 실제 범위인 `0001~0026`으로 함께 고친다. 새 migration을 만들었다고 기록하지 않는다.

- [ ] **Step 2: focused worker tests를 실행한다**

Run:

```bash
pnpm --filter @radar/worker exec vitest run --config vitest.config.ts src/reservoir/canonicalSource.test.ts src/reservoir/deleteSource.test.ts src/reservoir/refresh.test.ts src/reservoir/mergeGroups.test.ts src/routes/reservoir.test.ts
```

Expected: all selected test files PASS.

- [ ] **Step 3: focused web tests를 실행한다**

Run:

```bash
pnpm --filter @radar/web exec vitest run src/components/reservoir/SourceDeleteDialog.test.tsx src/views/ReservoirView.test.tsx
```

Expected: all selected test files PASS.

- [ ] **Step 4: 전체 검증을 실행한다**

Run:

```bash
pnpm verify
```

Expected: worker tests, web unit tests, workspace typecheck, and production builds all exit 0.

- [ ] **Step 5: 변경 품질과 범위를 검사한다**

Run:

```bash
git diff --check
git status --short
git diff --stat
```

Expected:

- `git diff --check` exits 0.
- unrelated pre-existing dirty files remain untouched.
- no migration, deploy config, model variable, or dependency file was added for this feature.
- no response or UI string contains an R2 key or raw SQL error.

- [ ] **Step 6: Task 6 문서 갱신을 커밋한다**

```bash
git add docs/PROJECT_CONTEXT.md
git commit -m "260829: 저장소 영구 삭제 운영 경계 문서화"
```

- [ ] **Step 7: 최종 커밋 범위와 원격 미반영 상태를 확인한다**

Run:

```bash
git log --oneline -7
git status --short
git rev-list --left-right --count origin/main...HEAD
```

Expected: Task 1-6 커밋이 날짜 규칙에 맞게 보이고, 기존 사용자 파일 외 feature 파일은 clean하다. 이 계획 자체는 push/deploy를 승인하지 않으므로 `HEAD`가 원격보다 앞서 있어도 push하지 않는다.

## Acceptance Checklist

- [ ] 제목이 정확히 일치하지 않으면 R2와 D1 모두 변경되지 않는다.
- [ ] 활성 `research_jobs`, `visual_extraction_runs`, pending visual operation이 있으면 HTTP 409로 차단된다.
- [ ] source/version/visual/temp R2 key가 중복 제거되어 삭제되고, R2 failure 시 D1 batch가 호출되지 않는다.
- [ ] source-owned D1 child가 의존성 역순으로 삭제되고 `sources`가 마지막에 삭제된다.
- [ ] 발견 후보 행은 보존되고 `source_id`만 `NULL`이 된다.
- [ ] `discovery_field_signals`, 완료된 job output, distill/snapshot JSON은 변경되지 않는다.
- [ ] 일반 구성원 삭제는 다른 병합 자료를 보존한다.
- [ ] 대표 삭제는 공통 canonical selector로 새 대표를 정한다.
- [ ] 마지막 구성원 삭제는 더 이상 유효하지 않은 group을 제거한다.
- [ ] API 성공 응답은 `deletedSourceId`와 merge 결과만 반환한다.
- [ ] 모달은 focus trap, Escape, focus restore, pending lock을 제공한다.
- [ ] 성공 후 상세가 닫히고 현재 필터의 저장소 목록이 다시 로드된다.
- [ ] 오류 메시지는 사용자 행동을 설명하고 내부 key/SQL을 노출하지 않는다.
- [ ] `pnpm verify`와 `git diff --check`가 통과한다.
- [ ] push, deploy, remote migration은 실행하지 않는다.
