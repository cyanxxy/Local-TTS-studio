// @vitest-environment node

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

interface PackageMetadata {
  version?: string;
  dependencies?: Record<string, string>;
}

function readPackage(relativePath: string): PackageMetadata {
  return JSON.parse(fs.readFileSync(path.resolve(relativePath), "utf8")) as PackageMetadata;
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
