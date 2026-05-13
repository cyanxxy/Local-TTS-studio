import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppErrorBoundary } from "./AppErrorBoundary";

function Thrower({ value }: { value: unknown }) {
  throw value;
  return null;
}

describe("AppErrorBoundary", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders children when no error occurs", () => {
    render(
      <AppErrorBoundary>
        <div>Ready</div>
      </AppErrorBoundary>,
    );

    expect(screen.getByText("Ready")).toBeInTheDocument();
  });

  it("shows the thrown error and reloads on demand", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const reload = vi.fn();
    Object.defineProperty(window, "location", {
      value: { reload },
      configurable: true,
    });

    render(
      <AppErrorBoundary>
        <Thrower value={new Error("Boom")} />
      </AppErrorBoundary>,
    );

    expect(screen.getByText("Something went wrong")).toBeInTheDocument();
    expect(screen.getByText("Boom")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Reload App" }));

    expect(reload).toHaveBeenCalledOnce();
  });

  it("renders non-Error thrown values", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});

    render(
      <AppErrorBoundary>
        <Thrower value="plain failure" />
      </AppErrorBoundary>,
    );

    expect(screen.getByText("plain failure")).toBeInTheDocument();
  });
});
