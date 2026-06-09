// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import { createGenerateRateLimiter } from "./generateRateLimiter";

describe("generateRateLimiter", () => {
  it("uses Date.now by default when no clock is injected", async () => {
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(10_000);
    const limiter = createGenerateRateLimiter<"qwen3">({
      rateWindowMs: 0,
    });

    await expect(limiter.run("qwen3", async () => "ok")).resolves.toBe("ok");
    expect(nowSpy).toHaveBeenCalled();
  });

  it("releases the in-flight lock when the wrapped task fails before completion", async () => {
    const limiter = createGenerateRateLimiter<"qwen3" | "neutts">({
      rateWindowMs: 0,
      now: () => 1_000,
    });

    await expect(limiter.run("neutts", async () => {
      throw new Error("setup failed");
    })).rejects.toThrow("setup failed");

    await expect(limiter.run("neutts", async () => "ok")).resolves.toBe("ok");
  });

  it("rejects overlapping generates for the same model", async () => {
    const limiter = createGenerateRateLimiter<"qwen3" | "neutts">({
      rateWindowMs: 0,
      now: () => 1_000,
    });

    let resolveFirst!: () => void;
    const first = limiter.run("qwen3", async () => {
      await new Promise<void>((resolve) => {
        resolveFirst = resolve;
      });
    });

    await expect(limiter.run("qwen3", async () => undefined)).rejects.toThrow(
      "A qwen3 generation is already running.",
    );

    resolveFirst();
    await first;
  });

  it("preserves the cooldown window between completed calls", async () => {
    const now = vi.fn(() => 1_000);
    const limiter = createGenerateRateLimiter<"qwen3" | "neutts">({
      rateWindowMs: 500,
      now,
    });

    await limiter.run("qwen3", async () => "first");

    await expect(limiter.run("qwen3", async () => "second")).rejects.toThrow(
      "Too many generation requests. Please wait a moment and try again.",
    );

    now.mockReturnValue(1_600);
    await expect(limiter.run("qwen3", async () => "third")).resolves.toBe("third");
  });
});
