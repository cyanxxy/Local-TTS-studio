// @vitest-environment node

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { gitBlobSha1 } from "./scripts/pin-hf-assets.mjs";
import {
  attributionFor,
  buildCatalog,
  classifyLicense,
  diffCatalogs,
  displayName,
  listVoicePaths,
  parseArgs,
  parseModelCard,
  parseRenderedCatalog,
  regenerateCommand,
  renderCatalog,
} from "./scripts/pin-piper-voices.mjs";

const REVISION = "c10ece1aade47bb51c153c893d14e5bf8e5b7117";
const encoder = new TextEncoder();

describe("pin-piper-voices arguments", () => {
  it("parses the revision, locales and output", () => {
    expect(parseArgs(["--revision", REVISION, "--locale=en_US", "--locale", "en_GB", "--out", "x.ts", "--check"]))
      .toEqual({ revision: REVISION, locales: ["en_US", "en_GB"], out: "x.ts", check: true });
  });

  it.each([
    [["--locale", "en_US"], "40-character"],
    [["--revision", "main", "--locale", "en_US"], "40-character"],
    [["--revision", REVISION], "at least one --locale"],
    [["--revision", REVISION, "--locale", "english"], "at least one --locale"],
    [["--revision", REVISION, "--locale", "en_US", "--check"], "--check needs --out"],
    [["--revision", REVISION, "--locale"], "needs a value"],
    [["--revision", REVISION, "--bogus"], "Unknown option"],
  ])("rejects %j", (argv, message) => {
    expect(() => parseArgs(argv)).toThrow(message);
  });
});

describe("MODEL_CARD license classification", () => {
  it("reads the dataset URL and license line", () => {
    expect(parseModelCard("# Card\n\n## Dataset\n\n* URL: https://librivox.org\n* License: public domain\nMore text.\n"))
      .toEqual({ datasetUrl: "https://librivox.org", licenseText: "public domain" });
    expect(parseModelCard("## Dataset\n* License: CC0\n")).toEqual({ datasetUrl: null, licenseText: "CC0" });
    expect(parseModelCard("nothing here")).toEqual({ datasetUrl: null, licenseText: null });
  });

  it.each([
    ["public domain", "public-domain"],
    ["Public-Domain", "public-domain"],
    ["CC0", "CC0-1.0"],
    ["https://creativecommons.org/publicdomain/zero/1.0/", "CC0-1.0"],
    ["CC BY 4.0", "CC-BY-4.0"],
    ["https://creativecommons.org/licenses/by/4.0/", "CC-BY-4.0"],
    ["http://creativecommons.org/licenses/by/4.0", "CC-BY-4.0"],
    ["https://www.apache.org/licenses/LICENSE-2.0.txt", "Apache-2.0"],
    ["Apache License 2.0", "Apache-2.0"],
    ["MIT", "MIT"],
  ])("accepts %s", (text, id) => {
    expect(classifyLicense(text)?.id).toBe(id);
  });

  it.each([
    "See URL",
    "See LICENSE file",
    "CC-BY-SA 4.0 International",
    "CC BY-NC-SA 4.0",
    "https://creativecommons.org/licenses/by-nc/4.0/",
    "http://creativecommons.org/licenses/by-nc-sa/4.0/",
    "https://creativecommons.org/licenses/by-sa/4.0/",
    "https://www.cstr.ed.ac.uk/projects/blizzard/2013/lessac_blizzard2013/license.html",
    "",
    null,
  ])("rejects %j", (text) => {
    expect(classifyLicense(text)).toBeNull();
  });
});

