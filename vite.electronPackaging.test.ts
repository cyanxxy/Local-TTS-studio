import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

interface MacBuildConfiguration {
  artifactName?: string;
  files?: string[];
  hardenedRuntime?: boolean;
  identity?: string | null;
  notarize?: boolean;
}

interface WindowsBuildConfiguration {
  artifactName?: string;
  files?: string[];
}

interface BuildConfiguration {
  afterPack?: string;
  asarUnpack?: string[];
  mac?: MacBuildConfiguration;
  win?: WindowsBuildConfiguration;
}

interface PackageMetadata {
  build?: BuildConfiguration;
  engines?: Record<string, string>;
}

const metadata = JSON.parse(
  fs.readFileSync(path.resolve("package.json"), "utf8"),
) as PackageMetadata;

const loadReleaseConfig = () => import("./electron-builder.release.mjs");

/* Every environment variable app-builder-lib's MacTargetHelper.getNotarizeOptions() reads. The
   guard under test only sees credentials through process.env, so each case has to start from a
   known-empty slate rather than whatever the developer's shell happens to export. */
const appleCredentialVariables = [
  "APPLE_ID",
  "APPLE_APP_SPECIFIC_PASSWORD",
  "APPLE_TEAM_ID",
  "APPLE_API_KEY",
  "APPLE_API_KEY_ID",
  "APPLE_API_ISSUER",
  "APPLE_KEYCHAIN_PROFILE",
];

const stubAppleCredentials = (credentials: Record<string, string> = {}) => {
  for (const name of appleCredentialVariables) {
    vi.stubEnv(name, credentials[name]);
  }
};

describe("Electron package file scope", () => {
  it.each(["mac", "win"] as const)("anchors %s-specific exclusions to build output", (platform) => {
    const files = metadata.build?.[platform]?.files ?? [];
    expect(files).toContain("dist/**/*");
    expect(files).toContain("dist-electron/**/*");
    expect(files.some((pattern) => !pattern.startsWith("!"))).toBe(true);
  });

  it("runs the artifact-content verifier after every package build", () => {
    expect(metadata.build?.afterPack).toBe("scripts/verify-electron-package.mjs");
    expect(fs.existsSync(path.resolve("scripts/verify-electron-package.mjs"))).toBe(true);
  });

  /* @huggingface/transformers declares sharp as a hard dependency and imports it at module scope,
     so any Audio8 generation loads sharp's prebuilt binary. Electron copies .node files out of
     app.asar into a temp directory before dlopen, which breaks sharp's @loader_path-relative rpath
     to libvips unless both packages sit outside the archive. */
  it("keeps sharp and its prebuilt binaries outside the asar", () => {
    const asarUnpack = metadata.build?.asarUnpack ?? [];
    expect(asarUnpack).toContain("**/node_modules/sharp/**");
    expect(asarUnpack).toContain("**/node_modules/@img/**");
  });

  /* tsconfig.electron.json compiles with module: Node16, which picks the emit format from the
     nearest package.json. Without this file the main process would be emitted as ESM while
     typecheck still passed, and the packaged app would fail at startup. */
  it("pins the compiled main process output to CommonJS", () => {
    const electronPackage = JSON.parse(
      fs.readFileSync(path.resolve("electron/package.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(electronPackage).toEqual({ type: "commonjs" });
  });

  it("requires an npm new enough to enforce the install-script policy", () => {
    expect(metadata.engines?.npm).toBe(">=11.17.0");
    expect(fs.readFileSync(path.resolve(".npmrc"), "utf8")).toMatch(/^engine-strict=true$/m);
  });

  it("keeps credentialed release packaging separate from local unsigned builds", async () => {
    const release = (await loadReleaseConfig()).default;
    expect(release.mac).toMatchObject({
      forceCodeSigning: true,
      hardenedRuntime: true,
      identity: "Developer ID Application",
      notarize: true,
    });
    expect(release.win).toMatchObject({ forceCodeSigning: true });

    expect(metadata.build?.mac).toMatchObject({
      hardenedRuntime: false,
      notarize: false,
    });
    expect(metadata.build?.mac?.identity).toBeNull();
  });

  it("gives signed and unsigned artifacts distinguishable filenames", async () => {
    const release = (await loadReleaseConfig()).default;
    expect(metadata.build?.mac?.artifactName).toMatch(/-unsigned\./);
    expect(metadata.build?.win?.artifactName).toMatch(/-unsigned\./);
    expect(release.mac.artifactName).not.toBe(metadata.build?.mac?.artifactName);
    expect(release.win.artifactName).not.toBe(metadata.build?.win?.artifactName);
    expect(release.mac.artifactName).not.toMatch(/-unsigned\./);
    expect(release.win.artifactName).not.toMatch(/-unsigned\./);
  });
});

/* `notarize: true` is advisory: app-builder-lib downgrades a missing-credentials notarization to a
   warning and exits 0, so the release config has to reject the build itself. */
describe("macOS release notarization guard", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("stays importable without credentials so the config can be inspected", async () => {
    stubAppleCredentials();
    const release = (await loadReleaseConfig()).default;
    expect(typeof release.beforePack).toBe("function");
  });

  it("refuses to pack macOS without notarization credentials", async () => {
    stubAppleCredentials();
    const { assertReleaseCredentials } = await loadReleaseConfig();
    expect(() => assertReleaseCredentials({ electronPlatformName: "darwin" })).toThrow(
      /notarization credentials/i,
    );
    expect(() => assertReleaseCredentials({ electronPlatformName: "mas" })).toThrow(
      /notarization credentials/i,
    );
  });

  it("leaves the Windows release path alone", async () => {
    stubAppleCredentials();
    const { assertReleaseCredentials } = await loadReleaseConfig();
    expect(() => assertReleaseCredentials({ electronPlatformName: "win32" })).not.toThrow();
  });

  it.each([
    [
      "app-specific password",
      {
        APPLE_ID: "release@example.com",
        APPLE_APP_SPECIFIC_PASSWORD: "abcd-efgh-ijkl-mnop",
        APPLE_TEAM_ID: "TEAMID1234",
      },
    ],
    [
      "App Store Connect API key",
      {
        APPLE_API_KEY: "/tmp/AuthKey.p8",
        APPLE_API_KEY_ID: "KEYID12345",
        APPLE_API_ISSUER: "00000000-0000-0000-0000-000000000000",
      },
    ],
    ["keychain profile", { APPLE_KEYCHAIN_PROFILE: "open-tts-notarytool" }],
  ])("accepts the %s credential route", async (_route, credentials) => {
    stubAppleCredentials(credentials);
    const { assertReleaseCredentials } = await loadReleaseConfig();
    expect(() => assertReleaseCredentials({ electronPlatformName: "darwin" })).not.toThrow();
  });

  it("rejects a partially configured credential route", async () => {
    stubAppleCredentials({ APPLE_ID: "release@example.com", APPLE_TEAM_ID: "TEAMID1234" });
    const { assertReleaseCredentials } = await loadReleaseConfig();
    expect(() => assertReleaseCredentials({ electronPlatformName: "darwin" })).toThrow(
      /notarization credentials/i,
    );
  });
});
