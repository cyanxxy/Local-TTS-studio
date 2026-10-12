// Generates the curated Piper voice catalog: every rhasspy/piper-voices voice
// of the chosen locales whose dataset license is permissive, with the exact
// size and SHA-256 of its graph and config, read from the Hub API at an
// immutable commit. Voices whose license is unknown ("See URL"), share-alike
// or non-commercial are left out, and each exclusion is reported.
//
//   node scripts/pin-piper-voices.mjs \
//     --revision c10ece1aade47bb51c153c893d14e5bf8e5b7117 \
//     --locale en_US --locale en_GB \
//     --out src/workers/manifests/piperVoices.ts
//
// Only English locales are listed: the app ships an English-only eSpeak NG
// build, so other locales could not be phonemized. Adding one means shipping a
// multilingual phonemizer first, then regenerating with another --locale.
// Configs without a phoneme_type predate the field and use eSpeak.
//
// A voice's license comes from the "License:" line of its MODEL_CARD, which
// describes the training dataset (the repository itself is MIT). With --check
// the catalog at --out is compared with a fresh query and the script exits
// with status 1 when they differ. This script talks to the network, so it is
// a maintainer tool and stays out of CI.
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildManifest, diffManifests, resolveFileUrl, revisionInfoUrl } from "./pin-hf-assets.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const rootDir = path.resolve(path.dirname(scriptPath), "..");
export const PIPER_REPO = "rhasspy/piper-voices";
const REVISION_PATTERN = /^[0-9a-f]{40}$/;
const LOCALE_PATTERN = /^[a-z]{2,3}_[A-Z]{2}$/;
const QUALITY_ORDER = ["x_low", "low", "medium", "high"];
const VOICE_PATH = /^(?<family>[a-z]{2,3})\/(?<locale>[a-z]{2,3}_[A-Z]{2})\/(?<speaker>[^/]+)\/(?<quality>x_low|low|medium|high)\/(?<id>[^/]+)\.onnx$/;

/** Speaker directory names that are better read as proper names or acronyms. */
const DISPLAY_NAMES = {
  libritts: "LibriTTS",
  libritts_r: "LibriTTS-R",
  ljspeech: "LJSpeech",
  vctk: "VCTK",
  reza_ibrahim: "Reza Ibrahim",
};

const LICENSES = {
  "public-domain": { name: "public domain", url: null },
  "CC0-1.0": { name: "CC0 1.0", url: "https://creativecommons.org/publicdomain/zero/1.0/" },
  "CC-BY-4.0": { name: "CC BY 4.0", url: "https://creativecommons.org/licenses/by/4.0/" },
  "Apache-2.0": { name: "Apache License 2.0", url: "https://www.apache.org/licenses/LICENSE-2.0" },
  MIT: { name: "MIT", url: "https://opensource.org/license/mit" },
};

/**
 * @typedef {{ revision: string, locales: string[], out: string | null, check: boolean }} PiperPinOptions
 */

/**
 * @param {readonly string[]} argv
 * @returns {PiperPinOptions}
 */
export function parseArgs(argv) {
  const options = { revision: "", locales: [], out: null, check: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const readValue = (flag) => {
      if (arg === flag) {
        const next = argv[index + 1];
        if (next === undefined || next.startsWith("--")) throw new Error(`${flag} needs a value.`);
        index += 1;
        return next;
      }
      return arg.startsWith(`${flag}=`) ? arg.slice(flag.length + 1) : null;
    };
    let value;
    if (arg === "--check") options.check = true;
    else if ((value = readValue("--revision")) !== null) options.revision = value;
    else if ((value = readValue("--locale")) !== null) options.locales.push(value);
    else if ((value = readValue("--out")) !== null) options.out = value;
    else throw new Error(`Unknown option: ${arg}`);
  }
  if (!REVISION_PATTERN.test(options.revision)) {
    throw new Error("--revision must be a full 40-character commit SHA; branch and tag names can move.");
  }
  if (options.locales.length === 0 || !options.locales.every((locale) => LOCALE_PATTERN.test(locale))) {
    throw new Error("Give at least one --locale such as en_US.");
  }
  if (options.check && !options.out) throw new Error("--check needs --out to name the catalog to verify.");
  return options;
}

/**
 * Reads the Dataset section of a MODEL_CARD.
 * @param {string} text
 * @returns {{ datasetUrl: string | null, licenseText: string | null }}
 */