describe("voice naming", () => {
  it("lists the graphs of the requested locales in a stable order", () => {
    const paths = [
      "en/en_US/zed/high/en_US-zed-high.onnx",
      "en/en_US/zed/low/en_US-zed-low.onnx",
      "en/en_US/amy/medium/en_US-amy-medium.onnx",
      "en/en_US/amy/medium/en_US-amy-medium.onnx.json",
      "de/de_DE/eva/low/de_DE-eva-low.onnx",
      "voices.json",
    ];

    expect(listVoicePaths(paths, ["en_US"]).map(({ id }) => id)).toEqual(["en_US-amy-medium", "en_US-zed-low", "en_US-zed-high"]);
  });

  it("names speakers and credits datasets", () => {
    expect(displayName("kristin")).toBe("Kristin");
    expect(displayName("northern_english_male")).toBe("Northern English Male");
    expect(displayName("libritts_r")).toBe("LibriTTS-R");
    expect(attributionFor("Alba", classifyLicense("CC BY 4.0"), "https://datashare.ed.ac.uk/handle/10283/3270"))
      .toBe("Alba: Piper voice (rhasspy/piper-voices, MIT) trained on the dataset at https://datashare.ed.ac.uk/handle/10283/3270, licensed CC BY 4.0.");
    expect(attributionFor("Bryce", classifyLicense("public domain"), null))
      .toBe("Bryce: Piper voice (rhasspy/piper-voices, MIT) trained on a public domain dataset, in the public domain.");
  });
});

function voiceConfig(overrides: Record<string, unknown> = {}) {
  return encoder.encode(JSON.stringify({
    audio: { sample_rate: 22_050 },
    espeak: { voice: "en-us" },
    num_speakers: 1,
    phoneme_type: "espeak",
    ...overrides,
  }));
}

const FILES = new Map<string, Uint8Array>([
  ["en/en_US/good/medium/MODEL_CARD", encoder.encode("## Dataset\n* URL: https://example.org/good\n* License: CC0\n")],
  ["en/en_US/good/medium/en_US-good-medium.onnx.json", voiceConfig({ num_speakers: 4 })],
  ["en/en_US/nc/medium/MODEL_CARD", encoder.encode("## Dataset\n* License: CC BY-NC-SA 4.0\n")],
  ["en/en_US/nc/medium/en_US-nc-medium.onnx.json", voiceConfig()],
  ["en/en_US/german/medium/MODEL_CARD", encoder.encode("## Dataset\n* License: public domain\n")],
  ["en/en_US/german/medium/en_US-german-medium.onnx.json", voiceConfig({ espeak: { voice: "de" } })],
  ["en/en_US/old/low/MODEL_CARD", encoder.encode("## Dataset\n* License: public domain\n")],
  ["en/en_US/old/low/en_US-old-low.onnx.json", voiceConfig({ phoneme_type: undefined, audio: { sample_rate: 16_000 } })],
]);

function revisionInfo() {
  const graph = (file: string, size: number) => ({
    rfilename: file,
    blobId: "a".repeat(40),
    size,
    lfs: { sha256: createHash("sha256").update(file).digest("hex"), size, pointerSize: 130 },
  });
  const small = (file: string) => ({ rfilename: file, blobId: gitBlobSha1(FILES.get(file)!), size: FILES.get(file)!.byteLength });
  return {
    sha: REVISION,
    cardData: { license: "mit" },
    siblings: [
      graph("en/en_US/good/medium/en_US-good-medium.onnx", 100),
      graph("en/en_US/nc/medium/en_US-nc-medium.onnx", 100),
      graph("en/en_US/german/medium/en_US-german-medium.onnx", 100),
      graph("en/en_US/old/low/en_US-old-low.onnx", 100),
      ...[...FILES.keys()].map(small),
    ],
  };
}

const options = { revision: REVISION, locales: ["en_US"], out: "src/workers/manifests/piperVoices.ts", check: false };
const fetchBytes = async (file: string) => FILES.get(file) ?? Promise.reject(new Error(`unexpected fetch ${file}`));

