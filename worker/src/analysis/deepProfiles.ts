export type DeepProfile = "precision" | "maximum";
export type OpenAiTier = "high" | "deep";

export interface DeepProfileDefinition {
  id: DeepProfile;
  label: string;
  description: string;
  tier: OpenAiTier;
  maxChars: number;
}

export const DEEP_PROFILES: Record<DeepProfile, DeepProfileDefinition> = {
  precision: {
    id: "precision",
    label: "정밀",
    description: "긴 본문을 나누어 읽고 핵심 구조를 다시 정리합니다.",
    tier: "high",
    maxChars: 72_000,
  },
  maximum: {
    id: "maximum",
    label: "최고 정밀",
    description: "논거와 연결 관계까지 더 깊게 검토합니다.",
    tier: "deep",
    maxChars: 96_000,
  },
};

export function parseDeepProfile(value: unknown): DeepProfile {
  return value === "maximum" ? "maximum" : "precision";
}

export function profileFor(value: unknown): DeepProfileDefinition {
  return DEEP_PROFILES[parseDeepProfile(value)];
}
