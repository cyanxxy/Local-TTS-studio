// @vitest-environment node

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { kokoroOnnxWasmAssetPlugin, transformKokoroBrowserBuild } from "./vite.kokoroAssets";

// The shapes every patch targets, as they appear in kokoro-js 1.2.1's minified build.
const FAKE_KOKORO_BUILD = [
  'const fallbackUrl = new URL("ort-wasm-simd-threaded.jsep.wasm", import.meta.url).href;',
  'async function df(e,A="a",t=!0){return e}',
  "class Ef{}class kf{}",
  "const Mf={set wasmPaths(e){Wg.backends.onnx.wasm.wasmPaths=e},get wasmPaths(){return Wg.backends.onnx.wasm.wasmPaths}};",
  "export{Ef as KokoroTTS,kf as TextSplitterStream,Mf as env};",
].join("");

function makeAssetRoot(kokoroBuild: string = FAKE_KOKORO_BUILD): string {
  const root = mkdtempSync(join(tmpdir(), "kokoro-assets-"));
  const assetDir = join(root, "node_modules/kokoro-js/node_modules/onnxruntime-web/dist");
  mkdirSync(assetDir, { recursive: true });
  writeFileSync(join(assetDir, "ort-wasm-simd-threaded.jsep.mjs"), "");
  writeFileSync(join(assetDir, "ort-wasm-simd-threaded.jsep.wasm"), "");
  const kokoroDir = join(root, "node_modules/kokoro-js/dist");
  mkdirSync(kokoroDir, { recursive: true });
  writeFileSync(join(kokoroDir, "kokoro.web.js"), kokoroBuild);
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

function transformCode(plugin: KokoroPlugin, code: string, id: string, warn = vi.fn()): string | null {
  const result = pluginHook(plugin.transform, "transform").call({ warn }, code, id);
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

  it("ships kokoro.web.js as an unbundled asset so its espeak-ng runtime survives", () => {
    const root = makeAssetRoot();
    const plugin = kokoroOnnxWasmAssetPlugin(root);
    const emitFile = vi.fn<(file: { name: string; source: string }) => string>(() => "kokoroRef");

    pluginHook(plugin.configResolved, "configResolved").call({}, { command: "build" } as never);
    const code = loadVirtualModule(plugin, { emitFile });
    const kokoroAsset = emitFile.mock.calls
      .map(([file]) => file)
      .find((file) => file.name === "kokoro.web.js");

    expect(kokoroAsset?.source).toContain("/* @vite-ignore */");
    expect(kokoroAsset?.source).toContain("export{df as phonemize,Ef as KokoroTTS,kf as TextSplitterStream,Mf as env};");
    expect(code).toContain("export const KOKORO_WEB_MODULE_URL = import.meta.ROLLUP_FILE_URL_kokoroRef;");
  });

  it("fails the build when a kokoro-js patch no longer applies", () => {
    const root = makeAssetRoot('const fallbackUrl = new URL("ort-wasm-simd-threaded.jsep.wasm", import.meta.url).href;');
    const plugin = kokoroOnnxWasmAssetPlugin(root);

    pluginHook(plugin.configResolved, "configResolved").call({}, { command: "build" } as never);

    expect(() => loadVirtualModule(plugin, { emitFile: vi.fn(() => "ref") }))
      .toThrow("kokoro-js/dist/kokoro.web.js no longer matches the patches in vite.kokoroAssets.ts (the WASM numThreads setting, the phonemize export).");
  });

  it("serves kokoro.web.js by URL during dev", () => {
    const root = makeAssetRoot();
    const code = loadVirtualModule(kokoroOnnxWasmAssetPlugin(root));
    expect(code).toContain("kokoro-js/dist/kokoro.web.js?url");
    expect(code).toContain("export const KOKORO_WEB_MODULE_URL = kokoroUrl;");
  });

  it("suppresses Vite asset rewriting for Kokoro's bundled ONNX JSEP wasm fallback", () => {
    const root = makeAssetRoot();
    const plugin = kokoroOnnxWasmAssetPlugin(root);
    const code =
      'const fallbackUrl = new URL("ort-wasm-simd-threaded.jsep.wasm", import.meta.url).href;';

    const warn = vi.fn();
    const transformed = transformCode(
      plugin,
      code,
      join(root, "node_modules/kokoro-js/dist/kokoro.web.js"),
      warn,
    );

    expect(transformed).toContain(
      'new URL(/* @vite-ignore */ "ort-wasm-simd-threaded.jsep.wasm", import.meta.url)',
    );
    // A partial build is still served in dev, with a warning naming what is missing.
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("(the WASM numThreads setting, the phonemize export)"));
  });

  it("leaves the dev server's ?url import of kokoro.web.js alone", () => {
    const root = makeAssetRoot();
    const plugin = kokoroOnnxWasmAssetPlugin(root);
    const warn = vi.fn();
    const id = join(root, "node_modules/kokoro-js/dist/kokoro.web.js");

    // The virtual module imports the build with ?url, which loads as a
    // one-line module exporting the URL; only the module itself is patched.
    expect(transformCode(plugin, `export default "/@fs${id}"`, `${id}?url`, warn)).toBeNull();
    expect(transformCode(plugin, FAKE_KOKORO_BUILD, `${id}?t=1700000000000`, warn)).toContain("as phonemize");
    expect(warn).not.toHaveBeenCalled();
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

  it("re-exports kokoro-js's private phonemizer exactly once", () => {
    const { code, missing } = transformKokoroBrowserBuild(FAKE_KOKORO_BUILD);

    expect(missing).toEqual([]);
    expect(code.endsWith("export{df as phonemize,Ef as KokoroTTS,kf as TextSplitterStream,Mf as env};")).toBe(true);
    expect(transformKokoroBrowserBuild(code).code).toBe(code);
  });

  it("exports no phonemizer when the candidate is ambiguous", () => {
    const ambiguous = FAKE_KOKORO_BUILD.replace("class Ef{}", 'async function zz(e,A="a",t=!0){return e}class Ef{}');
    const { code, missing } = transformKokoroBrowserBuild(ambiguous);

    expect(code).not.toContain("as phonemize");
    expect(missing).toEqual(["the phonemize export"]);
  });

  it("applies every patch to the pinned kokoro-js build, whose phonemizer then runs", () => {
    const pinned = readFileSync("node_modules/kokoro-js/dist/kokoro.web.js", "utf8");
    const { code, missing } = transformKokoroBrowserBuild(pinned);
    expect(missing).toEqual([]);

    // kokoro.web.js is self-contained, so the patched build runs under plain
    // Node: phonemize must be the function generate() uses ("a" is American
    // English, "b" British), producing one token per phoneme symbol.
    const modulePath = join(mkdtempSync(join(tmpdir(), "kokoro-web-")), "kokoro.web.mjs");
    writeFileSync(modulePath, code);
    const script = [
      `const kokoro = await import(${JSON.stringify(pathToFileURL(modulePath).href)});`,
      'console.log(JSON.stringify([await kokoro.phonemize("Hello world.", "a"), await kokoro.phonemize("Hello world.", "b")]));',
    ].join("\n");
    const output = execFileSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8" });

    expect(JSON.parse(output.trim().split("\n").at(-1)!)).toEqual(["həlˈoʊ wˈɜːld.", "həlˈəʊ wˈɜːld."]);
  });

  it("throws a clear error when a required asset is missing", () => {
    const root = mkdtempSync(join(tmpdir(), "kokoro-assets-missing-"));
    const plugin = kokoroOnnxWasmAssetPlugin(root);

    expect(() => loadModule(plugin, "\0virtual:kokoro-onnx-wasm-assets")).toThrow("Missing Kokoro ONNX Runtime asset");
  });
});
