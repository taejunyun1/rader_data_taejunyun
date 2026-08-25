# Visual Reservoir 멀티모달 설계

- 날짜: 2026-08-25
- 상태: 사용자 승인 설계
- 적용 대상: Research Radar
- 선행 원칙: Reservoir First, Provenance First, Cloudflare-first, Model-agnostic

## 1. 목적

Research Radar의 연구 단위를 텍스트 자료에서 시각 작업물까지 확장한다. 사진을 단순 캡션이나 태그로 축소하지 않고, 원본·작업 맥락·형식적 관찰·사용자 판단을 분리해 축적한다.

1차는 개인 작업 이미지를 수집·분석·검수·관리한다. 2차는 PDF, 웹 원문, 발견 자료 안의 사진·도판·그래프·다이어그램을 검출하고 연구 가치가 있는 시각 자료만 선별한다.

성공 기준은 다음과 같다.

- 개인 이미지가 작업·시리즈 맥락에 연결된 상태로 보존된다.
- AI 제안과 사용자가 검수한 설명을 분리해 관리한다.
- 원본을 삭제해도 작은 시각 표현과 구조화 분석을 선택적으로 남길 수 있다.
- PDF·웹의 장식 이미지와 핵심 도판을 구분하고, 각 이미지가 원문 위치와 연결된다.
- 원문을 읽던 흐름을 끊지 않고 이미지 판단을 완료할 수 있다.

## 2. 범위와 배포 순서

### Delivery 1 — 개인 이미지 Visual Reservoir

- JPG, PNG, WebP 등 정지 이미지의 단일·일괄 업로드
- R2 원본 보존과 분석용 WebP 생성
- 작업·시리즈 연결
- 구조화 시각 분석과 사용자 검수
- Visual Capsule 저장 상태 전환
- 저장소의 인라인 이미지 판단과 시각 보드

### Delivery 2 — 문서·웹 시각 자료 추출

- 업로드·발견 PDF의 페이지별 이미지 후보 검출
- 웹 본문의 `img`, `picture`, `figure` 후보 검출
- 로고·아이콘·광고·추적 픽셀·반복 이미지 필터
- 작품 사진·설치 전경·도판·그래프·다이어그램·문서 스캔 분류
- 원문 페이지·Figure·캡션·주변 문단 연결
- 선별된 외부 이미지의 Visual Capsule 생성

Delivery 2는 Delivery 1의 데이터 모델, 분석 계약, 저장 수명주기와 UX를 재사용한다. 두 Delivery는 각각 독립적으로 배포·검증할 수 있어야 한다.

## 3. 비목표

- 일반 이미지 생성·편집 도구
- 작가·인물의 얼굴 자동 식별
- 이미지 원본을 대체하거나 복원하는 벡터 표현
- 사진을 자동 SVG로 벡터화하는 기능
- 대규모 공개 이미지 검색 엔진
- 저작권·로그인·유료 접근을 우회한 외부 이미지 수집
- 별도 Admin UI 또는 추가 사용자 설정 파라미터

SVG는 원문이 SVG인 그래프·도식·선화에 한해 원형을 참조하거나 보존한다. 사진과 래스터 도판은 자동 벡터화하지 않는다.

## 4. 핵심 개념

### Visual Asset

관리 가능한 한 장의 시각 자료다. 개인 사진, 작업 이미지, PDF 도판, 웹 본문 사진, 그래프가 모두 Visual Asset이 될 수 있다. 다만 이미지를 맥락 없이 분리하지 않는다.

- 개인 이미지는 작업·시리즈 Source에 연결한다.
- PDF·웹 이미지는 부모 Source와 active source version에 연결한다.
- 연결되지 않은 개인 업로드는 Inbox의 임시 상태로만 허용하며 분석 완료 전에 작업·시리즈를 지정한다.

### Visual Capsule

원본보다 작지만 다시 볼 수 있고 모델이 재분석할 수 있는 최소 시각 패키지다.

- 분석용 WebP
- exact content hash
- perceptual hash
- 버전이 기록된 이미지 embedding
- OCR 결과
- 구조화 시각 분석
- 사용자 검수본
- 출처와 작업 관계

Embedding은 유사성 계산용이며 원본을 복원하거나 새로운 세부 관찰을 생성하는 근거로 취급하지 않는다.

