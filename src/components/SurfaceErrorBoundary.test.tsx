import { fireEvent, render, screen } from "@testing-library/react";
import { useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SurfaceErrorBoundary } from "./SurfaceErrorBoundary";

const state = { fail: true };
const onMount = vi.fn();

function Flaky() {
  if (state.fail) throw new Error("Render failed.");
  return <p>Surface content</p>;
}

function Counted() {
  useEffect(() => onMount(), []);
  return <p>Counted</p>;
}

describe("SurfaceErrorBoundary", () => {
  beforeEach(() => {
    state.fail = true;
    onMount.mockClear();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("names the failed surface beside the rest of the page and retries on request", () => {
    render(
      <>
        <h1>Still here</h1>
        <SurfaceErrorBoundary name="The Reader" resetKeys={["reader"]}>
          <Flaky />
        </SurfaceErrorBoundary>
      </>,
    );

    expect(screen.getByRole("alert")).toHaveTextContent("The Reader could not be shown");
    expect(screen.getByText("Render failed.")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Still here" })).toBeInTheDocument();
    expect(console.error).toHaveBeenCalledWith("The Reader failed:", expect.any(Error), expect.any(String));

    state.fail = false;
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(screen.getByText("Surface content")).toBeInTheDocument();
  });

  it("clears the error when a reset key changes", () => {
    const view = render(
      <SurfaceErrorBoundary name="The Reader" resetKeys={["reader"]}>
        <Flaky />
      </SurfaceErrorBoundary>,
    );
    state.fail = false;
    view.rerender(
      <SurfaceErrorBoundary name="The Reader" resetKeys={["reader"]}>
        <Flaky />
      </SurfaceErrorBoundary>,
    );
    expect(screen.getByRole("alert")).toBeInTheDocument();

    view.rerender(
      <SurfaceErrorBoundary name="The Reader" resetKeys={["studio"]}>
        <Flaky />
      </SurfaceErrorBoundary>,
    );
    expect(screen.getByText("Surface content")).toBeInTheDocument();
  });

  it("offers a way out when the caller gives one, and leaves healthy children mounted", () => {
    const onDismiss = vi.fn();
    const view = render(
      <SurfaceErrorBoundary name="Settings" resetKeys={[]} onDismiss={onDismiss} className="fixed">
        <Flaky />
      </SurfaceErrorBoundary>,
    );
    expect(screen.getByRole("alert")).toHaveClass("fixed");
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onDismiss).toHaveBeenCalledOnce();

    view.rerender(
      <SurfaceErrorBoundary name="Settings" resetKeys={["other"]}>
        <Counted />
      </SurfaceErrorBoundary>,
    );
    view.rerender(
      <SurfaceErrorBoundary name="Settings" resetKeys={["changed"]}>
        <Counted />
      </SurfaceErrorBoundary>,
    );
    // A reset key only matters while the surface has failed.
    expect(onMount).toHaveBeenCalledOnce();
    expect(screen.getByText("Counted")).toBeInTheDocument();
  });
});
