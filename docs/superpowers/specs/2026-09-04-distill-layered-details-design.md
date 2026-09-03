# 착즙 혼합형 상세층 설계

## 배경

현재 착즙은 `distill-v2-terse` 규칙에 따라 생각의 조각을 최대 2문장, 연구·작업 방향을 1문장으로 압축한다. 빠르게 훑기에는 좋지만 판단의 이유, 자료 간 연결, 남은 불확실성, 다음 검증 방법이 결과에 남지 않아 연구를 이어가기에는 정보가 부족하다.

이 변경은 Radar 내부 착즙을 `요약층 + 상세층`으로 확장한다. 홈페이지의 `현재 연구`는 기존 요약층만 공개한다.

## 확정한 방향

- Radar 착즙 화면은 혼합형을 사용한다. 기본 상태에서는 현재 수준의 요약을 보여주고, 각 항목의 상세를 펼치면 근거와 실행 맥락을 보여준다.
- 상세층은 착즙 실행 시 요약층과 한 번에 생성·저장한다. 상세를 펼칠 때 추가 AI 호출을 하지 않는다.
- 홈페이지 projection, 공개 상한, 발행 절차는 변경하지 않는다.
- 기존 착즙 기록은 상세층이 없어도 현재 방식으로 표시한다.
- 별도의 사용자 설정이나 생성 옵션을 추가하지 않는다.

## 목표

1. 착즙의 빠른 스캔 가능성을 유지한다.
2. 핵심 판단마다 왜 그런 판단이 나왔는지 추적할 수 있게 한다.
3. 입력 Reservoir 자료와 종합 해석을 명확히 구분한다.
4. 연구 질문을 실제 조사 방법과 필요한 증거로 연결한다.
5. 연구·작업 방향을 다음 행동으로 옮길 수 있을 만큼 구체화한다.

## 비목표

- 홈페이지에 상세층을 공개하지 않는다.
- 과거 착즙을 AI로 다시 생성하지 않는다.
- 상세 항목을 개별 편집하는 에디터를 만들지 않는다.
- 상세를 위한 별도 AI 버튼이나 사용자 파라미터를 추가하지 않는다.
- Knowledge Graph UI나 새로운 검색 기능을 추가하지 않는다.

## 정보 구조

기존 요약 필드는 그대로 유지한다.

- `keywords`
- `thoughts_fragments`
- `questions`
- `read_next`
- `research_gaps`
- `research_directions`
- `artwork_directions`
- `small_experiment`

새 `details` 필드는 내부 전용이며 선택적이다. 과거 세션과 부분 실패를 허용하기 위해 parser 수준에서는 optional로 둔다. 새 프롬프트 `distill-v3-layered`는 완전한 상세층을 요청한다.

```ts
interface DistillDetails {
  thoughts: Array<{
    summaryIndex: number;
    rationale: string;
    sourceIds: string[];
    uncertainty: string;
    nextCheck: string;
  }>;
  questions: Array<{
    summaryIndex: number;
    whyNow: string;
    method: string;
    evidenceNeeded: string;
    sourceIds: string[];
  }>;
  researchGaps: Array<{
    summaryIndex: number;
    diagnosis: string;
    researchMethod: string;
    sourceIds: string[];
  }>;
  researchDirections: Array<{
    summaryIndex: number;
    rationale: string;
    method: string;
    expectedOutcome: string;
    sourceIds: string[];
  }>;
  artworkDirections: Array<{
    summaryIndex: number;
    rationale: string;
    materials: string[];
    procedure: string;
    observation: string;
    sourceIds: string[];
  }>;
}
```

`summaryIndex`는 해당 기존 배열의 0 기반 위치를 가리킨다. 요약 문장을 상세 객체에 복제하지 않아 두 층이 어긋나는 것을 막는다. 같은 종류 안에서 index는 중복될 수 없고 실제 배열 범위 안에 있어야 한다.

## 생성 규칙

