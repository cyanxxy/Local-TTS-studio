// @vitest-environment node

import { describe, expect, it } from "vitest";
import { WarmupCoordinator, warmTargetKey } from "./warmups";

describe("warmTargetKey", () => {
  it("keys a Qwen3 warm-up by mode, repository and model folder", () => {
    const base = { mode: "customVoice", modelRepo: "repo/a", modelPath: "/models/a" };

    expect(warmTargetKey("qwen3", base)).toBe(warmTargetKey("qwen3", { ...base, text: "ignored" }));
    expect(warmTargetKey("qwen3", base)).not.toBe(warmTargetKey("qwen3", { ...base, modelPath: "/models/b" }));
    expect(warmTargetKey("qwen3", base)).not.toBe(warmTargetKey("qwen3", { ...base, mode: "voiceClone" }));
  });

  it("keys a NeuTTS warm-up by repository, defaulting to the bundled Nano model", () => {
    expect(warmTargetKey("neutts", {})).toBe(warmTargetKey("neutts", { modelRepo: "neuphonic/neutts-nano-q4-gguf" }));
    expect(warmTargetKey("neutts", {})).not.toBe(warmTargetKey("neutts", { modelRepo: "neuphonic/neutts-air-q4-gguf" }));
  });
});

describe("WarmupCoordinator", () => {
  it("publishes a warm-up until it settles and releases its waiters", async () => {
    const warmups = new WarmupCoordinator();
    const { warmup, settle } = warmups.begin("qwen3", "warm-1", "target");

    expect(warmups.pending("qwen3")).toBe(warmup);
    expect(warmups.pending("neutts")).toBeUndefined();

    let released = false;
    const waiting = warmup.promise.then(() => {
      released = true;
    });
    await Promise.resolve();
    expect(released).toBe(false);

    settle();
    await waiting;
    expect(released).toBe(true);
    expect(warmups.pending("qwen3")).toBeUndefined();
  });

  it("does not withdraw a newer warm-up when a superseded one settles", () => {
    const warmups = new WarmupCoordinator();
    const superseded = warmups.begin("qwen3", "warm-1", "old");
    const current = warmups.begin("qwen3", "warm-2", "new");

    superseded.settle();

    expect(warmups.pending("qwen3")).toBe(current.warmup);
  });

  it("hands back the warm-up a cancelled waiter is blocked on", () => {
    const warmups = new WarmupCoordinator();
    const { warmup } = warmups.begin("qwen3", "warm-1", "target");
    warmups.addWaiter("generate-1", "qwen3");

    expect(warmups.cancelWaiter("generate-1")).toBe(warmup);
    expect(warmups.isWaiterCancelled("generate-1")).toBe(true);
  });

  it("records a waiter's cancellation even when no warm-up is pending", () => {
    const warmups = new WarmupCoordinator();
    warmups.addWaiter("generate-1", "neutts");

    expect(warmups.cancelWaiter("generate-1")).toBeUndefined();
    expect(warmups.isWaiterCancelled("generate-1")).toBe(true);
  });

  it("ignores cancels for requests that are not waiting and forgets removed waiters", () => {
    const warmups = new WarmupCoordinator();
    warmups.begin("qwen3", "warm-1", "target");

    expect(warmups.cancelWaiter("unknown")).toBeUndefined();
    expect(warmups.isWaiterCancelled("unknown")).toBe(false);

    warmups.addWaiter("generate-1", "qwen3");
    warmups.cancelWaiter("generate-1");
    warmups.removeWaiter("generate-1");
    expect(warmups.isWaiterCancelled("generate-1")).toBe(false);
    expect(warmups.cancelWaiter("generate-1")).toBeUndefined();
  });
});
