import { describe, expect, it, vi } from "vitest";
import { createPrefetcher } from "./prefetch";

const SIZES: Record<string, number> = { a: 10, b: 20, huge: 1_000, c: 30 };

function createHarness(maxAheadBytes = 100) {
  const fetch = vi.fn(async (file: string) => `${file}-bytes`);
  const prefetcher = createPrefetcher({
    order: ["a", "b", "huge", "c"],
    fetch,
    sizeOf: (file) => SIZES[file],
    maxAheadBytes,
  });
  return { fetch, prefetcher };
}

describe("createPrefetcher", () => {
  it("fetches a taken file and starts the next one in order", async () => {
    const { fetch, prefetcher } = createHarness();

    await expect(prefetcher.take("a")).resolves.toBe("a-bytes");
    expect(fetch.mock.calls.map(([file]) => file)).toEqual(["a", "b"]);

    await expect(prefetcher.take("b")).resolves.toBe("b-bytes");
    // "b" came from the prefetch; "huge" is over the lookahead limit.
    expect(fetch.mock.calls.map(([file]) => file)).toEqual(["a", "b"]);
  });

  it("hands each prefetch out once and fetches again afterwards", async () => {
    const { fetch, prefetcher } = createHarness();
    prefetcher.prefetch("a");
    prefetcher.prefetch("a");
    expect(fetch).toHaveBeenCalledOnce();

    await prefetcher.take("a");
    await prefetcher.take("a");
    expect(fetch.mock.calls.map(([file]) => file)).toEqual(["a", "b", "a"]);
  });

  it("never fetches a file ahead when it exceeds the lookahead limit", async () => {
    const { fetch, prefetcher } = createHarness(1_000);

    await prefetcher.take("b");
    expect(fetch.mock.calls.map(([file]) => file)).toEqual(["b", "huge"]);

    const small = createHarness(5);
    small.prefetcher.prefetch("a");
    await small.prefetcher.take("c");
    expect(small.fetch.mock.calls.map(([file]) => file)).toEqual(["c"]);
  });

  it("reports a failed prefetch only to whoever takes the file", async () => {
    const fetch = vi.fn(async (file: string) => {
      if (file === "b") throw new Error("b download failed");
      return file;
    });
    const prefetcher = createPrefetcher({ order: ["a", "b"], fetch, sizeOf: () => 1, maxAheadBytes: 10 });

    await prefetcher.take("a");
    await new Promise((resolve) => setTimeout(resolve, 0));
    await expect(prefetcher.take("b")).rejects.toThrow("b download failed");
  });

  it("does not prefetch for files outside the order", async () => {
    const { fetch, prefetcher } = createHarness();

    await prefetcher.take("extra");
    expect(fetch.mock.calls.map(([file]) => file)).toEqual(["extra"]);
  });
});