## 5. 저장 상태와 삭제 규칙

Visual Asset의 저장 상태는 다음 네 가지다.

| 상태 | 보유 데이터 | 용도 |
|---|---|---|
| `ARCHIVAL` | 원본 + WebP + 분석 데이터 | 기본 개인 이미지 상태 |
| `CAPSULE` | WebP + 분석 데이터 | 원본 삭제 후 재열람·재분석 가능 |
| `TEXT_ONLY` | 분석·메타데이터만 | 이미지 파일을 모두 삭제한 최소 상태 |
| `LINK_ONLY` | 외부 URL·출처·맥락만 | 수집하지 않은 외부 이미지 |

삭제는 자동으로 실행하지 않는다.

- `ARCHIVAL → CAPSULE`: 사용자가 원본 삭제를 명시적으로 확인한다.
- `CAPSULE → TEXT_ONLY`: 별도 확인을 거쳐 WebP를 삭제한다.
- 파일 삭제 후에도 해시, 크기, 형식, 삭제 시점, 분석 이력, 사용자 수정본을 보존한다.
- 삭제된 파일을 UI나 API에서 존재하는 것으로 표시하지 않는다.
- AI 분석 완료만으로 삭제 가능 상태가 되지 않는다. 사용자가 결과를 검수했거나 경고를 확인하고 명시적으로 강제 전환해야 한다.

개인 원본은 비공개 R2 객체로 먼저 저장한다. 파생 WebP에는 EXIF를 포함하지 않는다. 원본 EXIF 중 방향·해상도·색공간처럼 처리에 필요한 값만 구조화하며, GPS는 저장하지 않는다.

## 6. 압축 프로필

파생본은 WebP를 기본 포맷으로 사용한다. 단일 품질값을 모든 시각 자료에 강제하지 않는다.

- 사진·작품 이미지: 장변 768px, 손실 WebP, 약 50~200KB 목표
- 그래프·도식·OCR 중심 이미지: 장변 최대 1280px, 고품질 또는 무손실 WebP, 약 350KB 이하 목표
- 원본이 더 작으면 확대하지 않는다.
- 최초 저용량 파생본으로 종류를 판정한 뒤, 텍스트 가독성이 필요한 도판만 고해상도 Capsule을 재생성할 수 있다.
- 크기 목표는 이미지 복잡도에 따라 달라지는 운영 목표이며 저장 성공의 절대 조건은 아니다.

변환 로직은 `Visual Transform` 경계 뒤에 둔다. 초기 구현은 Cloudflare 이미지 변환 기능을 사용하되, 호출부는 특정 변환 제품이나 포맷에 종속되지 않는다.

## 7. 데이터 모델

기존 `sources`와 `source_versions`는 텍스트·문서의 정체성과 버전을 계속 담당한다. 시각 자료는 별도 테이블로 분리하되 부모 Source를 참조한다.

### `visual_assets`

- 정체성: `id`, `parent_source_id`, `parent_version_id`
- 출처: `origin_kind`, `source_url`, `page_number`, `figure_label`, `bbox_json`
- 맥락: `caption`, `nearby_text`, `asset_role`
- 분류: `visual_kind`, `selection_status`, `selection_reason`
- 권리: `rights_status`, `is_personal_work`
- 저장: `storage_state`, `content_hash`, `perceptual_hash`
- 운영: 생성·수정·삭제 시점

`parent_source_id`가 없는 개인 이미지는 Inbox의 `UNASSIGNED` 상태에서만 허용한다.

`rights_status`는 `PERSONAL | PERMITTED | PUBLIC_LINK | UNKNOWN | RESTRICTED`로 제한한다. `UNKNOWN`과 `RESTRICTED` 외부 이미지는 기본적으로 `LINK_ONLY`이며 사용자가 별도 근거를 기록하지 않는 한 R2 Capsule을 만들지 않는다.

### `visual_asset_versions`

- `visual_asset_id`, `version`, `variant`
- `variant`: `ORIGINAL | CAPSULE | SVG_SOURCE`
- R2 key, MIME, width, height, byte size, content hash
- 변환 프로필과 부모 version
- 생성·삭제 시점

### `visual_analyses`

