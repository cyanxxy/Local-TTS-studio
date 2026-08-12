import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function isSupportedNodeVersion(version) {
  const [major, minor = 0, patch = 0] = version.split(".").map(Number);
  if (major === 22) return minor > 22 || (minor === 22 && patch >= 2);
  if (major === 24) return minor >= 15;
  return major === 26;
}

// .npmrc sets strict-allow-scripts, which pairs with the allowScripts map in
// package.json. npm ignores both before 11.17.0 and runs every install script.
export function isSupportedNpmVersion(version) {
  const [major, minor = 0] = version.split(".").map(Number);
  if (!Number.isInteger(major) || !Number.isInteger(minor)) return false;
  if (major !== 11) return major > 11;
  return minor >= 17;
}

// npm exports e.g. "npm/11.17.0 node/v24.19.0 darwin arm64 workspaces/false".
// Other package managers report a placeholder ("npm/?"); ignore those so the
// caller falls back to asking npm itself.
export function parseNpmUserAgent(userAgent) {
  const match = /(?:^|\s)npm\/(\d+\.\d+\.\d+\S*)/.exec(userAgent ?? "");
  return match ? match[1] : null;
}

export function parseSetupArgs(args) {
  const desktop = args.includes("--desktop");
  const web = args.includes("--web");
  if (desktop === web) {
    throw new Error("Choose exactly one setup target: --web or --desktop.");
  }
  const unknown = args.filter((arg) => !["--desktop", "--web", "--check"].includes(arg));
  if (unknown.length > 0) throw new Error(`Unknown setup option: ${unknown.join(", ")}`);
  return { target: desktop ? "desktop" : "web", checkOnly: args.includes("--check") };
}

function toolWorks(command, args = ["--version"]) {
  const result = spawnSync(command, args, { cwd: rootDir, encoding: "utf8" });
  return !result.error && result.status === 0;
}

// `subject` names what the probe proves is present, which is not always the
// probed command: `pkg-config --exists openssl` reports on OpenSSL, not pkg-config.
function requireTool(command, installHint, { args, subject = command } = {}) {
  if (!toolWorks(command, args)) {
    throw new Error(`${subject} is required for desktop builds. ${installHint}`);
  }
}

function checkDesktopRequirements() {
  requireTool("cargo", "Install Rust from https://rustup.rs/.");
  requireTool("rustc", "Install Rust from https://rustup.rs/.");
  requireTool("cmake", "Install CMake and make sure it is on PATH.");

  if (process.platform === "darwin") {
    if (process.arch !== "arm64") {
      throw new Error(`Desktop builds require Apple Silicon; this machine reports ${process.arch}.`);
    }
    requireTool(
      "pkg-config",
      "Run: brew install cmake libomp openssl@3 pkg-config automake autoconf libtool",
    );
    requireTool(
      "pkg-config",
      "Run: brew install openssl@3 pkg-config",
      { args: ["--exists", "openssl"], subject: "OpenSSL 3" },
    );
    for (const tool of ["automake", "autoconf"]) {
      requireTool(tool, "Run: brew install automake autoconf libtool");
    }
    requireTool("glibtool", "Run: brew install libtool", { subject: "GNU libtool" });
    return;
  }

  if (process.platform === "win32") {
    if (process.arch !== "x64") {
      throw new Error(`Windows desktop builds require x64; this machine reports ${process.arch}.`);
    }
    const libtorch = process.env.LIBTORCH;
    if (!libtorch || !fs.existsSync(path.join(libtorch, "lib"))) {
      throw new Error(
        "Set LIBTORCH to a compatible LibTorch 2.7.0 release directory. See docs/local-runtimes.md.",
      );
    }
    return;
  }

  throw new Error(`Desktop builds are not supported on ${process.platform}; use npm run setup:web.`);
}

// Node refuses to spawn npm.cmd without a shell (the 18.20.2/20.12.2 security fix),
// and shell: true is deprecated (DEP0190), so route Windows through cmd.exe.
function npmInvocation(args) {
  return process.platform === "win32"
    ? { command: "cmd.exe", args: ["/c", "npm", ...args] }
    : { command: "npm", args };
}

function detectNpmVersion() {
  const reported = parseNpmUserAgent(process.env.npm_config_user_agent);
  if (reported) return reported;

  // Populated only under `npm run`; fall back to asking npm when invoked as
  // `node scripts/setup.mjs --web`.
  const { command, args } = npmInvocation(["--version"]);
  const result = spawnSync(command, args, { cwd: rootDir, encoding: "utf8" });
  if (result.error || result.status !== 0) return null;
  return result.stdout.trim() || null;
}

function checkNpmVersion() {
  const version = detectNpmVersion();
  if (version === null) {
    console.warn("Could not determine the npm version; Open TTS needs npm 11.17.0 or newer.");
    return;
  }
  if (!isSupportedNpmVersion(version)) {
    throw new Error(
      `npm ${version} is unsupported. It ignores the strict-allow-scripts policy in .npmrc `
      + "and would run unvetted install scripts. Run: npm install -g npm@11.17.0",
    );
  }
}

function pinnedNodeVersion() {
  return fs.readFileSync(path.join(rootDir, ".nvmrc"), "utf8").trim();
}

function installDependencies() {
  const { command, args } = npmInvocation(["ci"]);
  const result = spawnSync(command, args, { cwd: rootDir, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`npm ci exited with status ${result.status}.`);
}

export function runSetup(args = process.argv.slice(2)) {
  const { target, checkOnly } = parseSetupArgs(args);
  if (!isSupportedNodeVersion(process.versions.node)) {
    throw new Error(
      `Node ${process.versions.node} is unsupported. Install the version in .nvmrc (${pinnedNodeVersion()}).`,
    );
  }
  checkNpmVersion();
  if (target === "desktop") checkDesktopRequirements();
  if (!checkOnly) installDependencies();

  const nextCommand = target === "desktop" ? "npm run dev:desktop" : "npm run dev:web";
  console.log(`${target === "desktop" ? "Desktop" : "Web"} prerequisites are ready.`);
  if (!checkOnly) console.log(`Start Open TTS with: ${nextCommand}`);
}

const directRun = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (directRun) {
  try {
    runSetup();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
