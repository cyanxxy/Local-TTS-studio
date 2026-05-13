// @vitest-environment node

import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { kokoroOnnxWasmAssetPlugin } from "./vite.kokoroAssets";

function makeAssetRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "kokoro-assets-"));
  const assetDir = join(root, "node_modules/kokoro-js/node_modules/onnxruntime-web/dist");
  mkdirSync(assetDir, { recursive: true });
  writeFileSync(join(assetDir, "ort-wasm-simd-threaded.jsep.mjs"), "");
  writeFileSync(join(assetDir, "ort-wasm-simd-threaded.jsep.wasm"), "");
  return root;
}

describe("kokoroOnnxWasmAssetPlugin", () => {
  it("resolves the virtual module and emits URL imports for local assets", () => {
    const root = makeAssetRoot();
    const plugin = kokoroOnnxWasmAssetPlugin(root);
    const resolved = plugin.resolveId?.("virtual:kokoro-onnx-wasm-assets");

    expect(plugin.name).toBe("open-tts:kokoro-onnx-wasm-assets");
    expect(plugin.enforce).toBe("pre");
    expect(resolved).toBe("\0virtual:kokoro-onnx-wasm-assets");
    expect(plugin.resolveId?.("other")).toBeNull();
    expect(plugin.load?.("other")).toBeNull();
    expect(String(plugin.load?.("\0virtual:kokoro-onnx-wasm-assets"))).toContain("KOKORO_ONNX_JSEP_ASSETS");
  });

  it("throws a clear error when a required asset is missing", () => {
    const root = mkdtempSync(join(tmpdir(), "kokoro-assets-missing-"));
    const plugin = kokoroOnnxWasmAssetPlugin(root);

    expect(() => plugin.load?.("\0virtual:kokoro-onnx-wasm-assets")).toThrow("Missing Kokoro ONNX Runtime asset");
  });
});
