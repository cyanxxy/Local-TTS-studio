// @vitest-environment node

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  buildManifest,
  diffManifests,
  gitBlobSha1,
  globToRegExp,
  manifestTypeImportPath,
  parseArgs,
  parseRenderedManifest,
  regenerateCommand,
  renderManifest,
  resolveFileUrl,
  revisionInfoUrl,
  selectFiles,
} from "./scripts/pin-hf-assets.mjs";

const REVISION = "3cadd1ee6394adea1bd021217a0e650ede09a323";
const CONFIG_BYTES = new TextEncoder().encode('{"ae":{"sample_rate":44100}}');

// Shaped like GET /api/models/<repo>/revision/<sha>?blobs=true.
function revisionInfo() {
  return {
    id: "Example/tts",
    sha: REVISION,
    siblings: [
      { rfilename: "README.md", blobId: "6f4f5c5d7afbe9d45bc107ebc9c6629c3ea5c135", size: 9189 },
      { rfilename: "onnx/tts.json", blobId: gitBlobSha1(CONFIG_BYTES), size: CONFIG_BYTES.byteLength },
      {
        rfilename: "onnx/vocoder.onnx",
        blobId: "b50be323eb0a124468b665e0e3e8380710090744",
        size: 101_424_195,
        lfs: { sha256: "085de76dd8e8d5836d6ca66826601f615939218f90e519f70ee8a36ed2a4c4ba", size: 101_424_195, pointerSize: 134 },
      },
      { rfilename: "onnx/extra/nested.onnx", blobId: "000b60436b77619b933fdc33628ad737595e6794", size: 10 },
    ],
  };
}

const baseOptions = () => parseArgs([
  "--repo", "Example/tts",
  "--revision", REVISION,
  "--include", "onnx/*",
  "--name", "EXAMPLE_ASSETS",
  "--out", "src/workers/manifests/example.ts",
]);

describe("pin-hf-assets arguments", () => {
  it("parses repeated patterns and flags", () => {
    expect(parseArgs([
      "--repo=Example/tts",
      `--revision=${REVISION}`,
      "--include", "onnx/*",
      "--include", "voice_styles/*",
      "--exclude", "*.md",
      "--license", "apache-2.0",
      "--license=mit",
      "--sha256",
      "--check",
      "--out", "manifest.json",
    ])).toEqual({
      repo: "Example/tts",
      revision: REVISION,
      include: ["onnx/*", "voice_styles/*"],
      exclude: ["*.md"],
      licenses: ["apache-2.0", "mit"],
      name: "PINNED_ASSETS",
      out: "manifest.json",
      check: true,
      sha256: true,
    });
  });

  it("refuses mutable revisions, malformed ids, and incomplete commands", () => {
    expect(() => parseArgs(["--repo", "Example/tts", "--revision", "main"])).toThrow(/full 40-character commit SHA/);
    expect(() => parseArgs(["--repo", "Example/tts", "--revision", REVISION.slice(0, 7)])).toThrow(/full 40-character/);
    expect(() => parseArgs(["--repo", "../etc/passwd", "--revision", REVISION])).toThrow(/--repo must be/);
    expect(() => parseArgs(["--repo", "Example/tts", "--revision", REVISION, "--name", "lower"])).toThrow(/UPPER_SNAKE_CASE/);
    expect(() => parseArgs(["--repo", "Example/tts", "--revision", REVISION, "--check"])).toThrow(/--check needs --out/);
    expect(() => parseArgs(["--repo"])).toThrow(/requires a value/);
    expect(() => parseArgs(["--bogus"])).toThrow(/Unknown option/);
  });
});

