import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

interface BuildConfiguration {
  afterPack?: string;
  mac?: { files?: string[] };
  win?: { files?: string[] };
}

interface PackageMetadata {
  build?: BuildConfiguration;
}

const metadata = JSON.parse(
  fs.readFileSync(path.resolve("package.json"), "utf8"),
) as PackageMetadata;

describe("Electron package file scope", () => {
  it.each(["mac", "win"] as const)("anchors %s-specific exclusions to build output", (platform) => {
    const files = metadata.build?.[platform]?.files ?? [];
    expect(files).toContain("dist/**/*");
    expect(files).toContain("dist-electron/**/*");
    expect(files.some((pattern) => !pattern.startsWith("!"))).toBe(true);
  });

  it("runs the artifact-content verifier after every package build", () => {
    expect(metadata.build?.afterPack).toBe("scripts/verify-electron-package.cjs");
    expect(fs.existsSync(path.resolve("scripts/verify-electron-package.cjs"))).toBe(true);
  });
});
