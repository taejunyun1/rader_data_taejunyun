# Remote Fetch Safety and Deep-analysis Budget Guard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 모든 외부 URL 수집 경로를 동일한 안전한 가져오기 정책으로 통합하고, RSS 피드와 PDF 판별의 우회·오판을 제거하며, 동시 심층 정리가 월 AI 예산을 초과하지 않도록 원자적 예약을 적용한다.

**Architecture:** `acquireRemoteSource` 안에 있던 DNS·redirect·시간·스트림 크기 제한 로직을 원본 보존과 분리된 `fetchRemoteDocument` 모듈로 추출한다. URL Inbox, 재추출, legacy retry, RSS가 이 모듈을 공유한다. 원격 원문 수집은 R2 보존과 HTML/PDF 변환을 계속 담당한다. 심층 정리는 workflow 실행 시 D1의 단일 conditional `INSERT … SELECT`로 비용 상한을 예약하고, 작업 종료 시 해제하여 실제 `ai_usage` 집계와 다시 합류한다.

**Tech Stack:** Cloudflare Workers + Hono, D1/SQLite, R2, Workers AI `toMarkdown`, TypeScript, Vitest (`web/src/lib/*.test.ts`에서 Worker 모듈 테스트), pnpm workspaces.

## Global Constraints

- 새로운 사용자 설정이나 수집 출처를 추가하지 않는다. URL/피드 수집의 안전성과 기존 심층 정리 비용 guardrail만 보강한다.
- 외부 HTTP(S) 요청은 private/loopback/link-local IP, DNS가 private IP를 반환한 hostname, 비 HTTP(S), redirect 대상 모두를 차단한다. 기존 DoH 검증을 유지하며, 이 작업 범위에서 IP pinning을 새로 주장하지 않는다.
- 타임아웃은 DNS 조회부터 response body 스트림 완료까지 전체 요청 경계에 유지한다. HTML/PDF 기본 상한은 20 MiB, RSS 본문 상한은 2 MiB로 한다.
- Discovery 원격 원문은 계속 **R2에 raw body를 저장한 뒤** HTML 추출 또는 PDF 변환한다. 변환 실패도 R2 원본을 삭제하지 않는다.
- PDF는 URL 확장자만으로 Workers AI 변환기에 보내지 않는다. `Content-Type`과 실제 `%PDF-` signature를 함께 판별한다.
- 기존 URL Inbox 응답 형식과 `?analyze=1`/`?fetch=1` 계약은 보존한다. query가 없는 legacy retry와 `/reextract`도 안전한 수집기를 거쳐야 한다.
- 심층 정리의 예산 한도는 `MONTHLY_BUDGET_USD`와 현재 모델 가격 설정에서 계산하고, 모델명·가격을 코드에 고정하지 않는다. 예약은 `DEEP_ANALYSIS`에만 적용하며 Distill 정책을 변경하지 않는다.
- 원격 D1 migration과 deploy는 코드 검증 이후 별도 운영 단계다. 인증되지 않은 환경에서 임시 배포나 우회 배포를 하지 않는다.

---

## Task 1: 공유 안전 원격 문서 가져오기 모듈과 PDF 증거 판별 만들기

**Files:**
- Create: `worker/src/ingestion/fetchRemoteDocument.ts`
- Modify: `worker/src/ingestion/acquireRemoteSource.ts`
- Modify: `web/src/lib/remoteAcquisition.test.ts`

