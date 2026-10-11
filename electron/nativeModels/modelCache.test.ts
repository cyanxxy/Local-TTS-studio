// @vitest-environment node

import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearNativeModelCache,
  getNativeModelCacheDir,
  getNativeModelDir,
  pruneStaleNativeModelRevisions,
  readNativeModelCacheInfo,
} from "./modelCache";

const KITTEN = { cacheNamespace: "kitten", revision: "1111111111111111111111111111111111111111" };
const AUDIO8 = { cacheNamespace: "audio8", revision: "2222222222222222222222222222222222222222" };

const temporaryDirectories: string[] = [];

async function createUserDataDir(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "open-tts-native-cache-"));
  temporaryDirectories.push(root);
  return root;
}

async function writeFile(target: string, bytes: number): Promise<void> {
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, Buffer.alloc(bytes));
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(temporaryDirectories.splice(0).map((dir) => (
    fs.rm(dir, { recursive: true, force: true })
  )));
});

describe("native model cache", () => {
  it("gives every model its own namespace and revision directory", async () => {
    const userDataPath = await createUserDataDir();

    expect(getNativeModelCacheDir(userDataPath, KITTEN)).toBe(path.join(userDataPath, "local-model-cache", "kitten"));
    expect(getNativeModelDir(userDataPath, KITTEN))
      .toBe(path.join(userDataPath, "local-model-cache", "kitten", KITTEN.revision));
  });

  it("sizes, prunes and clears one model without touching another", async () => {
    const userDataPath = await createUserDataDir();
    await writeFile(path.join(getNativeModelDir(userDataPath, KITTEN), "model.onnx"), 300);
    await writeFile(path.join(getNativeModelCacheDir(userDataPath, KITTEN), "stale", "model.onnx"), 200);
    await writeFile(path.join(getNativeModelDir(userDataPath, AUDIO8), "model.onnx"), 50);
    await writeFile(path.join(getNativeModelCacheDir(userDataPath, AUDIO8), "older", "model.onnx"), 25);

    await expect(readNativeModelCacheInfo(userDataPath, KITTEN)).resolves.toEqual({
      path: getNativeModelCacheDir(userDataPath, KITTEN),
      exists: true,
      sizeBytes: 500,
    });
    await expect(pruneStaleNativeModelRevisions(userDataPath, KITTEN)).resolves.toEqual(["stale"]);
    await expect(readNativeModelCacheInfo(userDataPath, KITTEN)).resolves.toMatchObject({ sizeBytes: 300 });
    await expect(clearNativeModelCache(userDataPath, KITTEN)).resolves.toEqual({
      path: getNativeModelCacheDir(userDataPath, KITTEN),
      cleared: true,
    });

    await expect(readNativeModelCacheInfo(userDataPath, KITTEN)).resolves.toMatchObject({ exists: false });
    await expect(readNativeModelCacheInfo(userDataPath, AUDIO8)).resolves.toMatchObject({ exists: true, sizeBytes: 75 });
  });

  it("names the model's namespace when a stale revision cannot be pruned", async () => {
    const userDataPath = await createUserDataDir();
    await writeFile(path.join(getNativeModelCacheDir(userDataPath, KITTEN), "stale", "model.onnx"), 8);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(fs, "rm").mockRejectedValue(new Error("EBUSY: resource busy or locked"));

    await expect(pruneStaleNativeModelRevisions(userDataPath, KITTEN)).resolves.toEqual([]);
    expect(warn).toHaveBeenCalledWith("[kitten] Could not prune stale model revision stale:", expect.any(Error));
  });
});
