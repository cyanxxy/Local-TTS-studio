import { act, fireEvent, render, screen } from "@testing-library/react";
import { Suspense } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SurfaceErrorBoundary } from "../components/SurfaceErrorBoundary";
import { lazyWithRetry } from "./lazyWithRetry";

function Greeting({ name }: { name: string }) {
  return <p>Hello, {name}</p>;
}

function renderLazy(Component: ReturnType<typeof lazyWithRetry<{ name: string }>>) {
  return render(
    <SurfaceErrorBoundary name="The greeting" resetKeys={[]}>
      <Suspense fallback={<p>Loading</p>}>
        <Component name="Ada" />
      </Suspense>
    </SurfaceErrorBoundary>,
  );
}

describe("lazyWithRetry", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("imports the component once and passes its props through", async () => {
    const load = vi.fn(async () => Greeting);
    const Lazy = lazyWithRetry(load);

    renderLazy(Lazy);

    expect(await screen.findByText("Hello, Ada")).toBeInTheDocument();
    expect(load).toHaveBeenCalledOnce();
  });

  it("tries a failed import again before giving up", async () => {
    const load = vi.fn<() => Promise<typeof Greeting>>()
      .mockRejectedValueOnce(new Error("Network hiccup."))
      .mockResolvedValue(Greeting);

    renderLazy(lazyWithRetry(load));

    expect(await screen.findByText("Hello, Ada")).toBeInTheDocument();
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("surfaces a lasting failure, then imports afresh when the boundary retries", async () => {
    let available = false;
    const load = vi.fn(async () => {
      if (!available) throw new Error("Chunk missing.");
      return Greeting;
    });
    renderLazy(lazyWithRetry(load, { retries: 1 }));

    expect(await screen.findByText("Chunk missing.")).toBeInTheDocument();
    const failedAttempts = load.mock.calls.length;
    expect(failedAttempts).toBeGreaterThanOrEqual(2);

    available = true;
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    });
    expect(await screen.findByText("Hello, Ada")).toBeInTheDocument();
    expect(load).toHaveBeenCalledTimes(failedAttempts + 1);
  });
});