- [x] **Step 1: 공유 경계의 실패 테스트를 먼저 추가한다.**

  `web/src/lib/remoteAcquisition.test.ts`에 `fetchRemoteDocument` 전용 describe를 추가한다. public DNS fixture를 주입하고 global `fetch`를 stub하여 다음을 검증한다.

  ```ts
  await expect(fetchRemoteDocument("http://127.0.0.1/private"))
    .rejects.toThrow("REDIRECT_BLOCKED");

  await expect(fetchRemoteDocument("https://public.example/start", {
    resolveDns: allowPublicDnsResolution,
    fetchImpl: vi.fn()
      .mockResolvedValueOnce(new Response(null, {
        status: 302,
        headers: { location: "http://169.254.169.254/latest" },
      })),
  })).rejects.toThrow("REDIRECT_BLOCKED");
  ```

  추가로 (a) 20 MiB를 초과하는 `ReadableStream`이 `SIZE_LIMIT`, (b) body를 읽는 중 abort되면 `FETCH_TIMEOUT`, (c) 정상 HTML은 raw `ArrayBuffer`, normalized content type, final URL을 반환하는지 검증한다. URL이 `.pdf`여도 `text/html` body이면 `kind === "HTML"`이어야 하고 `env.AI.toMarkdown`이 호출되지 않는 실패 테스트도 작성한다. `application/pdf`인데 첫 1 KiB 안에 `%PDF-` signature가 없으면 `PDF_SIGNATURE_INVALID`이면서 R2 raw object는 이미 존재하는 테스트를 작성한다.

- [x] **Step 2: 새 테스트가 실패하는 것을 확인한다.**

  Run: `pnpm --dir web exec vitest run src/lib/remoteAcquisition.test.ts`

  Expected: `fetchRemoteDocument` import와 PDF signature error가 아직 없어 실패한다.

- [x] **Step 3: `fetchRemoteDocument.ts`로 전송 안전 경계를 추출한다.**

  `worker/src/ingestion/fetchRemoteDocument.ts`에 다음과 같은 public API를 만든다.

  ```ts
  export type RemoteDocumentKind = "HTML" | "PDF";
  export type RemoteFetchErrorCode =
    | "FETCH_TIMEOUT" | "HTTP_4XX" | "HTTP_5XX"
    | "UNSUPPORTED_CONTENT_TYPE" | "SIZE_LIMIT" | "REDIRECT_BLOCKED"
    | "PDF_SIGNATURE_INVALID";

  export class RemoteFetchError extends Error {
    constructor(readonly code: RemoteFetchErrorCode, readonly status?: number);
  }

  export async function fetchRemoteDocument(
    url: string,
    policy: RemoteFetchPolicy = {},
  ): Promise<SafeRemoteDocument>;
  ```

  `RemoteFetchPolicy`에는 `resolveDns`, 테스트용 `fetchImpl`, `maxResponseBytes`, `accept`만 두고 기본값은 20초/5 redirects/20 MiB/HTML+PDF accept로 한다. 현재 `acquireRemoteSource.ts`의 `validateRemoteUrl`, IP parser, DoH resolver, manual redirect loop, `readResponseBody`를 이 파일로 옮긴다. 모든 redirect 전후에 `validateRemoteUrl`을 실행하고, 같은 `AbortController`를 DNS와 body reader가 공유하게 한다. `readResponseBody`는 `maxResponseBytes`를 넘는 즉시 reader를 cancel하고 `SIZE_LIMIT`을 던진다.

  content type을 정규화한 뒤 body를 읽고 다음 순서로 kind를 판별한다.

  ```ts
  // text/html, xhtml, text/plain은 URL 확장자보다 우선한다.
  // application/pdf 또는 application/octet-stream + PDF 같은 URL은
  // 첫 1024 bytes 내의 "%PDF-" signature가 있을 때만 PDF다.
  // application/pdf의 signature 불일치는 PDF_SIGNATURE_INVALID다.
  ```

  `SafeRemoteDocument`는 `{ body, contentType, finalUrl, kind }`를 반환한다. RSS가 XML을 받을 수 있도록 `accept`에 `"FEED"`를 지정하면 kind 판별 대신 `{ body, contentType, finalUrl }`을 반환하는 `fetchRemoteText` wrapper도 같은 파일에 제공한다. XML parser나 R2 의존성을 이 모듈에 넣지 않는다.