- `visual_asset_id`, `visual_version_id`
- `analysis_type`: `AUTO_SUGGESTION | USER_VERIFIED`
- provenance: `INTERPRETATION | ARTISTIC_PROPOSITION`
- 구조화 payload
- model ID, prompt version, 비용
- confidence, review status, 생성·검수 시점

AI 결과를 수정할 때 기존 행을 덮어쓰지 않고 `USER_VERIFIED` 분석을 추가한다.

### `visual_embeddings`

- `visual_asset_id`, `visual_version_id`
- embedding model과 차원
- Vectorize vector ID
- 생성 시점

모델 변경 시 기존 embedding을 자동 해석하지 않고 새 버전을 만든다.

### `visual_relations`

- 이미지↔이미지, 이미지↔Source, 이미지↔Thread 관계
- 관계 종류와 생성 주체(`SYSTEM | USER`)
- 관계 설명과 생성 시점

## 8. 시각 분석 계약

AI 출력은 일반 캡션 한 문장 대신 아래 구조를 사용한다.

### 관찰 `observation`

- 화면 비율과 방향
- 인물·사물·공간의 존재와 위치
- 프레이밍, 시점, 구도, 깊이
- 빛, 색, 대비, 질감, 재료 단서
- 반복, 대칭, 경계, 겹침, 빈 공간
- OCR과 화면 안의 문자

### 형식 해석 `formal_interpretation`

- 시선의 흐름과 시각적 리듬
- 평면성·깊이·스케일의 관계
- 물질성·매체성에 대한 제한된 해석
- 이미지 내부 요소 사이의 긴장과 관계

### 맥락 `context`

- 작업·시리즈 정보
- PDF Figure 캡션과 주변 문단
- 웹 alt/figcaption과 주변 본문
- 관련 Source와 Thread

### 불확실성 `uncertainty`

- 확인할 수 없는 대상이나 재료
- 낮은 해상도·잘린 도판·OCR 실패
- 관찰과 추론의 경계

### 작업 제안 `artistic_proposition`

관찰에서 직접 도출되지 않는 작업 방향은 별도 provenance로 분리한다. 사용자가 채택하기 전에는 작업 사실이나 연구 근거로 사용하지 않는다.

AI는 이미지에 없는 작가 의도, 인물 신원, 촬영 장소를 단정하지 않는다. 원문 캡션이나 사용자 메모가 제공한 정보만 출처와 함께 사용할 수 있다.

## 9. 개인 이미지 처리 흐름

```text
Inbox 이미지 업로드
→ 파일 검증
→ R2 원본 저장
→ WebP Capsule 생성
→ hash/pHash/OCR/embedding 생성
→ 작업·시리즈 연결
→ 시각 분석
→ 사용자 검수
→ ARCHIVAL 확정
```

- 여러 장을 한 번에 올릴 수 있다.
- 업로드 전에 기본 작업·시리즈를 한 번 선택하고 묶음에 적용할 수 있다.
- exact hash는 동일 파일을, perceptual hash는 크기·압축만 다른 유사 파일을 찾는다.
- 유사 이미지라도 서로 다른 작업 맥락에 등장하면 강제로 합치지 않고 관계만 제안한다.
- 일부 이미지 실패가 전체 묶음을 실패시키지 않는다.

## 10. PDF·웹 Visual Extraction Gate

```text
부모 원문 R2 보존
→ 이미지 후보 검출
→ 결정론적 잡음 제거
→ 맥락 관련성 판정
→ 시각 종류 분류
→ SELECTED/REVIEW/DECORATIVE/DUPLICATE/UNAVAILABLE
→ SELECTED·REVIEW만 Capsule 생성
```

필터링에 필요한 저해상도 후보 이미지는 작업 중에만 사용한다. `SELECTED`·`REVIEW`가 아닌 후보는 지속 R2 객체를 만들지 않고 URL·위치·판정 이유만 남긴다.

### PDF

- 부모 PDF와 active source version을 Source of Truth로 유지한다.
- 페이지 번호, bbox, Figure 번호, 캡션, 주변 문단을 기록한다.
- PDF에 포함된 전체 페이지 배경, 머리글 로고, 반복 장식을 제외한다.
- 도판 원본을 별도 원자료처럼 가장하지 않는다. PDF에서 추출된 파생물임을 표시한다.

