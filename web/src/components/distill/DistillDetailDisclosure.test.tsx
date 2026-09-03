import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import DistillDetailDisclosure from "./DistillDetailDisclosure";

describe("DistillDetailDisclosure", () => {
  it("keeps detail collapsed until the reader asks for context", async () => {
    const user = userEvent.setup();
    render(
      <DistillDetailDisclosure>
        <p>근거와 맥락</p>
      </DistillDetailDisclosure>,
    );

    expect(screen.queryByText("근거와 맥락")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "근거와 맥락 보기" }));
    expect(screen.getByText("근거와 맥락")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "근거와 맥락 닫기" })).toBeInTheDocument();
  });
});
