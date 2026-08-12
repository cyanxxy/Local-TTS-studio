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

type KokoroPlugin = ReturnType<typeof kokoroOnnxWasmAssetPlugin>;

// Vite types every plugin hook as an ObjectHook union: the bare function, or an
// object wrapping it as `handler`. Unwrap once here so each test can invoke a
// hook directly. Declaring the parameter without a `this` also lets callers
// supply the small stub context a hook reads instead of a real PluginContext.
function pluginHook<Args extends unknown[], Result>(
  hook: ((...args: Args) => Result) | { handler: (...args: Args) => Result } | undefined,
  name: string,
): (...args: Args) => Result {
  const handler = typeof hook === "function" ? hook : hook?.handler;
  if (typeof handler !== "function") {
    throw new Error(`Expected plugin.${name} to be a function`);
  }
  return handler;
}

function resolveId(plugin: KokoroPlugin, id: string) {
  return pluginHook(plugin.resolveId, "resolveId")(id, undefined, { isEntry: false });
}

function loadModule(plugin: KokoroPlugin, id: string, context: object = {}) {
  return pluginHook(plugin.load, "load").call(context, id);
}

function loadVirtualModule(plugin: KokoroPlugin, context: object = {}): string {
  return String(loadModule(plugin, "\0virtual:kokoro-onnx-wasm-assets", context));
}

function transformCode(plugin: KokoroPlugin, code: string, id: string): string | null {
  const result = pluginHook(plugin.transform, "transform").call({}, code, id);
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
    const resolved = resolveId(plugin, "virtual:kokoro-onnx-wasm-assets");

    expect(plugin.name).toBe("open-tts:kokoro-onnx-wasm-assets");
    expect(plugin.enforce).toBe("pre");
    expect(resolved).toBe("\0virtual:kokoro-onnx-wasm-assets");
    expect(resolveId(plugin, "other")).toBeNull();
    expect(loadModule(plugin, "other")).toBeNull();
    expect(loadVirtualModule(plugin)).toContain("KOKORO_ONNX_JSEP_ASSETS");
  });

  it("emits the JSEP module as a Rollup asset during build", () => {
    const root = makeAssetRoot();
    const plugin = kokoroOnnxWasmAssetPlugin(root);
    const emitFile = vi.fn(() => "assetRef");

    // The hook reads only `config.command`; a full ResolvedConfig is not constructible here.
    pluginHook(plugin.configResolved, "configResolved").call({}, { command: "build" } as never);

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

    expect(() => loadModule(plugin, "\0virtual:kokoro-onnx-wasm-assets")).toThrow("Missing Kokoro ONNX Runtime asset");
  });
});