describe("buildCatalog", () => {
  it("keeps permissive English voices with their pinned files and reports every exclusion", async () => {
    const { catalog, excluded } = await buildCatalog(revisionInfo(), options, fetchBytes);

    expect(catalog.voices.map((voice: { id: string }) => voice.id)).toEqual(["en_US-good-medium", "en_US-old-low"]);
    expect(catalog.voices[0]).toEqual({
      id: "en_US-good-medium",
      name: "Good",
      locale: "en_US",
      language: "en",
      quality: "medium",
      sampleRate: 22_050,
      numSpeakers: 4,
      espeakVoice: "en-us",
      model: "en/en_US/good/medium/en_US-good-medium.onnx",
      config: "en/en_US/good/medium/en_US-good-medium.onnx.json",
      license: { id: "CC0-1.0", url: "https://creativecommons.org/publicdomain/zero/1.0/" },
      datasetUrl: "https://example.org/good",
      attribution: "Good: Piper voice (rhasspy/piper-voices, MIT) trained on the dataset at https://example.org/good, licensed CC0 1.0.",
    });
    expect(catalog.voices[1]).toMatchObject({ sampleRate: 16_000, numSpeakers: 1, datasetUrl: null });
    expect(excluded).toEqual([
      { id: "en_US-german-medium", reason: "needs a non-English phonemizer" },
      { id: "en_US-nc-medium", reason: 'dataset license "CC BY-NC-SA 4.0" is not permissive or not stated' },
    ]);
    expect(Object.keys(catalog.files)).toEqual([
      "en/en_US/good/medium/en_US-good-medium.onnx",
      "en/en_US/good/medium/en_US-good-medium.onnx.json",
      "en/en_US/old/low/en_US-old-low.onnx",
      "en/en_US/old/low/en_US-old-low.onnx.json",
    ]);
    expect(catalog.files["en/en_US/good/medium/en_US-good-medium.onnx.json"]).toEqual({
      byteLength: FILES.get("en/en_US/good/medium/en_US-good-medium.onnx.json")!.byteLength,
      sha256: createHash("sha256").update(FILES.get("en/en_US/good/medium/en_US-good-medium.onnx.json")!).digest("hex"),
    });
    expect(catalog).toMatchObject({ repo: "rhasspy/piper-voices", revision: REVISION, license: "mit" });
  });

  it("fails when no voice qualifies", async () => {
    await expect(buildCatalog(revisionInfo(), { ...options, locales: ["en_GB"] }, fetchBytes))
      .rejects.toThrow("No voice of the requested locales has a permissive license.");
  });

  it("refuses a repository that is not MIT-licensed", async () => {
    await expect(buildCatalog({ ...revisionInfo(), cardData: { license: "gpl-3.0" } }, options, fetchBytes))
      .rejects.toThrow("not one of --license mit");
  });
});

describe("catalog rendering", () => {
  it("round-trips and names the command that regenerates it", async () => {
    const { catalog } = await buildCatalog(revisionInfo(), options, fetchBytes);
    const rendered = renderCatalog(catalog, options);

    expect(rendered).toContain(`//   ${regenerateCommand(options)}`);
    expect(regenerateCommand(options)).toBe(`node scripts/pin-piper-voices.mjs --revision ${REVISION} --locale en_US --out src/workers/manifests/piperVoices.ts`);
    expect(parseRenderedCatalog(rendered)).toEqual(catalog);
    expect(() => parseRenderedCatalog("export const X = 1;")).toThrow("not a catalog generated by this script");
  });

  it("reports file and voice differences", async () => {
    const { catalog } = await buildCatalog(revisionInfo(), options, fetchBytes);
    const changed = structuredClone(catalog);
    changed.voices[0].numSpeakers = 5;
    changed.voices.pop();
    changed.voices.push({ ...catalog.voices[0], id: "en_US-new-medium" });
    delete changed.files["en/en_US/old/low/en_US-old-low.onnx"];

    expect(diffCatalogs(catalog, catalog)).toEqual([]);
    expect(diffCatalogs(catalog, changed)).toEqual([
      "removed en/en_US/old/low/en_US-old-low.onnx",
      "changed voice en_US-good-medium",
      "added voice en_US-new-medium",
      "removed voice en_US-old-low",
    ]);
  });
});
