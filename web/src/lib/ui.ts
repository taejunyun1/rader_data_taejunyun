import type { View } from "@radar/shared";

export interface ViewMeta {
  label: string;
  description: string;
}

export const PRIMARY_VIEWS = ["RADAR", "DISCOVER", "RESERVOIR", "DISTILL", "INBOX"] as const satisfies readonly View[];
export const UTILITY_VIEWS = ["USAGE", "SETTINGS"] as const satisfies readonly View[];

export const VIEW_META: Record<View, ViewMeta> = {
  RADAR: { label: "레이더", description: "현재 연구 흐름과 읽을 자료" },
  DISCOVER: { label: "발견", description: "외부 자료 후보 검토" },
  RESERVOIR: { label: "저장소", description: "보존된 연구 자료" },
  DISTILL: { label: "착즙", description: "선택한 맥락의 종합과 검증" },
  INBOX: { label: "받은 자료", description: "자료 입력과 처리 상태" },
  USAGE: { label: "AI 사용량", description: "월 예산과 호출 내역" },
  SETTINGS: { label: "설정", description: "연구 성향과 데이터 관리" },
};

export function formatDateKo(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "날짜 미상";
  return new Intl.DateTimeFormat("ko-KR", { year: "numeric", month: "long", day: "numeric" }).format(date);
}

export function formatDateTimeKo(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "시간 미상";
  return new Intl.DateTimeFormat("ko-KR", { dateStyle: "medium", timeStyle: "short" }).format(date);
}

export function viewLabel(view: View): string {
  return VIEW_META[view].label;
}
