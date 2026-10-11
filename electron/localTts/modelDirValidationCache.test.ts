// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import { getQwen3Profiles, type Qwen3Profile } from "../qwen3Profiles";
import { createModelDirValidationCache, MODEL_DIR_VALIDATION_TTL_MS } from "./modelDirValidationCache";

const [customVoice, otherProfile] = getQwen3Profiles("darwin", "arm64");

function setup(verdict: boolean | ((modelDir: string, profile: Qwen3Profile) => Promise<boolean>) = true) {
  let clock = 1_000;
  const validate = vi.fn(typeof verdict === "function" ? verdict : async () => verdict);
  const cache = createModelDirValidationCache({ validate, now: () => clock });
  return { cache, validate, advance: (ms: number) => { clock += ms; } };
}

function deferred() {
  let resolve!: (value: boolean) => void;
  const promise = new Promise<boolean>((settle) => { resolve = settle; });
  return { promise, resolve };
}

describe("createModelDirValidationCache", () => {
  it("reuses a recent pass for the same folder and profile", async () => {
    const { cache, validate, advance } = setup();

    await expect(cache.isValid("/models/a", customVoice)).resolves.toBe(true);
    advance(MODEL_DIR_VALIDATION_TTL_MS - 1);
    await expect(cache.isValid("/models/a", customVoice)).resolves.toBe(true);

    expect(validate).toHaveBeenCalledTimes(1);
    expect(validate).toHaveBeenCalledWith("/models/a", customVoice);
  });

  it("checks again once a pass is older than the TTL", async () => {
    const { cache, validate, advance } = setup();

    await cache.isValid("/models/a", customVoice);
    advance(MODEL_DIR_VALIDATION_TTL_MS);
    await cache.isValid("/models/a", customVoice);

    expect(validate).toHaveBeenCalledTimes(2);
  });

  it("never remembers a failure, so a fixed folder passes on the next request", async () => {
    const { cache, validate } = setup();
    validate.mockResolvedValueOnce(false);

    await expect(cache.isValid("/models/a", customVoice)).resolves.toBe(false);
    await expect(cache.isValid("/models/a", customVoice)).resolves.toBe(true);

    expect(validate).toHaveBeenCalledTimes(2);
  });

  it("keeps folders and profiles apart", async () => {
    const { cache, validate } = setup();

    await cache.isValid("/models/a", customVoice);
    await cache.isValid("/models/b", customVoice);
    await cache.isValid("/models/a", otherProfile);

    expect(validate).toHaveBeenCalledTimes(3);
  });

  it("shares one check between concurrent requests for the same folder", async () => {
    const check = deferred();
    const { cache, validate } = setup(() => check.promise);

    const first = cache.isValid("/models/a", customVoice);
    const second = cache.isValid("/models/a", customVoice);
    check.resolve(true);

    await expect(Promise.all([first, second])).resolves.toEqual([true, true]);
    expect(validate).toHaveBeenCalledTimes(1);
  });

  it("forgets every pass when invalidated", async () => {
    const { cache, validate } = setup();

    await cache.isValid("/models/a", customVoice);
    cache.invalidate();
    await cache.isValid("/models/a", customVoice);

    expect(validate).toHaveBeenCalledTimes(2);
  });

  it("does not let a check that started before an invalidation record its pass", async () => {
    const stale = deferred();
    const { cache, validate } = setup();
    validate.mockReturnValueOnce(stale.promise);

    const before = cache.isValid("/models/a", customVoice);
    cache.invalidate();
    stale.resolve(true);
    await expect(before).resolves.toBe(true);
    await cache.isValid("/models/a", customVoice);

    expect(validate).toHaveBeenCalledTimes(2);
  });

  it("starts a fresh check after an invalidation instead of joining a running one", async () => {
    const stale = deferred();
    const { cache, validate } = setup();
    validate.mockReturnValueOnce(stale.promise);

    const before = cache.isValid("/models/a", customVoice);
    cache.invalidate();
    await expect(cache.isValid("/models/a", customVoice)).resolves.toBe(true);
    stale.resolve(false);

    await expect(before).resolves.toBe(false);
    expect(validate).toHaveBeenCalledTimes(2);
    // The fresh pass survives the stale check finishing.
    await cache.isValid("/models/a", customVoice);
    expect(validate).toHaveBeenCalledTimes(2);
  });

  it("propagates a validator failure and checks again next time", async () => {
    const { cache, validate } = setup();
    validate.mockRejectedValueOnce(new Error("disk unavailable"));

    await expect(cache.isValid("/models/a", customVoice)).rejects.toThrow("disk unavailable");
    await expect(cache.isValid("/models/a", customVoice)).resolves.toBe(true);

    expect(validate).toHaveBeenCalledTimes(2);
  });

  it("remembers a bounded number of folders, dropping the oldest first", async () => {
    const { cache, validate } = setup();

    for (let index = 0; index <= 16; index += 1) await cache.isValid(`/models/${index}`, customVoice);
    validate.mockClear();
    await cache.isValid("/models/16", customVoice);
    await cache.isValid("/models/1", customVoice);
    await cache.isValid("/models/0", customVoice);

    expect(validate.mock.calls).toEqual([["/models/0", customVoice]]);
  });
});
