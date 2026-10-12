// @vitest-environment node

import { readdirSync, readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { describe, expect, it } from "vitest";
import { GENERATION_CANCELLED_MESSAGE } from "./errors";
import { ALLOWED_NEUTTS_MODELS, BRIDGE_RESULT_PREFIX } from "./localTtsIpc";
import {
  MAX_LOCAL_TTS_TEXT_LENGTH,
  MAX_REFERENCE_AUDIO_BASE64_LENGTH,
  MAX_REFERENCE_CACHE_KEY_LENGTH,
  MAX_REFERENCE_CODES_BASE64_LENGTH,
  MAX_REFERENCE_CODES_FILE_BYTES,
  MAX_REFERENCE_TEXT_LENGTH,
  NEUTTS_DEFAULT_MODEL_REPO,
  QWEN3_MAX_NEW_TOKENS_PER_PASSAGE,
  QWEN3_MIN_NEW_TOKENS,
} from "./localTtsLimits";
import {
  BRIDGE_PORT_PREFIX,
  DEFAULT_MAX_REQUEST_TEXT_BYTES,
  MAX_AUDIO_CHUNK_SAMPLES,
  MAX_AUDIO_SILENCE_SAMPLES,
  MAX_AUDIO_SAMPLE_RATE,
  UNIT_GAP_FIELDS,
  UNIT_GAP_MESSAGE_TYPE,
  parseUnitGapMetadata,
} from "./wsBridge/protocol";

// Limits and protocol strings that TypeScript and the Rust bridge each declare
// and must agree on. The Rust side cannot be built on every machine, so its
// constants are read from source. The whole crate is searched, not one file:
// where a constant lives may change, its value may not.

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BRIDGE_SOURCE_DIR = path.join(REPO_ROOT, "rust/local-tts-bridge/src");
// The renderer's Qwen3 text-unit chunking lives outside the Electron project,
// so it is loaded at run time rather than imported.
const QWEN_CHUNKING_MODULE = path.join(REPO_ROOT, "src/lib/qwenChunking.ts");
const SOURCE_LABEL = "rust/local-tts-bridge/src";

type RustValue = number | string;

interface RustConst {
  name: string;
  expression: string;
  location: string;
}

function rustSourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return rustSourceFiles(entryPath);
    return entry.name.endsWith(".rs") ? [entryPath] : [];
  });
}

/** The source without its inline `#[cfg(test)] mod … { … }` modules, which sit at the end. */
function withoutTestModules(source: string): string {
  const match = /^[ \t]*#\[cfg\(test\)\][ \t]*\r?\n[ \t]*(?:pub(?:\([^)]*\))?[ \t]+)?mod[ \t]+\w+[ \t]*\{/m.exec(source);
  return match ? source.slice(0, match.index) : source;
}

/** Every `const NAME: Type = expression;` of the crate, keyed by name. */
function parseRustConsts(sources: { file: string; source: string }[]): Map<string, RustConst[]> {
  const consts = new Map<string, RustConst[]>();
  const declaration = /^[ \t]*(?:pub(?:\([^)]*\))?[ \t]+)?const[ \t]+([A-Z][A-Z0-9_]*)[ \t]*:[^=;]+=\s*([^;]+);/gm;
  for (const { file, source } of sources) {
    const code = withoutTestModules(source);
    for (const match of code.matchAll(declaration)) {
      const line = code.slice(0, match.index).split("\n").length;
      const entry = { name: match[1], expression: match[2].trim(), location: `${file}:${line}` };
      consts.set(entry.name, [...(consts.get(entry.name) ?? []), entry]);
    }
  }
  return consts;
}

/**
 * Evaluates the constant expressions limits are written in: string literals,
 * integer literals (with `_` separators and type suffixes), other constants,
 * `+ - * /`, parentheses, `as` casts and `.div_ceil(n)`.
 */
function evaluateRustConst(name: string, consts: Map<string, RustConst[]>, seen: string[] = []): RustValue {
  const entries = consts.get(name);
  if (!entries) throw new Error(`${name} is not declared anywhere in ${SOURCE_LABEL}.`);
  if (seen.includes(name)) throw new Error(`${name} is defined in terms of itself.`);
  const values = entries.map((entry) => evaluateExpression(entry.expression, consts, [...seen, name]));
  if (new Set(values).size > 1) {
    throw new Error(`${name} has conflicting declarations: ${entries.map((entry) => entry.location).join(", ")}.`);
  }
  return values[0];
}