### 웹

- 본문 추출 범위 안의 `img`, `picture`, `figure`를 기본 후보로 사용한다.
- CSS 배경, 광고 슬롯, 추적 픽셀, 사이트 공통 로고는 기본 제외한다.
- 이미지 URL, final URL, alt, figcaption, 주변 본문, 수집 시점을 기록한다.
- 기존 원격 수집의 URL·redirect·content-type·size·private-network 안전 검사를 재사용한다.
- 로그인·유료 접근·차단을 우회하지 않는다.

### 필터 상태

- `SELECTED`: 핵심 시각 자료
- `REVIEW`: 자동 판정이 불확실하여 사용자 확인 필요
- `DECORATIVE`: 로고·광고·아이콘·장식
- `DUPLICATE`: 동일·근접 이미지 반복
- `UNAVAILABLE`: 접근·디코딩·변환 실패

기본 UI에는 `SELECTED`와 `REVIEW`만 표시한다. 나머지는 접힌 “필터링된 이미지”에서 이유와 함께 복구할 수 있다. 정상 문서에서 이미지가 0개인 것은 실패가 아니다.

## 11. UX 설계

### 기본 원칙

- 새 최상위 메뉴를 추가하지 않는다.
- 저장소의 기존 목록·읽기 작업공간을 유지한다.
- 이미지 선택으로 자료 목록의 스크롤이나 원문 읽기 위치가 초기화되지 않는다.
- AI 제안은 바로 저장되지 않고 채택·수정·나중에·장식 이미지 판단을 제공한다.
- 기술 상태명보다 사용자 행동을 먼저 보여준다.

### 기본 읽기 모드

원문 문단과 연결된 이미지 스트립을 인라인으로 표시한다. 이미지를 선택하면 같은 읽기 pane 안에서 아래 항목이 열린다.

- 이미지와 Figure·페이지·출처
- 관찰과 형식 해석
- 태그와 불확실성
- `채택·수정`, `나중에`, `장식 이미지`

패널을 닫으면 같은 문단부터 계속 읽는다.

### 시각 보드

여러 이미지를 비교하거나 일괄 판단할 때만 연다.

- 기본 범위는 현재 Source다.
- 사용자가 원할 때 작업·시리즈 또는 Reservoir 전체로 넓힌다.
- 핵심·검토·필터링·저장 상태 필터를 제공한다.
- 보드에서 읽기 모드로 돌아오면 기존 Source와 스크롤 위치를 복원한다.

### 반응형

- 데스크톱: 자료 목록 + 읽기 pane, 인라인 분석
- 좁은 화면: 목록과 읽기 중 하나만 표시하고 분석은 sheet로 연다.
- 시각 보드는 반응형 grid를 사용한다.
- 삭제·저장 단계 전환은 일상적인 판단 버튼과 떨어진 관리 메뉴에 둔다.

## 12. API·컴포넌트 경계

구현은 아래 단위로 분리한다.

- `VisualAssetStore`: D1/R2 저장과 버전·수명주기
- `VisualTransform`: WebP 변환과 메타데이터 정리
- `VisualAnalyzer`: OCR·구조화 vision 분석·embedding
- `VisualExtractor`: PDF·웹 이미지 후보 생성
- `VisualFilter`: 잡음·중복·관련성 분류
- `VisualReview`: 사용자 채택·수정·복구·저장 상태 전환

각 단위는 모델명이나 UI 컴포넌트를 직접 알지 않는다. Worker workflow가 단계별 job을 조정한다. 모델명과 분석 품질은 wrangler vars로 관리하고 월 비용 원장과 예약 guardrail을 재사용한다. 사용자에게 새로운 모델 설정을 노출하지 않는다.

## 13. 오류와 재시도

작업 종류는 `VISUAL_TRANSFORM`, `VISUAL_ANALYSIS`, `VISUAL_EXTRACTION`으로 구분한다. 기존 job 상태와 관찰성 규칙을 재사용한다.

