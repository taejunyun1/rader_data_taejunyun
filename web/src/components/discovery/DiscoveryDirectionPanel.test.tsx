import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { DiscoveryKeywordRecommendation, DiscoveryProfile } from "@radar/shared/discovery";
import DiscoveryDirectionPanel from "./DiscoveryDirectionPanel";

const profile: DiscoveryProfile = {
  original: { keywords: [], strength: 50 },
  counter: { keywords: [], strength: 50 },
  updatedAt: "2026-08-28T00:00:00.000Z",
};

const originalRecommendations: DiscoveryKeywordRecommendation[] = [
  "첫 키워드", "둘 키워드", "셋 키워드", "넷 키워드", "다른 키워드",
].map((keyword, index) => ({
  keyword,
  lane: "ORIGINAL",
  source: "SAVED",
  reason: `${keyword} 이유`,
  score: 1 - index / 10,
  selected: false,
}));

describe("DiscoveryDirectionPanel", () => {
  it("rotates four source-backed recommendations within its lane", async () => {
    const user = userEvent.setup();
    render(<DiscoveryDirectionPanel
      profile={profile}
      recommendations={{ original: originalRecommendations, counter: [] }}
      dirty={false}
      onChange={vi.fn()}
      onSave={vi.fn()}
    />);

    const originalLane = screen.getByRole("region", { name: "오리지널 방향" });
    expect(within(originalLane).getByText("첫 키워드")).toBeInTheDocument();
    expect(within(originalLane).queryByText("다른 키워드")).not.toBeInTheDocument();

    await user.click(within(originalLane).getByRole("button", { name: "새 추천 보기" }));

    expect(within(originalLane).getByText("다른 키워드")).toBeInTheDocument();
  });
});
