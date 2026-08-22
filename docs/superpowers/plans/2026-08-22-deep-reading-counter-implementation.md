# 저장소 심층 정리와 착즙 반대 관점 구현 계획

> 이 문서는 구현 순서와 검증 기준만 정의한다. 작성 시점에는 실제 기능 코드를 변경하지 않는다.

**목표:** 저장소 자료를 최대 96,000자까지 심층 정리하고, 착즙에서 기본 켜짐인 반대 관점 토글과 정합성 검증 결과를 제공한다.

**구조:** 기본 분석과 심층 정리를 `source_analysis.analysis_type`으로 격리한다. 심층 정리는 품질 프로필을 서버 환경변수로 해석하는 bounded map-reduce 파이프라인을 사용한다. 착즙은 기존 Counter 호출을 옵션화하고, 생성 후 의미 검증과 최대 1회 교정을 거쳐 세션에 상태와 함께 저장한다.

**기술:** Cloudflare Workers/Hono, D1, AI Gateway/OpenAI, Vite/React, Vitest

설계 기준: `docs/superpowers/specs/2026-08-22-deep-reading-counter-design.md`

---

## Task 1. 분석 종류 분리 회귀 테스트

**파일**

- 수정: `worker/src/routes/reservoir.ts`
- 수정: `worker/src/routes/reservoir.test.ts` 또는 기존 Worker route 테스트 파일
- 수정: `worker/src/routes/export.ts`
- 수정: `worker/src/routes/search.ts`
- 수정: `worker/src/lib/embed.ts`
- 수정: `worker/src/distill/context.ts`

**작업**

1. 동일 source에 최신 `deep`과 이전 `basic` 행이 있을 때 기존 소비자가 `basic`을 선택하는 실패 테스트를 먼저 작성한다.
2. `ORDER BY created_at DESC LIMIT 1` 형태의 분석 조회를 모두 점검한다.
3. 검색, 임베딩, export, 착즙 컨텍스트는 `analysis_type = 'basic'`을 명시한다.
4. 저장소 상세 API만 `basic`과 `deep`을 각각 조회한다.
5. 테스트를 실행해 심층 분석 추가가 기존 파이프라인 결과를 바꾸지 않는지 확인한다.

**검증**

```bash
pnpm --filter worker test
pnpm --filter worker typecheck
```

**커밋 예시**

```bash
git commit -m "260822: 기본·심층 분석 조회 경계 분리"
```

## Task 2. 품질 프로필과 모델 설정 확장

**파일**

- 수정: `worker/src/env-secrets.d.ts`
- 수정: `worker/wrangler.jsonc`
- 수정: `worker/src/lib/openai.ts`
- 생성: `worker/src/analysis/deepProfiles.ts`
- 생성: `worker/src/analysis/deepProfiles.test.ts`

**작업**

1. 클라이언트가 보낼 수 있는 값은 `precision | maximum` 두 개뿐이라는 테스트를 작성한다.
2. `precision`은 `MODEL_HIGH`, `maximum`은 신규 `MODEL_DEEP`으로 서버에서 해석한다.
3. 원시 모델 문자열을 API body에서 받거나 UI에 저장하지 않는다.
4. `callOpenAi`가 `deep` tier와 해당 비용 설정을 기록할 수 있도록 확장한다.
5. 배포 전 Cloudflare 변수에 `MODEL_DEEP`과 필요한 단가 변수를 설정하도록 운영 체크리스트에 추가한다.

**검증**

```bash
pnpm --filter worker test -- deepProfiles
pnpm --filter worker typecheck
```

## Task 3. 긴 본문 구간 분할과 인용 검증

**파일**

- 생성: `worker/src/analysis/deepPrompt.ts`
- 생성: `worker/src/analysis/deepAnalyze.ts`
- 생성: `worker/src/analysis/deepAnalyze.test.ts`

**작업**

1. 문단 경계를 우선하는 분할 함수 테스트를 작성한다.
2. 최대 96,000자, 최대 4개 구간, 구간 간 짧은 중첩 규칙을 구현한다.
3. 짧은 본문은 단일 호출, 긴 본문은 구간 분석 후 최종 통합을 사용한다.
4. 출력 스키마를 `overview`, `arguments`, `structure`, `quotes`, `connections`, `researchUses`, `limitations`로 검증한다.
5. `quotes`는 정규화된 원문에 실제로 포함된 문자열만 남긴다.
6. 결과 payload에 읽은 글자 수, 전체 글자 수, 구간 수, 프로필을 기록한다.

**검증 사례**

