// @vitest-environment node

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { phonemizerAssetPlugin } from "./vite.phonemizerAssets";

const FAKE_BUILD = "export const phonemize = async () => [];\n";

function makeAssetRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "phonemizer-assets-"));
  const distDir = join(root, "node_modules/phonemizer/dist");
  mkdirSync(distDir, { recursive: true });
  writeFileSync(join(distDir, "phonemizer.js"), FAKE_BUILD);
  return root;
}

type PhonemizerPlugin = ReturnType<typeof phonemizerAssetPlugin>;

// Same ObjectHook unwrapping as vite.kokoroAssets.test.ts.
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

function resolveId(plugin: PhonemizerPlugin, id: string) {
  return pluginHook(plugin.resolveId, "resolveId")(id, undefined, { isEntry: false });
}

function loadModule(plugin: PhonemizerPlugin, id: string, context: object = {}) {
  return pluginHook(plugin.load, "load").call(context, id);
}

function markAsBuild(plugin: PhonemizerPlugin): void {
  // The hook reads only `config.command`; a full ResolvedConfig is not constructible here.
  pluginHook(plugin.configResolved, "configResolved").call({}, { command: "build" } as never);
}

describe("phonemizerAssetPlugin", () => {
  it("resolves only its virtual module", () => {
    const plugin = phonemizerAssetPlugin(makeAssetRoot());

    expect(plugin.name).toBe("open-tts:phonemizer-assets");
    expect(plugin.enforce).toBe("pre");
    expect(resolveId(plugin, "virtual:phonemizer-assets")).toBe("\0virtual:phonemizer-assets");
    expect(resolveId(plugin, "phonemizer")).toBeNull();
    expect(loadModule(plugin, "other")).toBeNull();
  });

  it("emits phonemizer.js byte-for-byte as an unbundled asset during build", () => {
    const root = makeAssetRoot();
    const plugin = phonemizerAssetPlugin(root);
    const emitFile = vi.fn<(file: { type: string; name: string; source: Uint8Array }) => string>(() => "phonemizerRef");
    markAsBuild(plugin);

    const code = String(loadModule(plugin, "\0virtual:phonemizer-assets", { emitFile }));
    const [asset] = emitFile.mock.calls[0];

    expect(asset.type).toBe("asset");
    expect(asset.name).toBe("phonemizer.js");
    expect(Buffer.from(asset.source).toString("utf8")).toBe(FAKE_BUILD);
    expect(code).toBe("export const PHONEMIZER_MODULE_URL = import.meta.ROLLUP_FILE_URL_phonemizerRef;");
    expect(code).not.toContain("import ");
  });

  it("serves phonemizer.js by URL during dev so it skips dependency pre-bundling", () => {
    const root = makeAssetRoot();
    const code = String(loadModule(phonemizerAssetPlugin(root), "\0virtual:phonemizer-assets"));

    expect(code).toContain("phonemizer/dist/phonemizer.js?url");
    expect(code).toContain("export const PHONEMIZER_MODULE_URL = phonemizerUrl;");
  });

  it("throws a clear error when the phonemizer build is missing", () => {
    const plugin = phonemizerAssetPlugin(mkdtempSync(join(tmpdir(), "phonemizer-assets-missing-")));

    expect(() => loadModule(plugin, "\0virtual:phonemizer-assets")).toThrow("Missing phonemizer build");
  });

  it("targets the installed phonemizer 1.2.1 English-only eSpeak NG build", () => {
    const installed = JSON.parse(readFileSync(resolve("node_modules/phonemizer/package.json"), "utf8")) as { version: string };
    const build = readFileSync(resolve("node_modules/phonemizer/dist/phonemizer.js"), "utf8");

    expect(installed.version).toBe("1.2.1");
    // Boolean checks: a failing toContain would print the whole 1.3 MB bundle.
    expect(build.includes('ke=["en"]')).toBe(true);
    expect(/export\{\w+ as list_voices,\w+ as phonemize\};\s*$/.test(build)).toBe(true);
  });
});
