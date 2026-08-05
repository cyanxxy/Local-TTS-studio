// @vitest-environment node

import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AUDIO8_CACHE_NAMESPACE, AUDIO8_MODEL_REVISION } from "./audio8Model";
import {
  clearAudio8Cache,
  getAudio8CacheDir,
  getAudio8ModelDir,
  pruneStaleAudio8Revisions,
  readAudio8CacheInfo,
} from "./audio8Cache";

const STALE_REVISION = "0000000000000000000000000000000000000000";

const temporaryDirectories: string[] = [];

async function createUserDataDir(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "open-tts-audio8-cache-"));
  temporaryDirectories.push(root);
  return root;
}

async function writeRevisionFile(
  userDataPath: string,
  revision: string,
  file: string,
  bytes: number,
): Promise<void> {
  const target = path.join(getAudio8CacheDir(userDataPath), revision, file);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, Buffer.alloc(bytes));
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(temporaryDirectories.splice(0).map((dir) => (
    fs.rm(dir, { recursive: true, force: true })
  )));
});

describe("Audio8 cache paths", () => {
  it("nests the worker's model directory under the shared namespace", async () => {
    const userDataPath = await createUserDataDir();

    expect(getAudio8CacheDir(userDataPath))
      .toBe(path.join(userDataPath, "local-model-cache", AUDIO8_CACHE_NAMESPACE));
    expect(getAudio8ModelDir(userDataPath))
      .toBe(path.join(getAudio8CacheDir(userDataPath), AUDIO8_MODEL_REVISION));
  });
});

describe("readAudio8CacheInfo", () => {
  it("reports an unused cache as missing rather than failing", async () => {
    const userDataPath = await createUserDataDir();

    await expect(readAudio8CacheInfo(userDataPath)).resolves.toEqual({
      path: getAudio8CacheDir(userDataPath),
      exists: false,
      sizeBytes: 0,
    });
  });

  it("sums every revision so a bump cannot hide its predecessor's footprint", async () => {
    const userDataPath = await createUserDataDir();
    await writeRevisionFile(userDataPath, AUDIO8_MODEL_REVISION, "slow_ar_int4.onnx.data", 2_000);
    await writeRevisionFile(userDataPath, AUDIO8_MODEL_REVISION, "voices/clara/codes.npy", 44);
    await writeRevisionFile(userDataPath, STALE_REVISION, "codec_decoder_fp16.onnx.data", 500);

    await expect(readAudio8CacheInfo(userDataPath)).resolves.toEqual({
      path: getAudio8CacheDir(userDataPath),
      exists: true,
      sizeBytes: 2_544,
    });
  });

  it("treats a file squatting on the namespace path as no cache at all", async () => {
    const userDataPath = await createUserDataDir();
    const cachePath = getAudio8CacheDir(userDataPath);
    await fs.mkdir(path.dirname(cachePath), { recursive: true });
    await fs.writeFile(cachePath, Buffer.alloc(16));

    await expect(readAudio8CacheInfo(userDataPath)).resolves.toEqual({
      path: cachePath,
      exists: false,
      sizeBytes: 0,
    });
  });
});

describe("clearAudio8Cache", () => {
  it("removes every revision, current one included", async () => {
    const userDataPath = await createUserDataDir();
    await writeRevisionFile(userDataPath, AUDIO8_MODEL_REVISION, "slow_ar_int4.onnx", 128);
    await writeRevisionFile(userDataPath, STALE_REVISION, "slow_ar_int4.onnx", 128);

    await expect(clearAudio8Cache(userDataPath)).resolves.toEqual({
      path: getAudio8CacheDir(userDataPath),
      cleared: true,
    });
    await expect(fs.stat(getAudio8CacheDir(userDataPath))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reports success when there was nothing to clear", async () => {
    const userDataPath = await createUserDataDir();

    await expect(clearAudio8Cache(userDataPath)).resolves.toEqual({
      path: getAudio8CacheDir(userDataPath),
      cleared: true,
    });
  });
});

describe("pruneStaleAudio8Revisions", () => {
  it("removes superseded revisions and leaves the live model directory intact", async () => {
    const userDataPath = await createUserDataDir();
    await writeRevisionFile(userDataPath, AUDIO8_MODEL_REVISION, "slow_ar_int4.onnx.data", 64);
    await writeRevisionFile(userDataPath, STALE_REVISION, "slow_ar_int4.onnx.data", 64);
    await writeRevisionFile(userDataPath, "deadbeef", "voices/ben/meta.json", 8);

    await expect(pruneStaleAudio8Revisions(userDataPath))
      .resolves.toEqual(expect.arrayContaining([STALE_REVISION, "deadbeef"]));
    await expect(fs.readdir(getAudio8CacheDir(userDataPath))).resolves.toEqual([AUDIO8_MODEL_REVISION]);
    await expect(readAudio8CacheInfo(userDataPath)).resolves.toMatchObject({ sizeBytes: 64 });
  });

  it("leaves loose files alone", async () => {
    const userDataPath = await createUserDataDir();
    await writeRevisionFile(userDataPath, STALE_REVISION, "slow_ar_int4.onnx", 8);
    await fs.writeFile(path.join(getAudio8CacheDir(userDataPath), ".DS_Store"), Buffer.alloc(4));

    await expect(pruneStaleAudio8Revisions(userDataPath)).resolves.toEqual([STALE_REVISION]);
    await expect(fs.readdir(getAudio8CacheDir(userDataPath))).resolves.toEqual([".DS_Store"]);
  });

  it("does nothing when no cache has been downloaded", async () => {
    const userDataPath = await createUserDataDir();

    await expect(pruneStaleAudio8Revisions(userDataPath)).resolves.toEqual([]);
  });

  it("tolerates a concurrent clear deleting the tree mid-prune", async () => {
    const userDataPath = await createUserDataDir();
    await writeRevisionFile(userDataPath, AUDIO8_MODEL_REVISION, "slow_ar_int4.onnx", 8);
    await writeRevisionFile(userDataPath, STALE_REVISION, "slow_ar_int4.onnx", 8);

    const [pruned, cleared] = await Promise.all([
      pruneStaleAudio8Revisions(userDataPath),
      clearAudio8Cache(userDataPath),
    ]);

    expect(pruned.every((name) => name === STALE_REVISION)).toBe(true);
    expect(cleared.cleared).toBe(true);
    await expect(fs.stat(getAudio8CacheDir(userDataPath))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("skips a revision it cannot unlink instead of failing the load that triggered it", async () => {
    const userDataPath = await createUserDataDir();
    await writeRevisionFile(userDataPath, STALE_REVISION, "slow_ar_int4.onnx", 8);
    await writeRevisionFile(userDataPath, "deadbeef", "slow_ar_int4.onnx", 8);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const removeDirectory = fs.rm.bind(fs);
    vi.spyOn(fs, "rm").mockImplementation((target, options) => (
      String(target).endsWith(STALE_REVISION)
        ? Promise.reject(new Error("EBUSY: resource busy or locked"))
        : removeDirectory(target, options)
    ));

    await expect(pruneStaleAudio8Revisions(userDataPath)).resolves.toEqual(["deadbeef"]);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining(STALE_REVISION),
      expect.any(Error),
    );
  });
});
