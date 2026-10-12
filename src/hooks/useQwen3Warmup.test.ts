import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useQwen3Warmup } from "./useQwen3Warmup";

type Settings = Parameters<typeof useQwen3Warmup>[2];

const settings = (overrides: Partial<Settings> = {}): Settings => ({
  modelPath: " /models/qwen3 ",
  readiness: "ready",
  profile: { repo: "repo/custom", mode: "customVoice" },
  ...overrides,
} as Settings);

function installWarm(warmed = true) {
  const warm = vi.fn().mockResolvedValue({ warmed });
  window.electron = { isElectron: true, localTts: { warm } } as never;
  return warm;
}

afterEach(() => {
  delete window.electron;
});

describe("useQwen3Warmup", () => {
  it("warms the selected model folder once, trimmed, however often the surface re-renders", async () => {
    const warm = installWarm();
    const { rerender } = renderHook(({ s }) => useQwen3Warmup(true, false, s), { initialProps: { s: settings() } });

    await waitFor(() => expect(warm).toHaveBeenCalledTimes(1));
    expect(warm).toHaveBeenCalledWith({
      model: "qwen3",
      mode: "customVoice",
      modelPath: "/models/qwen3",
      modelRepo: "repo/custom",
    });
    rerender({ s: settings() });
    await Promise.resolve();
    expect(warm).toHaveBeenCalledTimes(1);

    rerender({ s: settings({ modelPath: "/models/other" }) });
    await waitFor(() => expect(warm).toHaveBeenCalledTimes(2));
  });

  it("waits while a generation runs or the surface is not using Qwen3, and skips a missing model", async () => {
    const warm = installWarm();
    const { rerender } = renderHook(
      ({ active, busy, s }) => useQwen3Warmup(active, busy, s),
      { initialProps: { active: true, busy: true, s: settings() } },
    );
    rerender({ active: true, busy: true, s: settings() });
    rerender({ active: false, busy: false, s: settings() });
    rerender({ active: true, busy: false, s: settings({ readiness: "missing" }) });
    rerender({ active: true, busy: false, s: settings({ modelPath: "  " }) });
    await Promise.resolve();
    expect(warm).not.toHaveBeenCalled();

    rerender({ active: true, busy: false, s: settings() });
    await waitFor(() => expect(warm).toHaveBeenCalledTimes(1));
  });

  it("tries again after a warm-up that did not load the model", async () => {
    const warm = installWarm(false);
    const { rerender } = renderHook(({ busy }) => useQwen3Warmup(true, busy, settings()), { initialProps: { busy: false } });
    await waitFor(() => expect(warm).toHaveBeenCalledTimes(1));

    rerender({ busy: true });
    rerender({ busy: false });
    await waitFor(() => expect(warm).toHaveBeenCalledTimes(2));
  });
});
