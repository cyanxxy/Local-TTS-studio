// Generates a pinned asset manifest for a Hugging Face model revision: the
// exact byte size and digest of every file a runtime uses, read from the Hub
// API at an immutable commit. Workers verify downloads against these entries
// with verifyPinnedAssetIntegrity (src/lib/pinnedModelFetch.ts), so adding a
// model or bumping a revision never means copying hashes by hand.
//
//   node scripts/pin-hf-assets.mjs --repo Supertone/supertonic-3 \
//     --revision 3cadd1ee6394adea1bd021217a0e650ede09a323 \
//     --include "onnx/*" --include "voice_styles/*" \
//     --name SUPERTONIC3_ASSETS --out src/workers/manifests/supertonic3.ts
//
// Git LFS files are pinned by the SHA-256 of their content (lfs.sha256).
// Regular git files are pinned by their git blob SHA-1 (blobId) unless
// --sha256 is given, which downloads them, checks the blob SHA-1, and records
// a SHA-256 instead. LFS content is never downloaded. Each --license adds a
// license id to an allow-list: the repository card's license at the pinned
// commit must be on it, and is recorded in the manifest. With --check the
// manifest at --out is compared with a fresh query and the script exits with
// status 1 when they differ. This script talks to the network, so it is a
// maintainer tool and stays out of CI.
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const rootDir = path.resolve(path.dirname(scriptPath), "..");
const HUB_ORIGIN = "https://huggingface.co";
const REPO_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/;
const REVISION_PATTERN = /^[0-9a-f]{40}$/;
const EXPORT_NAME_PATTERN = /^[A-Z][A-Z0-9_]*$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const SHA1_PATTERN = /^[0-9a-f]{40}$/;
const PINNED_MODEL_FETCH_MODULE = path.join(rootDir, "src", "lib", "pinnedModelFetch");
const DEFAULT_MANIFEST_DIR = path.join(rootDir, "src", "workers", "manifests");

/**
 * @typedef {{ byteLength: number, sha256?: string, gitBlobSha1?: string }} PinnedFile
 * @typedef {{ repo: string, revision: string, license?: string, files: Record<string, PinnedFile> }} PinnedManifest
 * @typedef {{
 *   repo: string,
 *   revision: string,
 *   include: string[],
 *   exclude: string[],
 *   licenses: string[],
 *   name: string,
 *   out: string | null,
 *   check: boolean,
 *   sha256: boolean,
 * }} PinOptions
 */

/**
 * @param {readonly string[]} argv
 * @returns {PinOptions}
 */
export function parseArgs(argv) {
  const options = {
    repo: "",
    revision: "",
    include: [],
    exclude: [],
    licenses: [],
    name: "PINNED_ASSETS",
    out: null,
    check: false,
    sha256: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--check") {
      options.check = true;
      continue;
    }
    if (arg === "--sha256") {
      options.sha256 = true;
      continue;
    }
    const readValue = (name) => {
      if (arg.startsWith(`${name}=`)) {
        const value = arg.slice(name.length + 1);
        if (!value) throw new Error(`${name} requires a value.`);
        return value;
      }
      if (arg !== name) return null;
      index += 1;
      const value = argv[index];
      if (value == null || value === "") throw new Error(`${name} requires a value.`);
      return value;
    };

    let value;
    if ((value = readValue("--repo")) !== null) options.repo = value;
    else if ((value = readValue("--revision")) !== null) options.revision = value;
    else if ((value = readValue("--include")) !== null) options.include.push(value);
    else if ((value = readValue("--exclude")) !== null) options.exclude.push(value);
    else if ((value = readValue("--license")) !== null) options.licenses.push(value);
    else if ((value = readValue("--name")) !== null) options.name = value;
    else if ((value = readValue("--out")) !== null) options.out = value;
    else throw new Error(`Unknown option: ${arg}`);
  }

  if (!options.repo || !REPO_PATTERN.test(options.repo)) {
    throw new Error("--repo must be a Hugging Face model id such as Supertone/supertonic-3.");
  }
  if (!options.revision || !REVISION_PATTERN.test(options.revision)) {
    throw new Error("--revision must be a full 40-character commit SHA; branch and tag names can move.");
  }
  if (!EXPORT_NAME_PATTERN.test(options.name)) {
    throw new Error("--name must be an UPPER_SNAKE_CASE identifier.");
  }
  if (options.check && !options.out) {
    throw new Error("--check needs --out to name the manifest to verify.");
  }
  return options;
}

function escapeRegExp(value) {
  return value.replace(/[.+^${}()|[\]\\]/g, "\\$&");
}

/**
 * `*` and `?` stay within one path segment; `**` crosses segments.
 * @param {string} glob
 */
