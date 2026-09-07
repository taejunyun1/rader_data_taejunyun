# 2026-09-07 기술 감사 수정 기록

감사 16건 중 **15건의 수정과 회귀 검증을 완료**했다. T11은 기존 문서가 별도 설계로 남긴 예산 예약 통합이며 사용자 설계 선택을 기다리므로 이번 변경에 포함하지 않는다. 원래 감사 증거는 로컬 `output/technical-audit-2026-09-07/`에 보존한다.

| 항목 | 수정 및 확인 |
|---|---|
| T01 원본 덮어쓰기 | UUID 원본 키, SQL 내부 버전 번호 할당. 동시 업로드 후 저장 hash와 원본 바이트 일치. |
| T02 선택 신호 | 최신 행동 비교 수정, 동일 시각에는 삽입 순서로 결정. 선택과 이후 취소 신호 검증. |
| T03 심층 분석 재시도 | 작업별 입력·모델 snapshot, 요청 hash 캐시 identity, 분석 identity 고정. 저장 실패 뒤 활성 버전이 바뀌어도 원래 provenance 유지. |
| T04 공개 자료 삭제 | publication lease와 source claim, current CAS fencing 및 최종 D1 lease 검사. 공개 자료는 409, 상태 확인 불가는 503으로 삭제 차단. |
| T05 수동 편집 보존 | 트랜잭션에서 재검사하고 수신 버전을 검토 대기로 보존. 동일 pending 동기화 중복도 차단. |
| T06 내보내기 누락 | JSON v2에 source/version/analysis 전체 필드, 세션 input/source provenance, 관계·시각 연구 데이터 포함. 원본 모든 버전·미리보기, research.json과 원본/백업 key 대응 manifest 보존. 누락 원본은 409 backup_incomplete. |
| T07 재발행 | WITHDRAWN/SUPERSEDED의 재발행 전이를 UPDATE predicate에 반영. |
| T08 철회 응답 | 공유 계약 validator로 정상 ok:true 응답 허용, 비정상 shape 거절. |
| T09 provider 재시도 | 명시적인 HTTP 429/5xx는 예산 predicate 아래 예약 재획득 후 재시도. 영구 실패와 예산 부족 구분. |
| T10 착즙 중복 저장 | 작업별 세션/큐/gap identity, 원자적 저장 및 저장 결과 재사용. 큐 검증 별도 durable step. |
| T11 예산 이중 예약 | **미해결/설계 선택 대기.** 전체 작업 예약과 개별 호출 예약 소유권 통합 필요. |
| T12 활성 버전 근거 | 착즙과 Markdown은 active_version_id에 해당하는 기본 분석만 사용. |
| T13 hostname 오판 | IPv6 접두어 검사는 IP literal에만 적용. DNS 이름과 private IP 사례 검증. |
| T14 빈 분석 항목 | 첫 입력 시 실제 배열 항목 생성. 빈 필드 입력·재입력 UI 검증. |
| T15 대용량 PDF | 29,000,000바이트 초과는 parser/base64/preview 실행 전에 거절. 경계값 허용 검증. |
| T16 CSV 수식 주입 | 모든 문자열 셀의 수식 시작과 공백/제어/전각 변형 보호. DB·R2 및 JSON 원문 유지. |

추가 수정: nested Discovery profile을 보존하는 canonical dedupe, 서버 전용 snapshot 입력 제거, 기본 분석/임베딩 모델의 Wrangler vars 관리, 실제 입력과 일치하는 fragment만 SOURCE로 저장하고 sourceVersionId 기록, 오래된 기본 분석의 현재 자료 indexing 방지, 존재하지 않는 테스트 include 정리.

## 검증

- `pnpm verify`: Workers 187 + Node route 33 + Web 502 = **722개 테스트**, 타입 검사·웹 빌드 통과.
- 기존 감사 재현 9개 전부 통과. 새 회귀는 정규 테스트에 등록했다.
- `pnpm cf:typegen`, Worker `wrangler deploy --dry-run`, `git diff --check` 통과.
- 독립 통합 리뷰에서 발견한 pending sync 중복과 preview 백업 누락도 보완했다. 추가 배포 차단 이슈는 발견되지 않았다.
- 운영 migration 조회 결과 미적용 항목 없음. 새 migration 없음. 배포 전 QUEUED/RUNNING 연구 작업 조회는 0건이었다.
- 비관련 작업 문서·캐시·브라우저 산출물은 릴리스 커밋에서 제외한다. 실행 로그는 로컬 감사 output에 보존한다.

## 남은 범위

T11 권장안은 전체 작업 예약에서 개별 호출 예약으로 금액을 이관하고 실제 사용료를 한 번만 집계하는 것이다. 대안은 전체 예약을 없애고 호출마다 예약하는 방식이며 작업 중간 예산 중단 가능성이 있다. `PROJECT_CONTEXT.md` §6-2에 명시된 별도 설계 범위이므로 사용자 선택 없이 변경하지 않았다.

불확정 CALLED/SETTLEMENT_PENDING의 provider 증거 기반 복구, source 단위 임베딩의 버전 교체와 D1/Vectorize 간 원자적 처리, 대규모 export의 작업화 및 전체 환경 복구 훈련은 별도 후속 과제다. JSON/원본 백업은 연구 데이터 보존용이며 운영 lease·진행 중 작업·Cloudflare 설정·비밀값·Vectorize 실제 벡터·PUBLICATIONS 버킷을 복제하는 인프라 백업이 아니다. 삭제와 백업 사이의 분산 snapshot 잠금은 없고, 복사 시 없는 참조 원본은 실패로 보고한다. 실제 Excel/LibreOffice 가져오기 및 운영 파괴적 장애 주입은 수행하지 않았다.