`distill-v3-layered`는 기존 요약을 유지하면서 다음 상세를 함께 생성한다.

- 생각의 조각: 판단 이유 2~4문장, 관련 자료 최대 3개, 불확실성 1~2문장, 다음 확인 1~2문장
- 질문: 지금 중요한 이유, 사용할 조사 방법, 필요한 자료 또는 증거
- 연구 공백: 부족한 지점의 진단과 이를 채울 조사 방법
- 연구 방향: 논리적 배경, 구체적 방법, 예상 산출물
- 작업 방향: 개념적 이유, 재료·매체, 실행 절차, 관찰할 변화

키워드, 다음 읽기, 작은 실험, Counter는 이번 상세층 대상에서 제외한다. `read_next`에는 이미 `why_read`와 `related_question`이 있고, Counter는 자체 구조를 갖고 있기 때문이다.

모든 상세 문장은 `SYNTHESIS`다. `sourceIds`는 근거를 직접 인용했다는 뜻이 아니라 해당 판단을 형성하는 데 연결한 입력 자료를 뜻한다. 원문처럼 보이는 따옴표 표현은 생성 규칙에서 금지한다.

기본 착즙 모델 호출은 한 번으로 유지하고 `maxOutputTokens`를 4,000에서 6,500으로 올린다. 월 `$10` guardrail과 80% 경고·100% 차단은 그대로 적용한다.

## 검증과 부분 실패 처리

서버는 요약층과 상세층을 분리해 검증한다.

1. 기존 필수 요약 필드가 잘못되면 현재와 같이 착즙 전체를 실패 처리한다.
2. `details`가 없으면 유효한 레거시 결과로 받아들인다.
3. 상세 항목의 index가 범위를 벗어나거나 중복되면 해당 항목만 제외한다.
4. `sourceIds` 중 이번 착즙의 `sources_used_json`에 없는 ID는 제거한다.
5. 텍스트 필드가 비어 있거나 타입이 틀리면 해당 상세 항목만 제외한다.
6. 정제 결과 어떤 상세도 남지 않으면 요약층만 저장하고 UI에 상세 버튼을 표시하지 않는다.

상세 실패 때문에 유효한 요약 착즙을 버리거나 별도 복구 AI 호출을 실행하지 않는다. 이는 비용 증가와 전체 결과 손실을 막는다.

Critic은 서버에서 정제한 요약층과 상세층 전체를 검토한다. 기존 Critic 출력 구조는 유지하며, 상세층의 근거 부족·과도한 일반화도 기존 경고 카테고리로 기록한다.

## 화면 설계

기본 문서 목차와 섹션 순서는 유지한다. 상세층이 있는 항목만 아래에 보조 동작을 표시한다.

- 생각의 조각: `근거와 맥락 보기`
- 질문: `왜 중요한지 보기`
- 연구 공백: `진단과 조사 방법 보기`
- 연구 방향: `방법과 예상 결과 보기`
- 작업 방향: `재료와 실행 과정 보기`

한 번에 여러 항목을 펼칠 수 있다. 펼침 상태는 현재 화면의 로컬 상태이며 서버에 저장하지 않는다. 다른 착즙 세션을 열면 모두 접힌 상태로 초기화한다.

상세 패널은 다음 순서로 표시한다.

1. 판단 또는 방향의 설명
2. 연결된 자료 제목과 저장소 상세 링크
3. 남은 불확실성 또는 필요한 증거
4. 다음 확인 방법 또는 실행 절차

연결 자료가 삭제됐거나 현재 조회할 수 없으면 링크를 만들지 않고 `연결 자료를 현재 저장소에서 찾을 수 없습니다.`라고 표시한다. 다른 상세 내용은 그대로 보여준다.

접기·펼치기는 실제 `button`과 `aria-expanded`, `aria-controls`를 사용한다. 키보드와 스크린리더에서도 동일하게 동작해야 한다.

## 데이터 흐름

