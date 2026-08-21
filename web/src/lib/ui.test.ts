import { describe, expect, it } from "vitest";
import { PRIMARY_VIEWS, VIEW_META, formatDateKo } from "./ui";

describe("UI metadata", () => {
  it("puts the daily reading flow before utilities", () => {
    expect(PRIMARY_VIEWS).toEqual(["RADAR", "DISCOVER", "RESERVOIR", "DISTILL", "INBOX"]);
  });

  it("provides Korean labels for every primary view", () => {
    expect(PRIMARY_VIEWS.map((view) => VIEW_META[view].label)).toEqual(["레이더", "발견", "저장소", "착즙", "받은 자료"]);
  });

  it("formats ISO dates in Korean", () => {
    expect(formatDateKo("2026-08-21T02:00:00.000Z")).toContain("2026");
    expect(formatDateKo("2026-08-21T02:00:00.000Z")).toMatch(/8월/);
  });
});