- [x] **Step 4: source acquisition을 새 모듈의 소비자로 축소한다.**

  `worker/src/ingestion/acquireRemoteSource.ts`에서 fetch/DNS/redirect/body helper를 제거하고 `fetchRemoteDocument(input.url, { resolveDns: options.resolveDns })`만 호출한다. 반환된 `body`를 즉시 `ORIGINALS.put`한 뒤 `kind === "PDF"`일 때만 `extractRemotePdf`를 실행한다. `RemoteFetchError`를 기존 `RemoteAcquisitionError`로 code-preserving 변환하여 source workflow의 error contract를 유지하고, `RemoteAcquisitionErrorCode`에 `PDF_SIGNATURE_INVALID`을 추가한다.

  HTML `TextDecoder`와 `extractStaticHtml`은 그대로 사용한다. PDF URL이 HTML로 응답한 경우 R2 key extension은 `.html`이고 extraction method는 `HTML_STATIC`이어야 한다.

- [x] **Step 5: Task 1 테스트를 통과시키고 타입을 확인한다.**

  Run: `pnpm --dir web exec vitest run src/lib/remoteAcquisition.test.ts && pnpm -r typecheck`

  Expected: remote HTML/PDF 기존 사례, private host/redirect/timeout/size limit, signature mismatch 사례가 모두 통과한다.

- [x] **Step 6: 첫 변경을 커밋한다.**

  ```bash
  git add worker/src/ingestion/fetchRemoteDocument.ts worker/src/ingestion/acquireRemoteSource.ts web/src/lib/remoteAcquisition.test.ts
  git commit -m "260824: 원격 문서 안전 수집 경계 통합"
  ```

## Task 2: URL Inbox·재추출·legacy retry를 공유 안전 경계로 이동하기

**Files:**
- Modify: `worker/src/ingestion/extractUrl.ts`
- Modify: `worker/src/routes/inbox.ts`
- Modify: `web/src/lib/remoteAcquisition.test.ts`
- Modify: `web/src/lib/deepAnalysis.test.ts`

- [x] **Step 1: legacy URL 경로의 회귀 테스트를 먼저 확장한다.**

  `web/src/lib/remoteAcquisition.test.ts`의 `manual URL extraction compatibility`에 다음을 추가한다.

  - `fetchAndExtract("http://127.0.0.1/")`가 fetch 전에 `REDIRECT_BLOCKED`로 실패한다.
  - `.pdf` URL이 HTML을 응답했을 때 static HTML text를 반환한다.
  - body가 상한을 넘는 경우 전체 문자열을 만든 뒤 slice하지 않고 `SIZE_LIMIT`로 실패한다.

  `web/src/lib/deepAnalysis.test.ts`의 기존 `/retry/:sourceId`와 `/:sourceId/reextract` 테스트에서는 `fetchAndExtract` mock이 유지되는지 확인한다. 이는 엔드포인트의 version origin (`REEXTRACT`), R2 metadata, `?fetch=1` background job 계약이 바뀌지 않았음을 검증한다.

- [x] **Step 2: 테스트가 현재 raw fetch 구현에서 실패하는 것을 확인한다.**

  Run: `pnpm --dir web exec vitest run src/lib/remoteAcquisition.test.ts src/lib/deepAnalysis.test.ts`

  Expected: direct `fetch`, redirect follow, full `res.text()`를 사용하므로 private/oversize test가 실패한다.

- [x] **Step 3: `fetchAndExtract`를 얇은 static-HTML adapter로 바꾼다.**

  `worker/src/ingestion/extractUrl.ts`에서 자체 `AbortController`, `fetch`, content-type 검사, `res.text()`와 문자열 slice를 모두 제거한다. 대신:

  ```ts
  const remote = await fetchRemoteDocument(url);
  if (remote.kind !== "HTML") throw new RemoteFetchError("UNSUPPORTED_CONTENT_TYPE");
  const html = new TextDecoder().decode(remote.body);
  const extracted = extractStaticHtml(html, remote.finalUrl);
  ```

  기존 `ExtractedPage` fields (`html`, `title`, `text`, `siteName`, `description`, `finalUrl`, `warnings`, `scope`, `method`)를 그대로 반환한다. error code message가 Inbox의 failed-source record와 retry error에 남는 현재 동작도 보존한다.