function evaluateExpression(expression: string, consts: Map<string, RustConst[]>, seen: string[]): RustValue {
  const literal = /^"((?:[^"\\]|\\.)*)"$/.exec(expression);
  if (literal) return JSON.parse(`"${literal[1]}"`) as string;

  const tokens = expression.match(/\d[\d_]*(?:[iu](?:8|16|32|64|128|size))?|[A-Za-z_][A-Za-z0-9_]*|\.div_ceil|[-+*/()]|\S/g) ?? [];
  let position = 0;
  const peek = () => tokens[position];
  const take = () => tokens[position++];
  const expect = (token: string) => {
    if (take() !== token) throw new Error(`Cannot evaluate \`${expression}\`: expected \`${token}\`.`);
  };

  function sum(): number {
    let value = product();
    while (peek() === "+" || peek() === "-") value = take() === "+" ? value + product() : value - product();
    return value;
  }
  function product(): number {
    let value = postfix();
    while (peek() === "*" || peek() === "/") value = take() === "*" ? value * postfix() : Math.trunc(value / postfix());
    return value;
  }
  function postfix(): number {
    let value = primary();
    for (;;) {
      if (peek() === "as") {
        take();
        take();
      } else if (peek() === ".div_ceil") {
        take();
        expect("(");
        const divisor = sum();
        expect(")");
        value = Math.ceil(value / divisor);
      } else {
        return value;
      }
    }
  }
  function primary(): number {
    const token = take();
    if (token === undefined) throw new Error(`Cannot evaluate \`${expression}\`: it ends early.`);
    if (token === "(") {
      const value = sum();
      expect(")");
      return value;
    }
    if (/^\d/.test(token)) return Number(token.replace(/[iu]\w+$/, "").replaceAll("_", ""));
    if (/^[A-Z][A-Z0-9_]*$/.test(token)) {
      const value = evaluateRustConst(token, consts, seen);
      if (typeof value !== "number") throw new Error(`Cannot evaluate \`${expression}\`: ${token} is not a number.`);
      return value;
    }
    throw new Error(`Cannot evaluate \`${expression}\`: unsupported token \`${token}\`.`);
  }

  const value = sum();
  if (position !== tokens.length) throw new Error(`Cannot evaluate \`${expression}\`: unexpected \`${peek()}\`.`);
  return value;
}

/**
 * The NeuTTS repositories the bridge accepts: the one array, outside tests,
 * made only of `neuphonic/` string literals.
 */