export function globToRegExp(glob) {
  let source = "";
  for (let index = 0; index < glob.length; index += 1) {
    const character = glob[index];
    if (character === "*" && glob[index + 1] === "*") {
      source += ".*";
      index += 1;
    } else if (character === "*") {
      source += "[^/]*";
    } else if (character === "?") {
      source += "[^/]";
    } else {
      source += escapeRegExp(character);
    }
  }
  return new RegExp(`^${source}$`);
}

/**
 * @param {readonly string[]} paths
 * @param {{ include?: readonly string[], exclude?: readonly string[] }} [patterns]
 * @returns {string[]}
 */
export function selectFiles(paths, { include = [], exclude = [] } = {}) {
  const includes = include.map(globToRegExp);
  const excludes = exclude.map(globToRegExp);
  return paths
    .filter((file) => includes.length === 0 || includes.some((pattern) => pattern.test(file)))
    .filter((file) => !excludes.some((pattern) => pattern.test(file)))
    .sort();
}

export function revisionInfoUrl(repo, revision) {
  return `${HUB_ORIGIN}/api/models/${repo}/revision/${revision}?blobs=true`;
}

export function resolveFileUrl(repo, revision, file) {
  return `${HUB_ORIGIN}/${repo}/resolve/${revision}/${file.split("/").map(encodeURIComponent).join("/")}`;
}

export function gitBlobSha1(bytes) {
  return createHash("sha1").update(`blob ${bytes.byteLength}\0`).update(bytes).digest("hex");
}

/**
 * Builds a manifest from a /api/models/<repo>/revision/<sha>?blobs=true
 * response. `fetchBytes(file)` is used only with --sha256, for regular files.
 *
 * @param {any} info
 * @param {PinOptions} options
 * @param {((file: string) => Promise<Uint8Array>) | null} [fetchBytes]
 * @returns {Promise<PinnedManifest>}
 */
export async function buildManifest(info, options, fetchBytes = null) {
  if (!info || typeof info !== "object" || !Array.isArray(info.siblings)) {
    throw new Error("The Hub API response has no file list (siblings).");
  }
  if (info.sha !== options.revision) {
    throw new Error(`The Hub resolved ${options.revision} to ${String(info.sha)}; pin the exact commit.`);
  }
  const licenses = options.licenses ?? [];
  const license = info.cardData?.license;
  if (licenses.length > 0 && !licenses.includes(license)) {
    throw new Error(`${options.repo} is licensed ${JSON.stringify(license ?? null)}, which is not one of --license ${licenses.join(", ")}.`);
  }

  const siblings = new Map(info.siblings.map((entry) => [entry.rfilename, entry]));
  const selected = selectFiles([...siblings.keys()], options);
  if (selected.length === 0) {
    throw new Error("No files in the revision match the --include/--exclude patterns.");
  }

  /** @type {Record<string, PinnedFile>} */
  const files = {};
  for (const file of selected) {
    const entry = siblings.get(file);
    if (!Number.isSafeInteger(entry.size) || entry.size < 0) {
      throw new Error(`The Hub API reported no valid size for ${file}.`);
    }
    if (entry.lfs) {
      if (!SHA256_PATTERN.test(entry.lfs.sha256 ?? "") || entry.lfs.size !== entry.size) {
        throw new Error(`The Hub API reported inconsistent LFS metadata for ${file}.`);
      }
      files[file] = { byteLength: entry.size, sha256: entry.lfs.sha256 };
      continue;
    }
    if (!SHA1_PATTERN.test(entry.blobId ?? "")) {
      throw new Error(`The Hub API reported no git blob id for ${file}.`);
    }
    if (!options.sha256) {
      files[file] = { byteLength: entry.size, gitBlobSha1: entry.blobId };
      continue;
    }
    if (!fetchBytes) throw new Error("--sha256 needs a downloader for regular files.");
    const bytes = await fetchBytes(file);
    if (bytes.byteLength !== entry.size || gitBlobSha1(bytes) !== entry.blobId) {
      throw new Error(`${file} downloaded with a different size or git blob id than the Hub API reported.`);
    }
    files[file] = { byteLength: entry.size, sha256: createHash("sha256").update(bytes).digest("hex") };
  }

  return {
    repo: options.repo,
    revision: options.revision,
    ...(licenses.length > 0 ? { license } : {}),
    files,
  };
}