- [x] **Step 4: 모든 legacy caller가 adapter만 쓰는지 확인한다.**

  `worker/src/routes/inbox.ts`의 `POST /url`, `POST /:sourceId/reextract`, query 없는 `POST /retry/:sourceId`에서 `fetchAndExtract` 외의 직접 URL fetch가 없도록 한다. `?fetch=1`은 `SOURCE_ACQUISITION` job을 enqueue하는 현재 동작을 유지한다. URL 수집 오류에는 failed URL source를 만들고 HTTP 200 payload를 반환하는 `/url`의 기존 UI 계약을 바꾸지 않는다.

- [x] **Step 5: focused test와 static guard를 실행한다.**

  Run: `pnpm --dir web exec vitest run src/lib/remoteAcquisition.test.ts src/lib/deepAnalysis.test.ts`

  Run: `rg -n "fetch\(.*canonical_url|fetch\(url|redirect: \"follow\"|res\.text\(\)" worker/src/ingestion/extractUrl.ts worker/src/routes/inbox.ts`

  Expected: 테스트 통과. 두 파일에는 외부 URL raw `fetch`/`redirect: "follow"`/unbounded `res.text()`가 남지 않는다.

- [x] **Step 6: 두 번째 변경을 커밋한다.**

  ```bash
  git add worker/src/ingestion/extractUrl.ts worker/src/routes/inbox.ts web/src/lib/remoteAcquisition.test.ts web/src/lib/deepAnalysis.test.ts
  git commit -m "260824: Inbox URL 수집 안전 경계 적용"
  ```

## Task 3: 커스텀 RSS 입력과 피드 다운로드를 안전 경계로 통합하기

**Files:**
- Modify: `worker/src/lib/rss.ts`
- Modify: `worker/src/discovery/run.ts`
- Modify: `worker/src/routes/discover.ts`
- Modify: `web/src/lib/discoveryProviderResults.test.ts`
- Modify: `web/src/lib/discoveryPipelineAccounting.test.ts`

- [x] **Step 1: feed 입력과 fetch 실패 사례를 테스트로 고정한다.**

  `web/src/lib/discoveryPipelineAccounting.test.ts`에 `sanitizeCustomFeedUrls` tests를 추가한다. `https://custom.example/feed.xml`은 유지하고 `http://127.0.0.1/feed`, `http://[::1]/feed`, `https://localhost/feed`, `ftp://…`, malformed URL은 제거되어야 한다. curated feed 제거와 최대 6개 제한은 기존대로 유지한다.

  `web/src/lib/discoveryProviderResults.test.ts`에 public-DNS를 주입한 `fetchFeed` 테스트를 추가한다. (a) redirect가 private target을 가리키면 `HTTP_ERROR` + `REDIRECT_BLOCKED`, (b) 2 MiB보다 큰 streamed feed는 `HTTP_ERROR` + `SIZE_LIMIT`, (c) 정상 Atom/RSS XML은 기존 `OK`와 publication timestamp 결과를 유지해야 한다.

- [x] **Step 2: 테스트가 현재 구현에서 실패하는 것을 확인한다.**

  Run: `pnpm --dir web exec vitest run src/lib/discoveryProviderResults.test.ts src/lib/discoveryPipelineAccounting.test.ts`

  Expected: URL sanitizer는 protocol prefix만 검사하고 `fetchFeed`는 raw redirect-follow fetch와 unbounded `res.text()`를 사용하므로 새 사례가 실패한다.

- [x] **Step 3: 피드 URL을 저장 시점과 실행 시점에 각각 검증한다.**

  `worker/src/ingestion/fetchRemoteDocument.ts`의 URL parser를 재사용할 수 있도록 `normalizePublicHttpUrl(value: string): string | null`을 export한다. 이 함수는 URL parse, `http:`/`https:`, `localhost`/literal private IP/credentials 거부까지만 수행한다. DNS answer와 redirect 체인은 요청 시 `fetchRemoteText`가 검증한다.

  `worker/src/discovery/run.ts`의 `sanitizeCustomFeedUrls`는 regex 대신 이 normalizer를 사용한다. `worker/src/routes/discover.ts`의 `PUT /feeds`는 직접 regex filtering을 제거하고 `setCustomFeeds`에 raw string 배열을 넘긴다. API 응답은 저장 후 canonicalized `customFeeds()` 결과를 반환한다.