1. `buildDistillContext`가 기존처럼 입력 자료와 ID를 구성한다.
2. `distill-v3-layered`가 요약층과 상세층을 하나의 JSON으로 반환한다.
3. 요약 parser가 기존 계약을 검증한다.
4. 상세 parser가 index, 텍스트, `sourceIds`를 정제한다.
5. 정제된 결과를 기존 `distill_sessions.output_json`에 저장한다. D1 migration은 필요 없다.
6. 세션 상세 API는 `details`와 연결 자료의 현재 제목·존재 상태를 반환한다.
7. Radar UI는 요약을 먼저 렌더링하고 상세가 있는 항목만 펼침 동작을 제공한다.
8. 홈페이지 projection은 기존 요약 필드만 allowlist로 추출한다.

## 공개와 내보내기

- 홈페이지 preview·publish payload에는 `details`를 포함하지 않는다.
- 홈페이지 키워드 7개, 생각의 조각 5개 등 현재 상한을 유지한다.
- 홈페이지 content hash는 기존 공개 필드만으로 계산하므로 상세층 변경만으로 공개 revision이 바뀌지 않는다.
- 마크다운 내보내기에는 Radar 내부 연구 기록의 완결성을 위해 상세층을 포함한다. 각 요약 바로 아래에 상세 설명, 연결 자료, 불확실성, 다음 확인을 중첩 목록으로 출력한다.

## 코드 경계

- 공통 `DistillOutput`·`DistillDetails` 계약은 `shared/`로 이동해 Worker와 Web이 같은 타입을 사용한다.
- Worker의 prompt는 생성 형식만 책임진다.
- Worker의 상세 parser는 AI 출력 정제와 source allowlist만 책임진다.
- 세션 route는 저장된 상세와 연결 자료 표시 정보를 조합한다.
- Web의 상세 패널은 표현과 접근성 상태만 책임진다.
- 홈페이지 projection은 공통 타입을 읽되 기존 공개 allowlist를 유지한다.

`DistillView.tsx`에 상세 마크업을 직접 모두 추가하지 않고, 항목별 공통 레이아웃을 담당하는 `DistillDetailDisclosure` 컴포넌트와 종류별 데이터를 화면 모델로 바꾸는 helper를 분리한다.

## 테스트 기준

### Worker

- `distill-v3-layered` prompt가 상세 필드와 길이 규칙을 요구한다.
- 유효한 상세층은 요약 index와 source ID를 보존한다.
- 범위 밖 index, 중복 index, 알 수 없는 source ID를 정제한다.
- 상세층이 없거나 전부 무효여도 기존 요약 결과는 유효하다.
- Critic 입력에 정제된 상세층이 포함된다.
- 마크다운 export에는 상세층이 포함된다.
- 홈페이지 projection 결과에는 `details`가 없고 기존 hash·상한이 유지된다.

### Web

- 상세가 없는 과거 세션에는 펼침 버튼이 나타나지 않는다.
- 상세가 있는 항목은 기본적으로 접혀 있다.
- 버튼으로 열고 닫을 수 있으며 `aria-expanded`가 함께 바뀐다.
- 연결 자료 제목과 저장소 링크가 표시된다.
- 찾을 수 없는 연결 자료는 비활성 안내로 표시된다.
- 세션을 바꾸면 펼침 상태가 초기화된다.
- 홈페이지 미리보기에는 요약층만 표시된다.

## 완료 기준

- 새 착즙은 현재와 같은 요약을 먼저 보여주며 상세가 있는 항목만 펼칠 수 있다.
- 상세 패널에서 판단 이유, 연결 자료, 불확실성·필요 증거, 다음 확인·실행 방법을 확인할 수 있다.
- 과거 착즙, 재착즙 선택, Critic, Counter, 다음 읽기, 홈페이지 발행이 회귀 없이 동작한다.
- 홈페이지의 공개 데이터 계약과 현재 노출량은 변경되지 않는다.
- 추가 사용자 설정과 상세 전용 AI 호출이 없다.
