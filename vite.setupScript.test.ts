import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  isSupportedNodeVersion,
  isSupportedNpmVersion,
  parseNpmUserAgent,
  parseSetupArgs,
} from "./scripts/setup.mjs";

interface PackageMetadata {
  engines: { node?: string; npm?: string };
  packageManager: string;
}

const metadata = JSON.parse(
  fs.readFileSync(path.resolve("package.json"), "utf8"),
) as PackageMetadata;
const pinnedNodeVersion = fs.readFileSync(path.resolve(".nvmrc"), "utf8").trim();

type Version = [major: number, minor: number, patch: number];

const NODE_CLAUSE = /^\^(\d+)\.(\d+)\.(\d+)$/;
const NPM_RANGE = /^>=(\d+)\.(\d+)\.(\d+)$/;

// Deliberately non-throwing: an unparseable range has to surface as the named
// assertion below, not as a module-scope throw that collects no tests at all.
function parseRange(range: string, pattern: RegExp): Version[] {
  const match = pattern.exec(range.trim());
  return match ? [[Number(match[1]), Number(match[2]), Number(match[3])]] : [];
}

// "^22.22.2 || ^24.15.0 || ^26.0.0" -> the lowest version each clause admits.
const nodeClauses = (metadata.engines.node ?? "").split("||");
const nodeFloors = nodeClauses.flatMap((clause) => parseRange(clause, NODE_CLAUSE));
const npmFloors = parseRange(metadata.engines.npm ?? "", NPM_RANGE);
const supportedNodeMajors = new Set(nodeFloors.map(([major]) => major));
const pinnedNpmVersion = metadata.packageManager.replace(/^npm@/, "");

// The highest version below a floor, which the declared range must reject.
function justBelow([major, minor, patch]: Version): string {
  if (patch > 0) return `${major}.${minor}.${patch - 1}`;
  if (minor > 0) return `${major}.${minor - 1}.999`;
  return `${major - 1}.999.999`;
}

describe("source setup script", () => {
  it("derives its boundaries from the declared engine ranges", () => {
    expect(nodeFloors, `every engines.node clause must be a caret range: ${metadata.engines.node}`)
      .toHaveLength(nodeClauses.length);
    expect(nodeFloors.length).toBeGreaterThan(0);
    expect(metadata.engines.npm ?? "", "package.json must declare engines.npm as a >=x.y.z range")
      .toMatch(NPM_RANGE);
    expect(npmFloors).toHaveLength(1);
  });

  it.each(["22.22.2", "22.99.0", "24.15.0", "24.19.0", "26.0.0"])(
    "accepts supported Node %s",
    (version) => expect(isSupportedNodeVersion(version)).toBe(true),
  );

  it.each(["22.22.1", "23.11.0", "24.14.9", "25.1.0", "27.0.0"])(
    "rejects unsupported Node %s",
    (version) => expect(isSupportedNodeVersion(version)).toBe(false),
  );

  it("accepts the Node version pinned in .nvmrc", () => {
    expect(pinnedNodeVersion).toMatch(/^\d+\.\d+\.\d+$/);
    expect(isSupportedNodeVersion(pinnedNodeVersion)).toBe(true);
  });

  it.each(nodeFloors)("matches engines.node ^%i.%i.%i at its boundaries", (major, minor, patch) => {
    expect(isSupportedNodeVersion(`${major}.${minor}.${patch}`)).toBe(true);
    expect(isSupportedNodeVersion(`${major}.${minor + 1}.0`)).toBe(true);
    expect(isSupportedNodeVersion(`${major}.999.999`)).toBe(true);
    expect(isSupportedNodeVersion(justBelow([major, minor, patch]))).toBe(false);
  });

  it("accepts exactly the major lines engines.node declares", () => {
    for (let major = 20; major <= 28; major += 1) {
      expect(isSupportedNodeVersion(`${major}.999.999`)).toBe(supportedNodeMajors.has(major));
    }
  });

  it.each(npmFloors)("matches engines.npm >=%i.%i.%i at its boundaries", (major, minor, patch) => {
    expect(isSupportedNpmVersion(`${major}.${minor}.${patch}`)).toBe(true);
    expect(isSupportedNpmVersion(`${major}.${minor + 1}.0`)).toBe(true);
    expect(isSupportedNpmVersion(`${major + 1}.0.0`)).toBe(true);
    expect(isSupportedNpmVersion(justBelow([major, minor, patch]))).toBe(false);
  });

  it("accepts the npm version pinned by packageManager", () => {
    expect(pinnedNpmVersion).toMatch(/^\d+\.\d+\.\d+$/);
    expect(isSupportedNpmVersion(pinnedNpmVersion)).toBe(true);
  });

  it.each(["", "11", "11.x", "eleven.17.0"])(
    "rejects unusable npm version %s",
    (version) => expect(isSupportedNpmVersion(version)).toBe(false),
  );

  it("reads the npm version from the npm user agent", () => {
    expect(parseNpmUserAgent("npm/11.17.0 node/v24.19.0 darwin arm64 workspaces/false"))
      .toBe("11.17.0");
    // Other package managers report a placeholder rather than an npm version.
    expect(parseNpmUserAgent("yarn/4.5.0 npm/? node/v24.19.0 darwin arm64")).toBe(null);
    expect(parseNpmUserAgent(undefined)).toBe(null);
  });

  it("requires an explicit setup target", () => {
    expect(parseSetupArgs(["--desktop", "--check"])).toEqual({ target: "desktop", checkOnly: true });
    expect(parseSetupArgs(["--web"])).toEqual({ target: "web", checkOnly: false });
    expect(() => parseSetupArgs([])).toThrow("Choose exactly one setup target");
    expect(() => parseSetupArgs(["--web", "--desktop"])).toThrow("Choose exactly one setup target");
  });
});
