// @vitest-environment node

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

interface PackageMetadata {
  version?: string;
  dependencies?: Record<string, string>;
}

interface LockfileMetadata {
  packages?: Record<string, { version?: string }>;
}

function readPackage(relativePath: string): PackageMetadata {
  return JSON.parse(fs.readFileSync(path.resolve(relativePath), "utf8")) as PackageMetadata;
}

function readLockfile(relativePath: string): LockfileMetadata {
  return JSON.parse(fs.readFileSync(path.resolve(relativePath), "utf8")) as LockfileMetadata;
}

describe("app-level ONNX Runtime dependency", () => {
  it("stays exactly aligned with the Transformers.js runtime that consumes its WASM assets", () => {
    const app = readPackage("package.json");
    const transformers = readPackage("node_modules/@huggingface/transformers/package.json");
    const runtime = readPackage("node_modules/onnxruntime-web/package.json");
    const appRuntime = app.dependencies?.["onnxruntime-web"];
    const transformersRuntime = transformers.dependencies?.["onnxruntime-web"];

    expect(appRuntime).toMatch(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
    expect(appRuntime).toBe(transformersRuntime);
    expect(runtime.version).toBe(appRuntime);
  });
});

describe("app-level ONNX Runtime native dependency", () => {
  it("resolves to a single exact version across every consumer in the install", () => {
    const app = readPackage("package.json");
    const runtime = readPackage("node_modules/onnxruntime-node/package.json");
    const lockfile = readLockfile("package-lock.json");
    const appRuntime = app.dependencies?.["onnxruntime-node"];

    expect(appRuntime).toMatch(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
    expect(runtime.version).toBe(appRuntime);

    // Transformers.js and kokoro-js each depend on onnxruntime-node too, and Transformers.js
    // imports it statically. A second resolved copy would load a second ORT native library into
    // the same worker thread, so the `overrides` pin must collapse them all onto one version.
    const resolvedVersions = Object.entries(lockfile.packages ?? {})
      .filter(([installPath]) => installPath.endsWith("node_modules/onnxruntime-node"))
      .map(([, entry]) => entry.version);

    expect(resolvedVersions.length).toBeGreaterThan(0);
    expect([...new Set(resolvedVersions)]).toEqual([appRuntime]);
  });
});
