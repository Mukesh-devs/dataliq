import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useOnboarding } from "../../stores/onboarding";
import { TipSteps, Tips } from "./Tips";

describe("Tips", () => {
  beforeEach(() => useOnboarding.setState({ tipsHidden: false }));

  it("steps through three tips and hides them for good", async () => {
    render(<Tips />);
    const card = screen.getByRole("region", { name: "Getting started" });
    expect(card).toHaveTextContent("Tip 1 of 3");
    expect(card).toHaveTextContent("Open files of any size");
    expect(screen.queryByRole("button", { name: /Back/ })).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /Next/ }));
    expect(card).toHaveTextContent("Tip 2 of 3");
    expect(card).toHaveTextContent("Sort, filter and look closer");
    await userEvent.click(screen.getByRole("button", { name: /Back/ }));
    expect(card).toHaveTextContent("Tip 1 of 3");
    await userEvent.click(screen.getByRole("button", { name: /Next/ }));
    await userEvent.click(screen.getByRole("button", { name: /Next/ }));
    expect(card).toHaveTextContent("Everything is a command");
    expect(screen.queryByRole("button", { name: /Next/ })).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Got it" }));
    expect(screen.queryByRole("region", { name: "Getting started" })).not.toBeInTheDocument();
    expect(useOnboarding.getState().tipsHidden).toBe(true);
    expect(JSON.parse(localStorage.getItem("dataliq.onboarding")!).state.tipsHidden).toBe(true);
  });

  it("closes from the corner button", async () => {
    render(<Tips />);
    await userEvent.click(screen.getByRole("button", { name: "Close the tips" }));
    expect(screen.queryByRole("region", { name: "Getting started" })).not.toBeInTheDocument();
  });

  it("are shown on demand even after being closed", async () => {
    useOnboarding.setState({ tipsHidden: true });
    const onDone = vi.fn();
    render(<TipSteps onDone={onDone} />);
    expect(screen.getByText("Tip 1 of 3")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /Next/ }));
    await userEvent.click(screen.getByRole("button", { name: /Next/ }));
    await userEvent.click(screen.getByRole("button", { name: "Got it" }));
    expect(onDone).toHaveBeenCalledOnce();
  });
});