- 원본 저장 실패: 후속 처리를 시작하지 않는다.
- WebP 변환 실패: 원본을 유지하고 변환만 재시도한다.
- 분석 실패: Capsule을 유지하고 분석만 재시도한다.
- PDF·웹 일부 이미지 실패: 부모 Source와 성공한 이미지 처리를 유지한다.
- 외부 이미지 접근 실패: `UNAVAILABLE`과 원인을 기록하며 부모 원문을 실패 처리하지 않는다.
- 삭제 실패: 저장 상태를 바꾸지 않고 재시도 가능 상태로 남긴다.
- 동일 job 재실행은 같은 version을 중복 생성하지 않아야 한다.

사용자에게는 `이미지 변환 실패`, `분석 실패`, `외부 이미지 접근 불가`, `검토 필요`처럼 행동 가능한 문구를 보여주고 내부 오류 코드는 진단 상세에 둔다.

## 14. 개인정보·권리·provenance

- 개인 이미지 원본과 Capsule은 Cloudflare Access 뒤에서만 제공한다.
- 외부 이미지는 공개 링크와 부모 원문의 권리 상태를 기록한다.
- 외부 Capsule을 공개 배포하거나 홈페이지 자산처럼 사용하지 않는다.
- 웹 원문이 이미지 재수집을 허용하지 않거나 접근이 불확실하면 `LINK_ONLY`로 남긴다.
- AI 분석은 항상 `INTERPRETATION`, 작업 제안은 `ARTISTIC_PROPOSITION`으로 표시한다.
- 사용자의 수정본은 AI 결과와 분리하고 이후 Distill/Radar에서는 사용자 검수본을 우선한다.

## 15. 테스트와 승인 기준

### 데이터·저장

- 원본이 R2에 저장되기 전에 변환·분석이 시작되지 않는다.
- ARCHIVAL, CAPSULE, TEXT_ONLY, LINK_ONLY 전환이 정확하다.
- 원본·WebP 삭제 후 tombstone과 분석 이력이 유지된다.
- exact hash와 perceptual hash가 서로 다른 역할을 유지한다.

### 분석

- 관찰·형식 해석·맥락·불확실성·작업 제안이 분리된다.
- USER_VERIFIED 분석이 AI 제안을 덮어쓰지 않고 새 이력으로 남는다.
- 모델·prompt version·비용이 기록된다.
- 저해상도·OCR 실패가 단정적인 분석으로 표시되지 않는다.

### PDF·웹 추출

- fixture PDF의 Figure와 페이지·캡션 연결이 유지된다.
- 반복 로고·추적 픽셀·장식 이미지가 기본 목록에서 제외된다.
- 작은 핵심 도판은 크기 규칙 하나만으로 자동 폐기되지 않는다.
- 0건 결과와 부분 실패가 문서 수집 실패로 처리되지 않는다.

### UX

- 이미지 선택·닫기 후 목록과 원문 스크롤 위치가 유지된다.
- 현재 Source에서 시각 보드로 갔다 돌아와도 선택 상태가 유지된다.
- 필터링된 이미지를 이유와 함께 복구할 수 있다.
- 모바일에서 목록·읽기·분석이 겹치지 않는다.
- 파괴적 저장 전환에는 별도 확인이 필요하다.

### 운영

- 시각 분석이 월 AI budget guardrail을 우회하지 않는다.
- 실패 job은 단계와 원인을 구분하고 안전하게 재시도된다.
- 모델이나 변환 구현을 교체해도 저장·UX API 계약이 유지된다.

## 16. 최종 결정 요약

- 개인 이미지 우선, PDF·웹·발견 자료 이미지는 두 번째 Delivery로 진행한다.
- 개인 이미지는 원본과 WebP를 함께 보존하는 `ARCHIVAL`이 기본이다.
- 사용자는 검수 후 원본을 삭제해 `CAPSULE`, 이미지 전체를 삭제해 `TEXT_ONLY`로 전환할 수 있다.
- 사진은 SVG로 자동 벡터화하지 않는다.
- 핵심 저장 단위는 WebP + hash/pHash + embedding + OCR + 구조화 분석인 Visual Capsule이다.
- PDF·웹 이미지는 Visual Extraction Gate를 통과하며 부모 원문과 위치를 잃지 않는다.
- UX는 원문 중심 인라인 판단을 기본으로 하고, 필요할 때 시각 보드를 여는 하이브리드다.
- AI 관찰·해석·작업 제안과 사용자 검수본을 분리한다.
