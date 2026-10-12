import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ErrorBanner } from "./ErrorBanner";

describe("ErrorBanner", () => {
  it("renders nothing without an error", () => {
    render(<ErrorBanner error={null} />);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("hides a dismissed error until a different one arrives", () => {
    const { rerender } = render(<ErrorBanner error="Model failed" />);
    expect(screen.getByRole("alert")).toHaveTextContent("Model failed");

    fireEvent.click(screen.getByRole("button", { name: "Dismiss error" }));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();

    rerender(<ErrorBanner error="Model failed" />);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();

    rerender(<ErrorBanner error="Export failed" />);
    expect(screen.getByRole("alert")).toHaveTextContent("Export failed");
  });
});