export function regenerateCommand(options) {
  const quote = (value) => (/^[\w./=:@-]+$/.test(value) ? value : `"${value}"`);
  return [
    "node scripts/pin-hf-assets.mjs",
    `--repo ${quote(options.repo)}`,
    `--revision ${options.revision}`,
    ...options.include.map((glob) => `--include ${quote(glob)}`),
    ...options.exclude.map((glob) => `--exclude ${quote(glob)}`),
    ...(options.licenses ?? []).map((license) => `--license ${quote(license)}`),
    ...(options.sha256 ? ["--sha256"] : []),
    `--name ${options.name}`,
    ...(options.out ? [`--out ${quote(options.out)}`] : []),
  ].join(" ");
}

/** The manifest type's import specifier, relative to where the module is written. */
export function manifestTypeImportPath(out) {
  const directory = out ? path.dirname(path.resolve(rootDir, out)) : DEFAULT_MANIFEST_DIR;
  const relative = path.relative(directory, PINNED_MODEL_FETCH_MODULE).split(path.sep).join("/");
  return relative.startsWith(".") ? relative : `./${relative}`;
}

/**
 * Renders the manifest as a TypeScript module (or JSON for a .json path).
 * @param {PinnedManifest} manifest
 * @param {PinOptions} options
 * @returns {string}
 */
export function renderManifest(manifest, options) {
  const json = JSON.stringify(manifest, null, 2);
  if (options.out?.endsWith(".json")) return `${json}\n`;
  return [
    "// Generated by scripts/pin-hf-assets.mjs from the Hugging Face Hub API. Do not",
    "// edit by hand; regenerate with:",
    `//   ${regenerateCommand(options)}`,
    `import type { PinnedAssetManifest } from "${manifestTypeImportPath(options.out)}";`,
    "",
    `export const ${options.name} = ${json} as const satisfies PinnedAssetManifest;`,
    "",
  ].join("\n");
}

/**
 * Reads the manifest object back out of a rendered module or JSON file.
 * @param {string} text
 * @returns {PinnedManifest}
 */
export function parseRenderedManifest(text) {
  const trimmed = text.trim();
  if (trimmed.startsWith("{")) return JSON.parse(trimmed);
  const match = /export const [A-Z][A-Z0-9_]* = (\{[\s\S]*\}) as const satisfies PinnedAssetManifest;/.exec(text);
  if (!match) throw new Error("The file is not a manifest generated by this script.");
  return JSON.parse(match[1]);
}

/**
 * @param {PinnedManifest} previous
 * @param {PinnedManifest} next
 * @returns {string[]}
 */
export function diffManifests(previous, next) {
  const differences = [];
  for (const field of ["repo", "revision", "license"]) {
    if (previous[field] !== next[field]) {
      differences.push(`${field}: ${String(previous[field])} -> ${String(next[field])}`);
    }
  }
  const previousFiles = previous.files ?? {};
  const nextFiles = next.files ?? {};
  for (const file of [...new Set([...Object.keys(previousFiles), ...Object.keys(nextFiles)])].sort()) {
    const before = previousFiles[file];
    const after = nextFiles[file];
    if (!before) differences.push(`added ${file}`);
    else if (!after) differences.push(`removed ${file}`);
    else if (JSON.stringify(before) !== JSON.stringify(after)) differences.push(`changed ${file}`);
  }
  return differences;
}

async function fetchJson(url) {
  const response = await fetch(url, { headers: { accept: "application/json" } });
  if (!response.ok) throw new Error(`GET ${url} failed with HTTP ${response.status}.`);
  return response.json();
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const info = await fetchJson(revisionInfoUrl(options.repo, options.revision));
  const manifest = await buildManifest(info, options, async (file) => {
    const url = resolveFileUrl(options.repo, options.revision, file);
    const response = await fetch(url);
    if (!response.ok) throw new Error(`GET ${url} failed with HTTP ${response.status}.`);
    return new Uint8Array(await response.arrayBuffer());
  });
  const rendered = renderManifest(manifest, options);

  if (!options.out) {
    process.stdout.write(rendered);
    return;
  }

  const outPath = path.resolve(rootDir, options.out);
  if (options.check) {
    const differences = diffManifests(parseRenderedManifest(await readFile(outPath, "utf8")), manifest);
    if (differences.length > 0) {
      console.error(`${options.out} does not match ${options.repo}@${options.revision}:`);
      for (const difference of differences) console.error(`  ${difference}`);
      process.exitCode = 1;
      return;
    }
    console.log(`${options.out} matches ${options.repo}@${options.revision} (${Object.keys(manifest.files).length} files).`);
    return;
  }

  await writeFile(outPath, rendered);
  console.log(`Wrote ${Object.keys(manifest.files).length} pinned files to ${options.out}.`);
}

const isDirectRun = process.argv[1] !== undefined && path.resolve(process.argv[1]) === scriptPath;
if (isDirectRun) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