export function parseModelCard(text) {
  const field = (name) => new RegExp(`^\\s*\\*\\s*${name}:\\s*(.+?)\\s*$`, "im").exec(text)?.[1] ?? null;
  return { datasetUrl: field("URL"), licenseText: field("License") };
}

/**
 * Maps a MODEL_CARD license line to one of the permissive licenses, or null
 * for anything else: "See URL" and "See LICENSE file" cannot be checked here,
 * and share-alike (CC BY-SA) and non-commercial (CC BY-NC) terms are not
 * wanted in a catalog that ships with the app.
 * @param {string | null} licenseText
 * @returns {{ id: string, name: string, url: string | null } | null}
 */
export function classifyLicense(licenseText) {
  const text = (licenseText ?? "").trim().toLowerCase().replace(/\/+$/, "");
  const id = (() => {
    if (/^public[ -]domain$/.test(text)) return "public-domain";
    if (/^cc0(?:[ -]1\.0)?$|^https?:\/\/creativecommons\.org\/publicdomain\/zero\/1\.0(?:\/.*)?$/.test(text)) return "CC0-1.0";
    if (/^cc[ -]by(?:[ -]4\.0)?(?: international)?$|^https?:\/\/creativecommons\.org\/licenses\/by\/4\.0(?:\/.*)?$/.test(text)) return "CC-BY-4.0";
    if (/^apache(?:[ -]license)?(?:,? version)?[ -]?2(?:\.0)?$|^https?:\/\/www\.apache\.org\/licenses\/license-2\.0(?:\.txt)?$/.test(text)) return "Apache-2.0";
    if (/^mit(?: license)?$/.test(text)) return "MIT";
    return null;
  })();
  return id ? { id, ...LICENSES[id] } : null;
}

export function displayName(speaker) {
  return DISPLAY_NAMES[speaker] ?? speaker.split("_").map((part) => part[0].toUpperCase() + part.slice(1)).join(" ");
}

export function attributionFor(name, license, datasetUrl) {
  const data = datasetUrl ? `trained on the dataset at ${datasetUrl}` : "trained on a public domain dataset";
  const terms = license.id === "public-domain" ? "in the public domain" : `licensed ${license.name}`;
  return `${name}: Piper voice (rhasspy/piper-voices, MIT) ${data}, ${terms}.`;
}

/**
 * The voice graphs of `locales` in a revision's file list.
 * @param {readonly string[]} paths
 * @param {readonly string[]} locales
 * @returns {Array<{ file: string, family: string, locale: string, speaker: string, quality: string, id: string }>}
 */
export function listVoicePaths(paths, locales) {
  return paths
    .map((file) => ({ file, match: VOICE_PATH.exec(file) }))
    .filter(({ match }) => match?.groups && locales.includes(match.groups.locale))
    .map(({ file, match }) => /** @type {any} */ ({ file, ...match.groups }))
    .sort((a, b) => a.locale.localeCompare(b.locale)
      || a.speaker.localeCompare(b.speaker)
      || QUALITY_ORDER.indexOf(a.quality) - QUALITY_ORDER.indexOf(b.quality));
}

/**
 * @param {any} info the /api/models/<repo>/revision/<sha>?blobs=true response
 * @param {PiperPinOptions} options
 * @param {(file: string) => Promise<Uint8Array>} fetchBytes
 * @returns {Promise<{ catalog: any, excluded: Array<{ id: string, reason: string }> }>}
 */