- 20,000자 자료는 한 구간으로 처리
- 70,000자 자료는 누락 없이 여러 구간으로 처리
- 120,000자 자료는 96,000자만 읽고 잘림 메타 표시
- 모델이 만든 가짜 인용은 결과에서 제거
- 본문 없음/40자 미만은 AI 호출 없이 설명 가능한 오류 반환

## Task 4. 심층 정리 API와 이력 저장

**파일**

- 수정: `worker/src/routes/reservoir.ts`
- 수정: `worker/src/routes/reservoir.test.ts`
- 수정: `worker/src/index.ts` 라우팅 확인

**작업**

1. 잘못된 프로필, 없는 source, 본문 없음, 월 예산 초과 테스트를 작성한다.
2. `POST /api/reservoir/:sourceId/deep-analysis`를 추가한다.
3. 성공 결과를 `source_analysis`에 `analysis_type='deep'`, `provenance='INTERPRETATION'`으로 추가한다.
4. 기존 deep 행을 갱신하지 않고 매 실행마다 새 이력을 만든다.
5. `GET /api/reservoir/:sourceId`가 `analysis`, `deepAnalysis`, `deepAnalysisHistory`를 구분해 반환한다.
6. 비용은 `ai_usage.purpose='deep_analysis'`로 집계한다.

**검증**

```bash
pnpm --filter worker test -- reservoir
pnpm --filter worker typecheck
```

## Task 5. 저장소 심층 정리 UI

**파일**

- 수정: `web/src/views/ReservoirView.tsx`
- 수정: `web/src/views/ReservoirView.test.tsx`
- 수정: `web/src/components/reading/ReadingPane.tsx`
- 수정: `web/src/components/reading/ReadingPane.test.tsx`
- 수정: `web/src/components/reading/types.ts`
- 생성: `web/src/components/reading/DeepAnalysisPanel.tsx`
- 생성: `web/src/components/reading/DeepAnalysisPanel.test.tsx`
- 수정: `web/src/styles/reading.css`

**작업**

1. `정밀` 기본 선택, `최고 정밀` 선택, 로딩 중 중복 실행 방지 테스트를 먼저 작성한다.
2. 읽기 화면의 시스템 해석 영역에 품질 드롭다운과 `심층 정리하기` CTA를 배치한다.
3. API 요청에는 프로필 enum만 보낸다.
4. TaskCenter/상태 문구로 본문 읽기, 통합, 검수 상태를 표시한다.
5. 성공 토스트 후 상세 데이터를 다시 불러오고 `심층 정리` 패널을 펼친다.
6. 결과 메타와 이전 정리 이력을 표시한다.
7. 기본 분석이 없어도 심층 정리를 실행할 수 있게 하되 원문 텍스트가 없으면 명확히 안내한다.

**접근성 검증**

- 드롭다운에 연결된 label 존재
- 로딩과 성공 상태가 `role=status` 또는 `aria-live`로 전달
- 키보드만으로 선택·실행·이력 열기 가능

## Task 6. Counter 토글 데이터 모델과 API

**파일**

- 생성: `worker/migrations/0012_distill_counter_option.sql`
- 수정: `worker/src/routes/distill.ts`
- 수정: `worker/src/distill/run.ts`
- 수정: `worker/src/routes/distill.test.ts` 또는 기존 distill route 테스트

**마이그레이션**

```sql
ALTER TABLE distill_sessions ADD COLUMN counter_enabled INTEGER NOT NULL DEFAULT 1;
```

**작업**

1. body에서 `includeCounter`가 생략되면 `true`로 해석하는 테스트를 작성한다.
2. `includeCounter=false`이면 Counter 관련 AI 호출이 0회인지 검증한다.
3. `runDistill` 옵션에 `includeCounter`를 추가한다.
4. 실행 값을 `counter_enabled`에 저장하고 세션 상세 API에 `counterEnabled`로 반환한다.
5. 기존 세션은 모두 켜짐으로 표시한다.
6. Counter를 끈 세션은 `counter_output_json = NULL`로 저장한다.

**검증**

```bash
pnpm --filter worker test -- distill
pnpm --filter worker typecheck
```

## Task 7. 정면 반대 생성과 정합성 검증

**파일**

- 수정: `worker/src/distill/prompts.ts`
- 수정: `worker/src/distill/run.ts`
- 생성: `worker/src/distill/counterValidation.ts`
- 생성: `worker/src/distill/counterValidation.test.ts`

**작업**