function rustNeuttsAllowList(sources: { file: string; source: string }[]): string[] {
  const lists = sources.flatMap(({ source }) => [
    ...withoutTestModules(source).matchAll(/\[\s*((?:"neuphonic\/[^"]+"\s*,\s*)+"neuphonic\/[^"]+"\s*,?\s*)\]/g),
  ]);
  if (lists.length !== 1) {
    throw new Error(`Expected one NeuTTS allow-list array in ${SOURCE_LABEL}, found ${lists.length}.`);
  }
  return [...lists[0][1].matchAll(/"([^"]+)"/g)].map((match) => match[1]);
}

const sources = rustSourceFiles(BRIDGE_SOURCE_DIR).map((file) => ({
  file: path.relative(BRIDGE_SOURCE_DIR, file),
  source: readFileSync(file, "utf-8"),
}));
const consts = parseRustConsts(sources);
const rust = (name: string) => evaluateRustConst(name, consts);

describe("TypeScript and Rust bridge parity", () => {
  it("agrees on the startup and cancellation strings", () => {
    expect(BRIDGE_PORT_PREFIX).toBe(rust("PORT_PREFIX"));
    expect(BRIDGE_RESULT_PREFIX).toBe(rust("RESULT_PREFIX"));
    // The worker pool keeps a cancelled worker warm only on this exact text.
    expect(GENERATION_CANCELLED_MESSAGE).toBe(rust("CANCELLED_MESSAGE"));
  });

  it("agrees on the audio frame ceiling, which fits one socket write buffer", () => {
    expect(MAX_AUDIO_CHUNK_SAMPLES).toBe(rust("MAX_AUDIO_CHUNK_SAMPLES"));
    expect(MAX_AUDIO_CHUNK_SAMPLES * Float32Array.BYTES_PER_ELEMENT)
      .toBeLessThanOrEqual(rust("MAX_WEBSOCKET_WRITE_BUFFER_BYTES") as number);
  });

  it("agrees on the unit_gap frame: its type, its fields, and a silence the stream limits admit", () => {
    expect(UNIT_GAP_MESSAGE_TYPE).toBe(rust("UNIT_GAP_FRAME_TYPE"));

    // The fields the Rust frame builder writes, read from its json! literal.
    const protocolSource = sources.find(({ file }) => file === "protocol.rs")!.source;
    const builder = /pub fn unit_gap_frame\([\s\S]*?json!\(\{([\s\S]*?)\}\)/.exec(withoutTestModules(protocolSource));
    if (!builder) throw new Error("unit_gap_frame is not declared in protocol.rs.");
    const rustFields = [...builder[1].matchAll(/"(\w+)"\s*:/g)].map((match) => match[1]).filter((field) => field !== "type");
    expect(rustFields.sort()).toEqual([...UNIT_GAP_FIELDS].sort());

    // A frame with exactly those fields parses, and the 0.2 s gap Rust writes
    // (a fifth of the rate) stays under the ceiling at the highest accepted rate.
    const frame = { type: UNIT_GAP_MESSAGE_TYPE, requestId: "r", sampleRate: 24_000, textUnitIndex: 0, textUnitTotal: 2, silenceSamples: 4_800 };
    expect(Object.keys(frame).filter((field) => field !== "type").sort()).toEqual([...UNIT_GAP_FIELDS].sort());
    expect(parseUnitGapMetadata(frame, "r")).toMatchObject({ silenceSamples: 4_800 });
    expect(Math.floor(MAX_AUDIO_SAMPLE_RATE / 5)).toBeLessThanOrEqual(MAX_AUDIO_SILENCE_SAMPLES);
  });

  it("refuses an oversize request before the bridge's frame ceiling would close the socket", () => {
    expect(DEFAULT_MAX_REQUEST_TEXT_BYTES).toBeLessThan(rust("MAX_WEBSOCKET_TEXT_FRAME_BYTES") as number);
    // The largest payload, a reference WAV, still fits with room for its envelope.
    expect(MAX_REFERENCE_AUDIO_BASE64_LENGTH + 1024 * 1024).toBeLessThanOrEqual(DEFAULT_MAX_REQUEST_TEXT_BYTES);
  });

  it("agrees on the request field limits", () => {
    expect(MAX_LOCAL_TTS_TEXT_LENGTH).toBe(rust("MAX_LOCAL_TTS_TEXT_CHARS"));
    expect(MAX_REFERENCE_TEXT_LENGTH).toBe(rust("MAX_REFERENCE_TEXT_CHARS"));
    expect(MAX_REFERENCE_CACHE_KEY_LENGTH).toBe(rust("MAX_REFERENCE_CACHE_KEY_CHARS"));
    expect(MAX_REFERENCE_AUDIO_BASE64_LENGTH).toBe(rust("MAX_REFERENCE_AUDIO_BASE64_CHARS"));
    expect(MAX_REFERENCE_CODES_FILE_BYTES).toBe(rust("MAX_NEUTTS_REFERENCE_CODES_FILE_BYTES"));
    expect(MAX_REFERENCE_CODES_BASE64_LENGTH).toBe(rust("MAX_NEUTTS_REFERENCE_CODES_BASE64_CHARS"));
  });

  it("agrees on the Qwen3 token budget and text-unit chunking", async () => {
    const { QWEN3_CJK_CHARACTER_WEIGHT, QWEN3_UNIT_MAX_CHARS } = await import(QWEN_CHUNKING_MODULE) as {
      QWEN3_CJK_CHARACTER_WEIGHT: number;
      QWEN3_UNIT_MAX_CHARS: number;
    };
    expect(QWEN3_MAX_NEW_TOKENS_PER_PASSAGE).toBe(rust("MAX_TEXT_UNIT_GENERATION_TOKENS"));
    expect(QWEN3_MIN_NEW_TOKENS).toBe(rust("MIN_GENERATION_TOKENS"));
    expect(QWEN3_UNIT_MAX_CHARS).toBe(rust("CUSTOM_VOICE_UNIT_CHARS"));
    expect(QWEN3_CJK_CHARACTER_WEIGHT).toBe(rust("CJK_CHAR_WEIGHT"));
  });

  it("agrees on the NeuTTS models and the default one", () => {
    expect(NEUTTS_DEFAULT_MODEL_REPO).toBe(rust("NEUTTS_DEFAULT_MODEL"));
    expect([...ALLOWED_NEUTTS_MODELS].sort()).toEqual(rustNeuttsAllowList(sources).sort());
  });
});

describe("Rust constant reader", () => {
  const parse = (source: string) => parseRustConsts([{ file: "lib.rs", source }]);

  it("evaluates the expressions limits are written in", () => {
    const parsed = parse([
      "const KIB: usize = 1_024;",
      "pub const FILE_BYTES: usize = 64 * KIB;",
      "pub(crate) const BASE64_CHARS: usize =",
      "    FILE_BYTES.div_ceil(3) * 4;",
      "const RATE: u32 = 24_000u32;",
      "const WINDOW: usize = RATE as usize * 20 / (1 + 1) - 0;",
      "const PREFIX: &str = \"__PORT__\";",
      "const QUOTED: &str = \"say \\\"hi\\\"\";",
    ].join("\n"));

    expect(evaluateRustConst("FILE_BYTES", parsed)).toBe(65_536);
    expect(evaluateRustConst("BASE64_CHARS", parsed)).toBe(87_384);
    expect(evaluateRustConst("WINDOW", parsed)).toBe(240_000);
    expect(evaluateRustConst("PREFIX", parsed)).toBe("__PORT__");
    expect(evaluateRustConst("QUOTED", parsed)).toBe("say \"hi\"");
  });

  it("ignores constants declared in an inline test module", () => {
    const parsed = parse("const LIMIT: usize = 8;\n\n#[cfg(test)]\nmod tests {\n    const LIMIT: usize = 9;\n}\n");
    expect(evaluateRustConst("LIMIT", parsed)).toBe(8);
  });

  it("explains a missing, conflicting, circular or unsupported constant", () => {
    const parsed = parseRustConsts([
      { file: "a.rs", source: "const SAME: usize = 1;\nconst TWICE: usize = 1;\nconst LOOP: usize = LOOP + 1;" },
      { file: "b.rs", source: "const SAME: usize = 1;\nconst TWICE: usize = 2;\nconst CALL: usize = size_of::<u32>();" },
    ]);

    expect(evaluateRustConst("SAME", parsed)).toBe(1);
    expect(() => evaluateRustConst("MISSING", parsed)).toThrow(`MISSING is not declared anywhere in ${SOURCE_LABEL}.`);
    expect(() => evaluateRustConst("TWICE", parsed)).toThrow("TWICE has conflicting declarations: a.rs:2, b.rs:2.");
    expect(() => evaluateRustConst("LOOP", parsed)).toThrow("LOOP is defined in terms of itself.");
    expect(() => evaluateRustConst("CALL", parsed)).toThrow("unsupported token `size_of`");
  });

  it("finds the one NeuTTS allow-list outside tests", () => {
    const list = "[\n  \"neuphonic/a\",\n  \"neuphonic/b\",\n]";
    expect(rustNeuttsAllowList([{ file: "a.rs", source: `const ALLOWED: [&str; 2] = ${list};` }]))
      .toEqual(["neuphonic/a", "neuphonic/b"]);
    expect(rustNeuttsAllowList([{
      file: "a.rs",
      source: `let allowed = ${list};\n#[cfg(test)]\nmod tests {\n    const OTHER: [&str; 2] = ${list};\n}`,
    }])).toEqual(["neuphonic/a", "neuphonic/b"]);
    expect(() => rustNeuttsAllowList([{ file: "a.rs", source: "" }]))
      .toThrow(`Expected one NeuTTS allow-list array in ${SOURCE_LABEL}, found 0.`);
  });
});
