import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { normalizePath, type Plugin } from "vite";

const VIRTUAL_MODULE_ID = "virtual:phonemizer-assets";
const RESOLVED_VIRTUAL_MODULE_ID = `\0${VIRTUAL_MODULE_ID}`;
const PHONEMIZER_BUILD = "node_modules/phonemizer/dist/phonemizer.js";

function resolvePhonemizerBuild(rootDir: string): string {
  const buildPath = resolve(rootDir, PHONEMIZER_BUILD);
  if (!existsSync(buildPath)) {
    throw new Error(`Missing phonemizer build: ${PHONEMIZER_BUILD}. Check the phonemizer dependency before building.`);
  }
  return normalizePath(buildPath);
}

/**
 * Exposes phonemizer's single-file eSpeak NG build (English only) by URL, the
 * way vite.kokoroAssets.ts exposes kokoro.web.js. It is never imported as a
 * bare module: Rolldown's rewrite of the embedded Emscripten runtime leaves
 * eSpeak NG without voices (`Invalid language identifier: "en-us"`), and
 * dependency pre-bundling would do the same in dev.
 */
export function phonemizerAssetPlugin(rootDir: string = process.cwd()): Plugin {
  let isBuild = false;

  return {
    name: "open-tts:phonemizer-assets",
    enforce: "pre",
    configResolved(config) {
      isBuild = config.command === "build";
    },
    resolveId(id) {
      return id === VIRTUAL_MODULE_ID ? RESOLVED_VIRTUAL_MODULE_ID : null;
    },
    load(id) {
      if (id !== RESOLVED_VIRTUAL_MODULE_ID) return null;

      const buildPath = resolvePhonemizerBuild(rootDir);
      if (isBuild) {
        const referenceId = this.emitFile({
          type: "asset",
          name: "phonemizer.js",
          source: readFileSync(buildPath),
        });
        return `export const PHONEMIZER_MODULE_URL = import.meta.ROLLUP_FILE_URL_${referenceId};`;
      }

      return [
        `import phonemizerUrl from ${JSON.stringify(`${buildPath}?url`)};`,
        "export const PHONEMIZER_MODULE_URL = phonemizerUrl;",
      ].join("\n");
    },
  };
}