describe("pin-hf-assets file selection", () => {
  it("keeps single-star globs inside one path segment", () => {
    expect(globToRegExp("onnx/*").test("onnx/tts.json")).toBe(true);
    expect(globToRegExp("onnx/*").test("onnx/extra/nested.onnx")).toBe(false);
    expect(globToRegExp("**/*.onnx").test("onnx/extra/nested.onnx")).toBe(true);
    expect(globToRegExp("voices/a?.bin").test("voices/af.bin")).toBe(true);
    expect(globToRegExp("onnx/model.onnx").test("onnx/modelXonnx")).toBe(false);
  });

  it("selects included, non-excluded files in sorted order", () => {
    const paths = ["voices/b.bin", "onnx/z.onnx", "README.md", "onnx/a.onnx"];
    expect(selectFiles(paths, { include: ["onnx/*", "voices/*"], exclude: ["onnx/z.*"] }))
      .toEqual(["onnx/a.onnx", "voices/b.bin"]);
    expect(selectFiles(paths)).toEqual(["README.md", "onnx/a.onnx", "onnx/z.onnx", "voices/b.bin"]);
  });

  it("builds Hub URLs at the pinned commit", () => {
    expect(revisionInfoUrl("Example/tts", REVISION))
      .toBe(`https://huggingface.co/api/models/Example/tts/revision/${REVISION}?blobs=true`);
    expect(resolveFileUrl("Example/tts", REVISION, "voice styles/M 1.json"))
      .toBe(`https://huggingface.co/Example/tts/resolve/${REVISION}/voice%20styles/M%201.json`);
  });
});

