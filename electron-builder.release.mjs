import fs from "node:fs";
import path from "node:path";

/* Resolved against this file rather than process.cwd(), which electron-builder does not guarantee
   to be the project root. `new URL("./package.json", import.meta.url)` would be the idiomatic
   spelling, but Vite rewrites that exact pattern into an asset reference when the test suite
   imports this module, so go through import.meta.dirname instead. */
const packageMetadata = JSON.parse(
  fs.readFileSync(path.join(import.meta.dirname, "package.json"), "utf8"),
);
const base = packageMetadata.build;

// `notarize: true` does not fail closed on its own. app-builder-lib resolves notarytool credentials
// from the environment (MacTargetHelper.getNotarizeOptions); when none are present it returns
// undefined, notarizeIfProvided() logs "skipped macOS notarization" as a warning, and the build
// still exits 0 with a signed-but-un-notarized artifact. Assert the credentials ourselves so a
// release build stops before producing one.
const notarizationCredentialRoutes = [
  ["APPLE_ID", "APPLE_APP_SPECIFIC_PASSWORD", "APPLE_TEAM_ID"],
  ["APPLE_API_KEY", "APPLE_API_KEY_ID", "APPLE_API_ISSUER"],
  ["APPLE_KEYCHAIN_PROFILE"],
];

export function assertNotarizationCredentials(env = process.env) {
  if (notarizationCredentialRoutes.some((route) => route.every((name) => env[name]))) {
    return;
  }
  throw new Error(
    [
      "Refusing to build a macOS release artifact: no Apple notarization credentials are set.",
      "electron-builder only warns and continues in this case, which would ship a signed but",
      "un-notarized build. Configure one of these credential sets:",
      ...notarizationCredentialRoutes.map((route) => `  - ${route.join(" + ")}`),
    ].join("\n"),
  );
}

// The config module is loaded once for both `dist:signed:mac` and `dist:signed:win`, so the check
// has to be deferred to a per-platform hook. `beforePack` is the earliest one that reports the
// target platform, and throwing from it aborts the build before any packing work happens.
export function assertReleaseCredentials(context) {
  if (context.electronPlatformName === "darwin" || context.electronPlatformName === "mas") {
    assertNotarizationCredentials();
  }
}

export default {
  ...base,
  beforePack: assertReleaseCredentials,
  mac: {
    ...base.mac,
    artifactName: "Open-TTS-${version}-macOS-${arch}.${ext}",
    forceCodeSigning: true,
    hardenedRuntime: true,
    identity: "Developer ID Application",
    notarize: true,
  },
  win: {
    ...base.win,
    artifactName: "Open-TTS-${version}-Windows-${arch}-CPU.${ext}",
    forceCodeSigning: true,
  },
};
