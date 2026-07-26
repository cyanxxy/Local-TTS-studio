// @vitest-environment node

import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";
import { getDirectorySizeBytes } from "./directorySize";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((dir) => (
    fs.rm(dir, { recursive: true, force: true })
  )));
});

describe("getDirectorySizeBytes", () => {
  it("sums files across concurrently visited nested directories", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "open-tts-size-"));
    temporaryDirectories.push(root);
    await fs.mkdir(path.join(root, "first"));
    await fs.mkdir(path.join(root, "second"));
    await Promise.all([
      fs.writeFile(path.join(root, "root.bin"), Buffer.alloc(11)),
      fs.writeFile(path.join(root, "first", "model.bin"), Buffer.alloc(2_000)),
      fs.writeFile(path.join(root, "second", "tokenizer.bin"), Buffer.alloc(333)),
    ]);

    await expect(getDirectorySizeBytes(root)).resolves.toBe(2_344);
  });

  it("returns zero when the directory disappears", async () => {
    await expect(getDirectorySizeBytes(path.join(os.tmpdir(), "open-tts-missing-size")))
      .resolves.toBe(0);
  });
});
