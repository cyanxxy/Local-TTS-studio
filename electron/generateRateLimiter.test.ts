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

  it("lets a new job wait out the rest of the cooldown instead of failing", async () => {
    let clock = 1_000;
    const wait = vi.fn(async (ms: number) => {
      clock += ms;
    });
    const limiter = createGenerateRateLimiter<"qwen3">({
      rateWindowMs: 500,
      now: () => clock,
      wait,
    });

    await limiter.run("qwen3", async () => "section", { jobId: "reader-job", sectionIndex: 0, sectionCount: 1 });
    clock += 5;
    await expect(limiter.run("qwen3", async () => "look-ahead", {
      jobId: "look-ahead-job",
      sectionIndex: 0,
      sectionCount: 1,
    })).resolves.toBe("look-ahead");
    expect(wait).toHaveBeenCalledWith(495);
  });

  it("still rejects a job that another generation overtook while it waited", async () => {
    let resolveOvertaking!: () => void;
    let overtaking: Promise<unknown> | undefined;
    let clock = 1_000;
    const limiter = createGenerateRateLimiter<"qwen3">({
      rateWindowMs: 500,
      now: () => clock,
      wait: async (ms) => {
        clock += ms;
        // Another request starts while this one is waiting.
        overtaking = limiter.run("qwen3", () => new Promise<void>((resolve) => {
          resolveOvertaking = resolve;
        }));
      },
    });

    await limiter.run("qwen3", async () => undefined);
    await expect(limiter.run("qwen3", async () => "late")).rejects.toThrow(
      "A qwen3 generation is already running.",
    );
    resolveOvertaking();
    await overtaking;
  });

  it("preserves the cooldown window between completed calls", async () => {
    const now = vi.fn(() => 1_000);
    const limiter = createGenerateRateLimiter<"qwen3" | "neutts">({
      rateWindowMs: 500,
      now,
      wait: async () => undefined,
    });

    await limiter.run("qwen3", async () => "first");

    await expect(limiter.run("qwen3", async () => "second")).rejects.toThrow(
      "Too many generation requests. Please wait a moment and try again.",
    );

    now.mockReturnValue(1_600);
    await expect(limiter.run("qwen3", async () => "third")).resolves.toBe("third");
  });

  it("allows only the exact next section of one job to run back-to-back", async () => {
    const now = vi.fn(() => 1_000);
    const limiter = createGenerateRateLimiter<"qwen3">({
      rateWindowMs: 500,
      now,
      wait: async () => undefined,
    });

    await expect(limiter.run("qwen3", async () => "first", {
      jobId: "reader-job-1",
      sectionIndex: 0,
      sectionCount: 2,
    })).resolves.toBe("first");
    await expect(limiter.run("qwen3", async () => "second", {
      jobId: "reader-job-1",
      sectionIndex: 1,
      sectionCount: 2,
    })).resolves.toBe("second");

    await expect(limiter.run("qwen3", async () => "unrelated", {
      jobId: "reader-job-2",
      sectionIndex: 0,
      sectionCount: 2,
    })).rejects.toThrow("Too many generation requests");
  });

  it("does not let a skipped or mismatched section impersonate a continuation", async () => {
    const limiter = createGenerateRateLimiter<"qwen3">({
      rateWindowMs: 500,
      now: () => 1_000,
      wait: async () => undefined,
    });

    await limiter.run("qwen3", async () => undefined, {
      jobId: "reader-job",
      sectionIndex: 0,
      sectionCount: 3,
    });

    await expect(limiter.run("qwen3", async () => undefined, {
      jobId: "reader-job",
      sectionIndex: 2,
      sectionCount: 3,
    })).rejects.toThrow("Too many generation requests");
  });
});