1. Counter 스키마에 `dominant_claim`, `opposing_thesis`, `incompatibility`, `conditions`, `axes`, `suggestions`, `validation`을 정의한다.
2. 원 착즙의 핵심 주장, Critic 경고, source fragment를 Counter 프롬프트에 전달한다.
3. 보완·절충·주제 전환을 반대로 인정하지 않는 프롬프트 규칙을 추가한다.
4. `counterStrength`는 명제의 반대 여부가 아니라 실행 방향의 급진성과 낯섦만 조절하도록 의미를 좁힌다.
5. 별도 고품질 검증 호출로 정면성, 내부 정합성, 추적 가능성, 근거 무결성, 허수아비 오류를 판정한다.
6. 검증 실패 시 피드백을 넣어 Counter를 한 번만 교정한다.
7. 두 번째 실패 시 `status='unverified'`와 이유를 저장하고 제안을 확정 결과처럼 표시하지 않는다.
8. 논문·책·텍스트 grounding은 기존 OpenAlex 확인 함수를 재사용해 확인된 항목만 확정 표시한다.

**핵심 테스트**

- `자동화가 핵심이다 → 자동화를 조금 줄인다`는 정면 반대로 탈락
- `자동화가 핵심이다 → 인간의 수작업만이 지식 생산의 근거다`는 추적 가능한 반대 후보
- 원 착즙에 없는 중심 주장을 만들어 뒤집으면 탈락
- 존재 검증 실패 고유명사는 확정 grounding에서 제외
- 1차 실패 후 교정 성공/최종 실패 흐름 모두 검증

## Task 8. 착즙 토글과 반대 관점 결과 UI

**파일**

- 수정: `web/src/views/DistillView.tsx`
- 수정: `web/src/views/DistillView.test.tsx`
- 생성: `web/src/components/distill/CounterSection.tsx`
- 생성: `web/src/components/distill/CounterSection.test.tsx`
- 수정: `web/src/components/distill/DocumentOutline.tsx`
- 수정: `web/src/styles/views.css`

**작업**

1. 최초 화면에서 토글이 켜져 있는 테스트를 작성한다.
2. 새 착즙과 다시 착즙 request body에 `includeCounter`를 보낸다.
3. 과거 세션을 열면 세션 메타에 포함/제외 상태를 표시한다.
4. 검증된 Counter가 있으면 목차와 본문에 `정면 반대 관점` 섹션을 표시한다.
5. `현재 중심 주장 → 정반대 명제`를 가장 먼저 읽히게 배치하고, 충돌 지점과 반대 작업 방향을 뒤에 둔다.
6. 검증 실패는 경고 카드로 표시하고 생성 내용을 확정 제안처럼 노출하지 않는다.
7. 토글을 끈 세션에는 `이번 착즙에서는 반대 관점을 제외했습니다`만 표시한다.

## Task 9. 통합 회귀·비용·배포 검증

**파일**

- 수정: `docs/SPEC.md`
- 수정: `docs/DEV_PLAN.md`
- 수정: `docs/PROJECT_CONTEXT.md`
- 수정: 필요 시 `docs/V1_GUIDE.md`

**작업**

1. Counter를 `항상 자동`에서 `기본 켜짐 토글`로 바꾼 사용자 결정을 Source of Truth 문서에 반영한다.
2. 전체 단위 테스트와 타입 검사를 실행한다.
3. production build를 실행한다.
4. 로컬 브라우저에서 저장소 심층 정리와 착즙 토글 두 흐름을 검증한다.
5. D1 migration을 원격에 적용하기 전 대상 DB와 migration 상태를 확인한다.
6. Cloudflare 환경의 `MODEL_DEEP` 및 비용 변수를 확인한다.
7. 배포 후 실제 source 1건으로 `정밀`을 실행하고 이력·비용·글자 수를 확인한다.
8. 착즙을 토글 켜짐/꺼짐으로 각각 실행해 AI 호출 수와 세션 표시를 확인한다.
9. `main`에 날짜 형식 커밋으로 push한다.

**최종 명령**

```bash
pnpm test
pnpm typecheck
pnpm build
pnpm db:migrate
pnpm deploy
git push origin main
```

**최종 수동 확인표**

- [ ] `정밀`과 `최고 정밀`은 실제 모델명이 아닌 품질 이름으로 보인다.
- [ ] 심층 정리에서 기본 분석보다 긴 본문을 읽은 글자 수가 보인다.
- [ ] basic/deep 이력이 서로 덮어쓰이지 않는다.
- [ ] 착즙의 `반대 관점 포함`은 기본 켜짐이다.
- [ ] 토글을 끄면 Counter 비용과 결과가 없다.
- [ ] 토글을 켜면 검증된 정반대 명제가 문서에 나타난다.
- [ ] 검증 실패 결과는 확정 제안으로 보이지 않는다.
- [ ] 월 사용량 한도가 두 고비용 기능에 적용된다.