export async function buildCatalog(info, options, fetchBytes) {
  const decoder = new TextDecoder();
  const cache = new Map();
  const cachedBytes = async (file) => {
    if (!cache.has(file)) cache.set(file, await fetchBytes(file));
    return cache.get(file);
  };
  const candidates = listVoicePaths(info.siblings.map((entry) => entry.rfilename), options.locales);
  const voices = [];
  const excluded = [];
  for (const candidate of candidates) {
    const directory = path.posix.dirname(candidate.file);
    const card = parseModelCard(decoder.decode(await cachedBytes(`${directory}/MODEL_CARD`)));
    const license = classifyLicense(card.licenseText);
    if (!license) {
      excluded.push({ id: candidate.id, reason: `dataset license ${JSON.stringify(card.licenseText)} is not permissive or not stated` });
      continue;
    }
    const config = JSON.parse(decoder.decode(await cachedBytes(`${candidate.file}.json`)));
    const espeakVoice = config.espeak?.voice;
    if ((config.phoneme_type ?? "espeak") !== "espeak" || typeof espeakVoice !== "string" || !/^en(?:-|$)/.test(espeakVoice)) {
      excluded.push({ id: candidate.id, reason: "needs a non-English phonemizer" });
      continue;
    }
    const name = displayName(candidate.speaker);
    voices.push({
      id: candidate.id,
      name,
      locale: candidate.locale,
      language: candidate.family,
      quality: candidate.quality,
      sampleRate: config.audio.sample_rate,
      numSpeakers: config.num_speakers ?? 1,
      espeakVoice,
      model: candidate.file,
      config: `${candidate.file}.json`,
      license: { id: license.id, url: license.url },
      datasetUrl: card.datasetUrl,
      attribution: attributionFor(name, license, card.datasetUrl),
    });
  }
  if (voices.length === 0) throw new Error("No voice of the requested locales has a permissive license.");

  const manifest = await buildManifest(
    info,
    {
      repo: PIPER_REPO,
      revision: options.revision,
      include: voices.flatMap((voice) => [voice.model, voice.config]),
      exclude: [],
      licenses: ["mit"],
      sha256: true,
    },
    cachedBytes,
  );
  return { catalog: { ...manifest, voices }, excluded };
}

export function regenerateCommand(options) {
  return [
    "node scripts/pin-piper-voices.mjs",
    `--revision ${options.revision}`,
    ...options.locales.map((locale) => `--locale ${locale}`),
    ...(options.out ? [`--out ${options.out}`] : []),
  ].join(" ");
}

export function renderCatalog(catalog, options) {
  return [
    "// Generated by scripts/pin-piper-voices.mjs from the Hugging Face Hub API. Do",
    "// not edit by hand; regenerate with:",
    `//   ${regenerateCommand(options)}`,
    'import type { PiperCatalog } from "../../lib/piperVoices";',
    "",
    `export const PIPER_CATALOG = ${JSON.stringify(catalog, null, 2)} as const satisfies PiperCatalog;`,
    "",
  ].join("\n");
}

export function parseRenderedCatalog(text) {
  const match = /export const PIPER_CATALOG = (\{[\s\S]*\}) as const satisfies PiperCatalog;/.exec(text);
  if (!match) throw new Error("The file is not a catalog generated by this script.");
  return JSON.parse(match[1]);
}

/** Differences between two catalogs, file integrity first and then voice entries. */
export function diffCatalogs(previous, next) {
  const differences = diffManifests(previous, next);
  const before = new Map((previous.voices ?? []).map((voice) => [voice.id, JSON.stringify(voice)]));
  const after = new Map((next.voices ?? []).map((voice) => [voice.id, JSON.stringify(voice)]));
  for (const id of [...new Set([...before.keys(), ...after.keys()])].sort()) {
    if (!before.has(id)) differences.push(`added voice ${id}`);
    else if (!after.has(id)) differences.push(`removed voice ${id}`);
    else if (before.get(id) !== after.get(id)) differences.push(`changed voice ${id}`);
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
  const info = await fetchJson(revisionInfoUrl(PIPER_REPO, options.revision));
  const { catalog, excluded } = await buildCatalog(info, options, async (file) => {
    const url = resolveFileUrl(PIPER_REPO, options.revision, file);
    const response = await fetch(url);
    if (!response.ok) throw new Error(`GET ${url} failed with HTTP ${response.status}.`);
    return new Uint8Array(await response.arrayBuffer());
  });
  for (const { id, reason } of excluded) console.error(`excluded ${id}: ${reason}`);
  const rendered = renderCatalog(catalog, options);

  if (!options.out) {
    process.stdout.write(rendered);
    return;
  }
  const outPath = path.resolve(rootDir, options.out);
  if (options.check) {
    const differences = diffCatalogs(parseRenderedCatalog(await readFile(outPath, "utf8")), catalog);
    if (differences.length > 0) {
      console.error(`${options.out} does not match ${PIPER_REPO}@${options.revision}:`);
      for (const difference of differences) console.error(`  ${difference}`);
      process.exitCode = 1;
      return;
    }
    console.log(`${options.out} matches ${PIPER_REPO}@${options.revision} (${catalog.voices.length} voices).`);
    return;
  }
  await writeFile(outPath, rendered);
  console.log(`Wrote ${catalog.voices.length} voices (${Object.keys(catalog.files).length} pinned files) to ${options.out}.`);
}

const isDirectRun = process.argv[1] !== undefined && path.resolve(process.argv[1]) === scriptPath;
if (isDirectRun) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