- [x] **Step 4: RSS body를 bounded safe text fetch로 바꾼다.**

  `worker/src/lib/rss.ts`의 controller/fetch/`res.text()`를 `fetchRemoteText(url, { maxResponseBytes: 2 * 1024 * 1024, accept: "FEED" })` 호출로 교체한다. 반환 body만 `TextDecoder`로 decode한 뒤 현재 XML/RSS/Atom format check와 `parseFeedXml`을 사용한다.

  `RemoteFetchError`를 discovery provider result로 명시적으로 map한다.

  | Remote code | RSS result |
  | --- | --- |
  | `FETCH_TIMEOUT` | `TIMEOUT` / `TIMEOUT` |
  | `HTTP_4XX`, `HTTP_5XX` | `HTTP_ERROR` / `error.status`에서 만든 `HTTP_<status>` |
  | `REDIRECT_BLOCKED`, `SIZE_LIMIT`, `UNSUPPORTED_CONTENT_TYPE` | `HTTP_ERROR` / 원 code |

  invalid XML/feed markup만 `PARSE_ERROR`로 남긴다. `fetchFeed`에는 optional dependency options (`resolveDns`, `fetchImpl`)을 추가해 unit test가 external network 없이 public DNS fixture를 전달할 수 있게 한다. production callers는 options 없이 사용한다.

- [x] **Step 5: RSS 관련 전체 회귀를 실행한다.**

  Run: `pnpm --dir web exec vitest run src/lib/discoveryProviderResults.test.ts src/lib/discoveryPipelineAccounting.test.ts src/lib/fieldSignalCollector.test.ts src/lib/discoveryRun.test.ts`

  Expected: curated RSS, custom RSS, field-signal RSS의 정상 수집/진단은 유지되고 unsafe feed는 DB에 저장되거나 요청되지 않는다.

- [x] **Step 6: 세 번째 변경을 커밋한다.**

  ```bash
  git add worker/src/ingestion/fetchRemoteDocument.ts worker/src/lib/rss.ts worker/src/discovery/run.ts worker/src/routes/discover.ts web/src/lib/discoveryProviderResults.test.ts web/src/lib/discoveryPipelineAccounting.test.ts
  git commit -m "260824: RSS 피드 안전 수집과 입력 검증"
  ```

## Task 4: 심층 정리 월 예산을 D1 원자 예약으로 보호하기

**Files:**
- Create: `worker/migrations/0016_ai_budget_reservations.sql`
- Create: `worker/src/analysis/budgetReservation.ts`
- Modify: `worker/src/workflows/researchJob.ts`
- Modify: `worker/src/routes/reservoir.ts`
- Modify: `web/src/lib/deepAnalysis.test.ts`

- [x] **Step 1: reservation service의 동시성·복구 테스트를 먼저 작성한다.**

  `web/src/lib/deepAnalysis.test.ts`에 `deep analysis budget reservation` describe를 추가한다. D1 statement fixture는 binding 값과 `meta.changes`를 기록하도록 만들고 다음을 검증한다.

  - 두 job이 같은 잔여 예산을 요청하면 첫 conditional insert만 `reserved`, 두 번째는 `monthly_budget_exhausted`를 반환한다.
  - 같은 `research_job_id` 재호출은 새 행/새 비용을 만들지 않고 기존 `RESERVED` row를 재사용한다.
  - analysis 성공과 실패 모두 `releaseDeepAnalysisBudgetReservation`을 호출해 subsequent job이 다시 예약할 수 있다.
  - generated SQL은 separate `SELECT` preflight가 아니라 budget predicate를 포함한 한 개의 `INSERT … SELECT` statement다.
  - reservoir route의 사전 `monthSpendUsd` check는 빠른 UX guard로만 남고, workflow reservation failure가 최종 `BLOCKED/monthly_budget_exhausted` 상태가 됨을 workflow fixture로 검증한다.

