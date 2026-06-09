// @vitest-environment node

import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { kokoroOnnxWasmAssetPlugin } from "./vite.kokoroAssets";

function makeAssetRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "kokoro-assets-"));
  const assetDir = join(root, "node_modules/kokoro-js/node_modules/onnxruntime-web/dist");
  mkdirSync(assetDir, { recursive: true });
  writeFileSync(join(assetDir, "ort-wasm-simd-threaded.jsep.mjs"), "");
  writeFileSync(join(assetDir, "ort-wasm-simd-threaded.jsep.wasm"), "");
  return root;
}

function loadVirtualModule(
  plugin: ReturnType<typeof kokoroOnnxWasmAssetPlugin>,
  context: object = {},
): string {
  if (typeof plugin.load !== "function") {
    throw new Error("Expected plugin.load to be a function");
  }

  return String(plugin.load.call(context as never, "\0virtual:kokoro-onnx-wasm-assets"));
}

function transformCode(
  plugin: ReturnType<typeof kokoroOnnxWasmAssetPlugin>,
  code: string,
  id: string,
): string | null {
  if (typeof plugin.transform !== "function") {
    return null;
  }

  const result = plugin.transform.call({} as never, code, id);
  if (typeof result === "string") return result;
  if (result && typeof result === "object" && "code" in result) {
    return String(result.code);
  }

  return null;
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
    expect(loadVirtualModule(plugin)).toContain("KOKORO_ONNX_JSEP_ASSETS");
  });

  it("emits the JSEP module as a Rollup asset during build", () => {
    const root = makeAssetRoot();
    const plugin = kokoroOnnxWasmAssetPlugin(root);
    const emitFile = vi.fn(() => "assetRef");

    if (typeof plugin.configResolved === "function") {
      plugin.configResolved.call({} as never, { command: "build" } as never);
    }

    const code = loadVirtualModule(plugin, { emitFile });

    expect(emitFile).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "asset",
        name: "ort-wasm-simd-threaded.jsep.mjs",
      }),
    );
    expect(code).toContain("const mjsUrl = import.meta.ROLLUP_FILE_URL_assetRef;");
    expect(code).not.toContain("ort-wasm-simd-threaded.jsep.mjs?url");
  });

  it("suppresses Vite asset rewriting for Kokoro's bundled ONNX JSEP wasm fallback", () => {
    const root = makeAssetRoot();
    const plugin = kokoroOnnxWasmAssetPlugin(root);
    const code =
      'const fallbackUrl = new URL("ort-wasm-simd-threaded.jsep.wasm", import.meta.url).href;';

    const transformed = transformCode(
      plugin,
      code,
      join(root, "node_modules/kokoro-js/dist/kokoro.web.js"),
    );

    expect(transformed).toContain(
      'new URL(/* @vite-ignore */ "ort-wasm-simd-threaded.jsep.wasm", import.meta.url)',
    );
  });

  it("exposes Kokoro's internal ONNX Runtime wasm thread setting", () => {
    const root = makeAssetRoot();
    const plugin = kokoroOnnxWasmAssetPlugin(root);
    const code =
      "const Mf={set wasmPaths(e){Wg.backends.onnx.wasm.wasmPaths=e},get wasmPaths(){return Wg.backends.onnx.wasm.wasmPaths}};";

    const transformed = transformCode(
      plugin,
      code,
      join(root, "node_modules/kokoro-js/dist/kokoro.web.js"),
    );

    expect(transformed).toContain("set numThreads(e){Wg.backends.onnx.wasm.numThreads=e}");
    expect(transformed).toContain("get numThreads(){return Wg.backends.onnx.wasm.numThreads}");
  });

  it("throws a clear error when a required asset is missing", () => {
    const root = mkdtempSync(join(tmpdir(), "kokoro-assets-missing-"));
    const plugin = kokoroOnnxWasmAssetPlugin(root);

    expect(() => plugin.load?.("\0virtual:kokoro-onnx-wasm-assets")).toThrow("Missing Kokoro ONNX Runtime asset");
  });
});