describe("pin-hf-assets manifests", () => {
  it("pins LFS files by SHA-256 and regular files by git blob SHA-1 without downloading", async () => {
    const fetchBytes = vi.fn();
    const manifest = await buildManifest(revisionInfo(), baseOptions(), fetchBytes);

    expect(manifest).toEqual({
      repo: "Example/tts",
      revision: REVISION,
      files: {
        "onnx/tts.json": { byteLength: CONFIG_BYTES.byteLength, gitBlobSha1: gitBlobSha1(CONFIG_BYTES) },
        "onnx/vocoder.onnx": {
          byteLength: 101_424_195,
          sha256: "085de76dd8e8d5836d6ca66826601f615939218f90e519f70ee8a36ed2a4c4ba",
        },
      },
    });
    expect(fetchBytes).not.toHaveBeenCalled();
  });

  it("computes SHA-256 for regular files with --sha256 after checking their git blob id", async () => {
    const options = { ...baseOptions(), sha256: true };
    const fetchBytes = vi.fn(async () => CONFIG_BYTES);
    const manifest = await buildManifest(revisionInfo(), options, fetchBytes);

    expect(fetchBytes).toHaveBeenCalledExactlyOnceWith("onnx/tts.json");
    expect(manifest.files["onnx/tts.json"]).toEqual({
      byteLength: CONFIG_BYTES.byteLength,
      sha256: createHash("sha256").update(CONFIG_BYTES).digest("hex"),
    });

    const tampered = vi.fn(async () => new TextEncoder().encode('{"ae":{"sample_rate":22050}}'));
    await expect(buildManifest(revisionInfo(), options, tampered)).rejects.toThrow(/different size or git blob id/);
  });

  it("records the card license only when it is on the --license allow-list", async () => {
    const options = { ...baseOptions(), licenses: ["apache-2.0", "mit"] };
    const licensed = { ...revisionInfo(), cardData: { license: "mit" } };

    expect(await buildManifest(licensed, options)).toMatchObject({ repo: "Example/tts", revision: REVISION, license: "mit" });
    expect(Object.keys(await buildManifest(licensed, options))).toEqual(["repo", "revision", "license", "files"]);
    // Without --license nothing is checked or recorded.
    expect(await buildManifest(licensed, baseOptions())).not.toHaveProperty("license");
    await expect(buildManifest({ ...revisionInfo(), cardData: { license: "cc-by-nc-4.0" } }, options))
      .rejects.toThrow('Example/tts is licensed "cc-by-nc-4.0", which is not one of --license apache-2.0, mit.');
    await expect(buildManifest(revisionInfo(), options)).rejects.toThrow("is licensed null");
    expect(regenerateCommand(options)).toContain('--include "onnx/*" --license apache-2.0 --license mit --name EXAMPLE_ASSETS');
  });

  it("rejects responses for another commit, empty selections, and inconsistent metadata", async () => {
    await expect(buildManifest({ ...revisionInfo(), sha: "f".repeat(40) }, baseOptions()))
      .rejects.toThrow(/resolved .* to f{40}/);
    await expect(buildManifest(revisionInfo(), { ...baseOptions(), include: ["missing/*"] }))
      .rejects.toThrow(/No files/);
    await expect(buildManifest({ sha: REVISION }, baseOptions())).rejects.toThrow(/no file list/);

    const withBadLfs = revisionInfo();
    withBadLfs.siblings[2].lfs!.size = 1;
    await expect(buildManifest(withBadLfs, baseOptions())).rejects.toThrow(/inconsistent LFS metadata/);

    const withoutSize = revisionInfo();
    delete (withoutSize.siblings[1] as { size?: number }).size;
    await expect(buildManifest(withoutSize, baseOptions())).rejects.toThrow(/no valid size/);
  });

  it("renders a typed module that parses back to the same manifest", async () => {
    const options = baseOptions();
    const manifest = await buildManifest(revisionInfo(), options);
    const rendered = renderManifest(manifest, options);

    expect(rendered).toContain(`//   ${regenerateCommand(options)}`);
    expect(rendered).toContain('import type { PinnedAssetManifest } from "../../lib/pinnedModelFetch";');
    expect(rendered).toContain("export const EXAMPLE_ASSETS = {");
    expect(rendered.trimEnd().endsWith("} as const satisfies PinnedAssetManifest;")).toBe(true);
    expect(parseRenderedManifest(rendered)).toEqual(manifest);

    const json = renderManifest(manifest, { ...options, out: "manifest.json" });
    expect(JSON.parse(json)).toEqual(manifest);
    expect(parseRenderedManifest(json)).toEqual(manifest);
    expect(() => parseRenderedManifest("export const nope = 1;")).toThrow(/not a manifest/);
  });

  it("imports the manifest type relative to where the module is written", () => {
    expect(manifestTypeImportPath("src/workers/manifests/example.ts")).toBe("../../lib/pinnedModelFetch");
    expect(manifestTypeImportPath("src/lib/example.ts")).toBe("./pinnedModelFetch");
    expect(manifestTypeImportPath(null)).toBe("../../lib/pinnedModelFetch");
  });

  it("describes what changed between two manifests", () => {
    const previous = {
      repo: "Example/tts",
      revision: REVISION,
      files: {
        "a.json": { byteLength: 1, gitBlobSha1: "1".repeat(40) },
        "b.onnx": { byteLength: 2, sha256: "2".repeat(64) },
      },
    };
    const next = {
      repo: "Example/tts",
      revision: "f".repeat(40),
      files: {
        "b.onnx": { byteLength: 3, sha256: "3".repeat(64) },
        "c.onnx": { byteLength: 4, sha256: "4".repeat(64) },
      },
    };

    expect(diffManifests(previous, previous)).toEqual([]);
    expect(diffManifests(previous, { ...previous, license: "mit" })).toEqual(["license: undefined -> mit"]);
    expect(diffManifests(previous, next)).toEqual([
      `revision: ${REVISION} -> ${"f".repeat(40)}`,
      "removed a.json",
      "changed b.onnx",
      "added c.onnx",
    ]);
  });

  it.each([
    "src/workers/manifests/kitten.ts",
    "src/workers/manifests/kokoro.ts",
    "src/workers/manifests/paradee.ts",
    "src/workers/manifests/supertonic3.ts",
  ])("keeps the committed %s identical to what its regenerate command renders", (path) => {
    const text = readFileSync(path, "utf8");
    const command = /^\/\/ {3}(node scripts\/pin-hf-assets\.mjs .+)$/m.exec(text)?.[1];
    expect(command).toBeDefined();
    const args = [...command!.matchAll(/"([^"]*)"|(\S+)/g)].map((match) => match[1] ?? match[2]).slice(2);
    const options = parseArgs(args);

    expect(options.out).toBe(path);
    expect(renderManifest(parseRenderedManifest(text), options)).toBe(text);
  });
});