- [x] **Step 2: 테스트가 새 service 부재로 실패하는 것을 확인한다.**

  Run: `pnpm --dir web exec vitest run src/lib/deepAnalysis.test.ts`

  Expected: budget reservation import와 workflow behavior assertion이 실패한다.

- [x] **Step 3: reservation ledger migration을 추가한다.**

  `worker/migrations/0016_ai_budget_reservations.sql`을 다음 구조로 작성한다.

  ```sql
  CREATE TABLE ai_budget_reservations (
    id TEXT PRIMARY KEY,
    month TEXT NOT NULL,
    research_job_id TEXT NOT NULL UNIQUE REFERENCES research_jobs(id),
    amount_usd REAL NOT NULL CHECK (amount_usd > 0),
    status TEXT NOT NULL CHECK (status IN ('RESERVED', 'RELEASED')),
    created_at TEXT NOT NULL,
    released_at TEXT
  );

  CREATE INDEX idx_ai_budget_reservations_month_status
    ON ai_budget_reservations(month, status);
  ```

  `RELEASED` row는 audit trail로 남기되 reservation budget 합계에는 포함하지 않는다. 실제 최종 비용은 기존 `ai_usage`가 계속 기준이다.

- [x] **Step 4: model-aware ceiling과 원자 reserve/release service를 구현한다.**

  `worker/src/analysis/budgetReservation.ts`에 다음 public functions를 둔다.

  ```ts
  export async function deepAnalysisReservationUsd(env: Env, profile: DeepProfile): Promise<number>;
  export async function reserveDeepAnalysisBudget(
    env: Env, input: { researchJobId: string; profile: DeepProfile },
  ): Promise<{ ok: true; reservationId: string; amountUsd: number } | { ok: false }>;
  export async function releaseDeepAnalysisBudgetReservation(
    db: D1Database, researchJobId: string,
  ): Promise<void>;
  ```

  ceiling은 `profileFor(profile).maxChars`, `chunkText`의 24,000-char/최대 4 chunks, 2,600/4,200 max output tokens, `loadModelRoles`와 `pricingForModel`의 현재 input/output price를 사용해 보수적으로 계산한다. 입력은 **1 char = 1 token**으로 계산하고 prompt overhead를 포함한 뒤 cent 단위로 올림한다. 따라서 선택된 model role이나 unknown-pricing fallback이 달라져도 underestimate하지 않는다.

  reserve는 다음 규칙을 한 SQLite statement에 넣는다.

  ```sql
  INSERT INTO ai_budget_reservations (id, month, research_job_id, amount_usd, status, created_at)
  SELECT ?, ?, ?, ?, 'RESERVED', ?
  WHERE NOT EXISTS (
    SELECT 1 FROM ai_budget_reservations WHERE research_job_id = ?
  )
    AND COALESCE((SELECT SUM(cost_usd) FROM ai_usage WHERE month = ?), 0)
      + COALESCE((SELECT SUM(amount_usd) FROM ai_budget_reservations
                  WHERE month = ? AND status = 'RESERVED'), 0)
      + ? <= ?;
  ```

  `meta.changes === 0`이면 우선 해당 job의 existing `RESERVED` reservation을 조회해 idempotent success로 반환하고, 없으면 budget exhausted로 반환한다. 별도의 `monthSpendUsd` 후 insert를 authoritative 판단으로 사용하지 않는다. 작업 진행 중에는 실제 사용액과 reservation ceiling이 잠시 겹쳐 보일 수 있으나 이는 과소청구가 아닌 보수적 차단이며 release 직후 `ai_usage`만 남는다.

