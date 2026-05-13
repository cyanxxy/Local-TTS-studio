// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import { createGenerateRateLimiter } from "./generateRateLimiter";

describe("generateRateLimiter", () => {
  it("releases the in-flight lock when the wrapped task fails before completion", async () => {
    const limiter = createGenerateRateLimiter<"kani" | "neutts">({
      rateWindowMs: 0,
      now: () => 1_000,
    });

    await expect(limiter.run("neutts", async () => {
      throw new Error("setup failed");
    })).rejects.toThrow("setup failed");

    await expect(limiter.run("neutts", async () => "ok")).resolves.toBe("ok");
  });

  it("rejects overlapping generates for the same model", async () => {
    const limiter = createGenerateRateLimiter<"kani" | "neutts">({
      rateWindowMs: 0,
      now: () => 1_000,
    });

    let resolveFirst!: () => void;
    const first = limiter.run("kani", async () => {
      await new Promise<void>((resolve) => {
        resolveFirst = resolve;
      });
    });

    await expect(limiter.run("kani", async () => undefined)).rejects.toThrow(
      "A kani generation is already running.",
    );

    resolveFirst();
    await first;
  });

  it("preserves the cooldown window between completed calls", async () => {
    const now = vi.fn(() => 1_000);
    const limiter = createGenerateRateLimiter<"kani" | "neutts">({
      rateWindowMs: 500,
      now,
    });

    await limiter.run("kani", async () => "first");

    await expect(limiter.run("kani", async () => "second")).rejects.toThrow(
      "Too many generation requests. Please wait a moment and try again.",
    );

    now.mockReturnValue(1_600);
    await expect(limiter.run("kani", async () => "third")).resolves.toBe("third");
  });
});
