// @vitest-environment node

import { promises as fs } from "fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { removeTreeOptions, renameWithRetry } from "./fsRetry";

const busy = () => Object.assign(new Error("EBUSY: resource busy or locked"), { code: "EBUSY" });

afterEach(() => {
  vi.restoreAllMocks();
});

describe("renameWithRetry", () => {
  it("retries a rename Windows reports as held by another process", async () => {
    const rename = vi.spyOn(fs, "rename").mockRejectedValueOnce(busy()).mockResolvedValueOnce(undefined);

    await renameWithRetry("from", "to", { delayMs: 0, platform: "win32" });

    expect(rename).toHaveBeenCalledTimes(2);
  });

  it("gives up after the last attempt", async () => {
    const rename = vi.spyOn(fs, "rename").mockRejectedValue(busy());

    await expect(renameWithRetry("from", "to", { attempts: 3, delayMs: 0, platform: "win32" })).rejects.toThrow("EBUSY");
    expect(rename).toHaveBeenCalledTimes(3);
  });

  it("throws at once on other platforms and for other errors", async () => {
    const rename = vi.spyOn(fs, "rename").mockRejectedValue(busy());
    await expect(renameWithRetry("from", "to", { delayMs: 0, platform: "darwin" })).rejects.toThrow("EBUSY");
    expect(rename).toHaveBeenCalledTimes(1);

    rename.mockReset().mockRejectedValue(Object.assign(new Error("ENOENT"), { code: "ENOENT" }));
    await expect(renameWithRetry("from", "to", { delayMs: 0, platform: "win32" })).rejects.toThrow("ENOENT");
    expect(rename).toHaveBeenCalledTimes(1);
  });
});

describe("removeTreeOptions", () => {
  it("retries a held file on Windows only", () => {
    expect(removeTreeOptions("win32")).toMatchObject({ recursive: true, force: true, maxRetries: 5 });
    expect(removeTreeOptions("darwin")).toEqual({ recursive: true, force: true });
  });
});
