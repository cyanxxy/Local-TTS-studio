// @vitest-environment node

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { MANIFEST_SPECS, renderManifestModule } from "./scripts/pin-model-manifests.mjs";
import * as kitten from "./src/lib/manifests/kitten";
import * as paradee from "./src/lib/manifests/paradee";
import { pinnedModelFileUrl, type PinnedModelFile } from "./src/lib/manifests/types";

const MODULES: Record<string, Record<string, PinnedModelFile>> = {
  "src/lib/manifests/kitten.ts": kitten,
  "src/lib/manifests/paradee.ts": paradee,
};

describe("pinned browser model manifests", () => {
  it("are exactly what the pin script generates for its revisions", () => {
    expect(Object.keys(MODULES).sort()).toEqual(MANIFEST_SPECS.map((spec) => spec.output).sort());
    for (const spec of MANIFEST_SPECS) {
      const module = MODULES[spec.output];
      expect(Object.keys(module).sort()).toEqual(spec.files.map((file) => file.exportName).sort());
      for (const file of spec.files) {
        expect(module[file.exportName]).toMatchObject({ repo: file.repo, revision: file.revision, path: file.path });
      }
      const resolved = new Map(Object.entries(module));
      expect(readFileSync(resolve(spec.output), "utf8")).toBe(renderManifestModule(spec, resolved));
    }
  });

  it("pin every file to a full commit, an exact size, a SHA-256 and a permissive license", () => {
    for (const module of Object.values(MODULES)) {
      for (const file of Object.values(module)) {
        expect(file.revision).toMatch(/^[0-9a-f]{40}$/);
        expect(file.sha256).toMatch(/^[0-9a-f]{64}$/);
        expect(Number.isSafeInteger(file.byteLength) && file.byteLength > 0).toBe(true);
        expect(["apache-2.0", "mit"]).toContain(file.license);
        expect(pinnedModelFileUrl(file)).toBe(`https://huggingface.co/${file.repo}/resolve/${file.revision}/${file.path}`);
      }
    }
  });

  it("refuses to render a module with missing metadata", () => {
    expect(() => renderManifestModule(MANIFEST_SPECS[0], new Map())).toThrow("Missing metadata");
  });
});