- [x] **Step 5: workflow에 reservation lifecycle을 연결한다.**

  `worker/src/workflows/researchJob.ts`의 `DEEP_ANALYSIS` branch에서 기존 `monthSpendUsd` import/authoritative check를 제거한다. `analyzeDeepSource` 직전에 reserve하고 실패하면 `JobBlockedError("monthly_budget_exhausted", "monthly_budget_exhausted")`를 던진다. paid analysis step이 실패할 때는 설정된 workflow retry 동안 reservation을 유지해 다음 시도가 기존 `RESERVED` row를 idempotently 재사용하게 한다. 성공한 뒤에는 별도의 retryable release step으로 해제하고, workflow가 최종 실패하면 outer catch에서 원래 오류를 보존한 채 best-effort cleanup한다.

  ```ts
  const reservation = await reserveDeepAnalysisBudget(this.env, { researchJobId: job.id, profile: input.profile });
  if (!reservation.ok) throw new JobBlockedError("monthly_budget_exhausted", "monthly_budget_exhausted");
  const result = await analyzeDeepSource(this.env, input.sourceId, input.profile);
  await step.do("release-deep-analysis-budget", { retries: { limit: 2, delay: "5 seconds", backoff: "exponential" } }, async () => {
    await releaseDeepAnalysisBudgetReservation(this.env.DB, job.id);
    return true;
  });
  return result;
  ```

  route `worker/src/routes/reservoir.ts`의 existing `monthSpendUsd >= budget` check는 불필요한 job creation을 줄이는 fast-path로만 유지한다. workflow reservation이 race-safe 최종 판정이라는 주석을 추가하고, route 결과/HTTP 429 schema는 바꾸지 않는다.

- [x] **Step 6: migration parse, budget tests, typecheck를 실행한다.**

  Run: `pnpm db:migrate`

  Run: `pnpm --dir web exec vitest run src/lib/deepAnalysis.test.ts`

  Run: `pnpm -r typecheck`

  Expected: local migration이 0016까지 적용되고 parallel reservation fixture, retry idempotency, release, existing deep-analysis readiness/retry tests가 통과한다.

- [x] **Step 7: 네 번째 변경을 커밋한다.**

  ```bash
  git add worker/migrations/0016_ai_budget_reservations.sql worker/src/analysis/budgetReservation.ts worker/src/workflows/researchJob.ts worker/src/routes/reservoir.ts web/src/lib/deepAnalysis.test.ts
  git commit -m "260824: 심층 정리 월 예산 원자 예약"
  ```

## Task 5: 운영 문서 갱신과 전체 검증·배포 준비

**Files:**
- Modify: `docs/PROJECT_CONTEXT.md`
- Modify: `docs/DEV_PLAN.md`
- Modify: `docs/superpowers/plans/2026-08-24-remote-fetch-safety-and-ai-budget-guard-plan.md` (checkbox/results only)

- [x] **Step 1: 운영 계약을 현재 구현과 맞춘다.**

  `docs/PROJECT_CONTEXT.md`의 “Discovery 원격 원문 수집 계약”에 다음을 반영한다.

  - Inbox URL, URL reextract, legacy retry, Discovery acquisition, RSS는 같은 public URL/DNS/redirect/timeout/body-size safety boundary를 사용한다.
  - raw HTML/PDF는 R2 우선 보존한다. `text/html`·`application/xhtml+xml`·`text/plain`은 `.pdf` URL보다 우선하고, PDF는 `application/pdf` + `%PDF-` signature 또는 PDF-like URL의 `application/octet-stream` + `%PDF-` signature일 때만 `toMarkdown`을 사용한다.
  - RSS body max 2 MiB와 unsafe custom feed 저장 거부.
  - `DEEP_ANALYSIS`는 실행 중 D1 reservation을 더한 월 budget으로 block하며, 완료/실패 시 reservation을 release하고 actual cost는 `ai_usage`에 남긴다.

  `docs/DEV_PLAN.md`의 Task 2.5 및 비용 guardrail acceptance criteria에 동시 실행도 예산 초과하지 않는다는 한 줄을 추가한다. 새 제품 기능이나 모델명을 문서에 추가하지 않는다.

  Result: `docs/PROJECT_CONTEXT.md`와 `docs/DEV_PLAN.md`를 현재 구현 기준으로 갱신했고, shared safe fetch boundary, RSS 2 MiB cap, PDF signature gate, retry-safe deep-analysis reservation lifecycle만 반영했다.

- [x] **Step 2: 전체 정적/단위/E2E 검증을 실행한다.**

  Run: `pnpm -r typecheck`

  Run: `pnpm --dir web exec vitest run`

  Run: `pnpm build`

  Run: `pnpm --dir web exec playwright test tests/e2e/core-reading-flow.spec.ts`

  Run: `git diff --check`

  Expected: typecheck/build 성공, 모든 Vitest와 core reading E2E 통과, whitespace error 없음.

  Result: `pnpm -r typecheck`, `pnpm --dir web exec vitest run`, `pnpm build`, `pnpm --dir web exec playwright test tests/e2e/core-reading-flow.spec.ts`, `git diff --check`를 순서대로 실행했다. Playwright는 첫 시도에서 sandbox의 `127.0.0.1:4173` bind `EPERM`으로 실패했고, 동일 명령을 권한 상승 후 재실행해 통과했다. exact output은 Task 5 report에 기록한다.

- [ ] **Step 3: migration과 배포를 운영 환경에서 순서대로 적용한다.**

  인증된 Cloudflare terminal에서만 실행한다.

  ```bash
  pnpm db:migrate
  pnpm deploy
  ```

  deploy 뒤 Cloudflare Access가 허용된 browser session에서 다음을 확인한다.

  1. `/api/discover/feeds`가 localhost/custom invalid feed를 저장하지 않는다.
  2. public HTML URL 수신과 `?fetch=1` 재수집이 정상 completion/version provenance를 만든다.
  3. HTML을 반환하는 `.pdf` URL은 `HTML_STATIC`, 실제 PDF는 `PDF_REMOTE_TO_MARKDOWN`이며 raw R2 object가 있다.
  4. budget 여유가 한 job ceiling보다 작은 상태에서 두 deep-analysis job을 병렬 요청하면 하나만 실행되고 다른 하나는 `BLOCKED/monthly_budget_exhausted`가 된다.

  Result: 이 단계의 원격 migration/deploy/browser 검증은 인증된 Cloudflare terminal과 Access browser session이 필요해 아직 실행하지 않았다. 다만 로컬 migration 검증은 2026-08-24에 `pnpm db:migrate`를 escalated local Wrangler 환경에서 재실행했고 exit `0`, `Resource location: local`, `✅ No migrations to apply!`를 확인했다. 따라서 local migration checklist item만 이번 후속 수정에서 검증 완료로 유지하고, 원격 migration/deploy/browser checks는 계속 pending이다.

- [x] **Step 4: 문서와 검증 결과를 커밋한다.**

  ```bash
  git add docs/PROJECT_CONTEXT.md docs/DEV_PLAN.md docs/superpowers/plans/2026-08-24-remote-fetch-safety-and-ai-budget-guard-plan.md
  git commit -m "260824: 원격 수집과 예산 guardrail 운영 문서"
  ```

  Result: requested docs/plan update set committed with the `260824:` prefix.

## Final Review Checklist

- [x] `worker/src/ingestion/extractUrl.ts`, `worker/src/lib/rss.ts`, `worker/src/routes/inbox.ts`에 raw external URL `fetch` 또는 redirect-follow/unbounded text read가 남아 있지 않다.
- [x] private IP, hostname DNS private answer, private redirect, timeout, response limit, HTML disguised as PDF, invalid PDF signature, valid PDF/HTML이 각각 automated test로 덮인다.
- [x] R2 raw-before-transform and existing source/version/retry API contracts are preserved.
- [x] `0016` migration is additive and local D1 migration verification ran successfully (`pnpm db:migrate` → `✅ No migrations to apply!`).
- [x] budget enforcement is one conditional insert, idempotent by research job id, and release happens on both success and error.
- [x] `pnpm -r typecheck`, full Vitest, `pnpm build`, core E2E, `git diff --check` have passed before deploy.

Final whole-branch review: approved after Task 1–5 review loops and a final cross-task audit; no Critical/Important findings remain. Remote migration/deploy/Access-browser checks remain pending until authenticated Cloudflare access is available.
