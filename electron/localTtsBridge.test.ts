// @vitest-environment node

import fs from "fs";
import os from "os";
import path from "path";
import { spawnSync } from "child_process";
import { fileURLToPath } from "url";
import { describe, expect, it } from "vitest";

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BRIDGE_PATH = path.join(ROOT_DIR, "python", "local_tts_bridge.py");
const NEUTTS_PYTHON = path.join(
  ROOT_DIR,
  ".venv-neutts",
  process.platform === "win32" ? "Scripts" : "bin",
  process.platform === "win32" ? "python.exe" : "python",
);
const RESULT_PREFIX = "__RESULT__";
const PROGRESS_PREFIX = "__PROGRESS__";
const SYSTEM_PYTHON = process.env.PYTHON ?? "python3";
const HAS_SYSTEM_PYTHON = spawnSync(SYSTEM_PYTHON, [
  "-c",
  "import sys; raise SystemExit(0 if sys.version_info >= (3, 10) else 1)",
], { encoding: "utf-8" }).status === 0;
const RUN_LOCAL_BRIDGE_TESTS = process.env.OPEN_TTS_RUN_LOCAL_BRIDGE_TESTS === "1"
  && fs.existsSync(NEUTTS_PYTHON);

function runNeuttsBridge(
  action: "probe" | "generate",
  payload: Record<string, unknown> = {},
  env: NodeJS.ProcessEnv = process.env,
) {
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "open-tts-bridge-"));
  try {
    return spawnSync(
      NEUTTS_PYTHON,
      [BRIDGE_PATH, "--action", action, "--model", "neutts", "--cache-dir", cacheDir],
      {
        encoding: "utf-8",
        env: {
          ...env,
          PYTHONIOENCODING: "utf-8",
        },
        input: JSON.stringify(payload),
      },
    );
  } finally {
    fs.rmSync(cacheDir, { recursive: true, force: true });
  }
}

function getResultPayload(stdout: string) {
  const resultLine = stdout.split(/\r?\n/).find((line) => line.startsWith(RESULT_PREFIX));
  expect(resultLine).toBeTruthy();
  return JSON.parse(resultLine!.slice(RESULT_PREFIX.length)) as {
    ok: boolean;
    result?: Record<string, unknown>;
    error?: string;
  };
}

function runBridgeUnitScript(script: string) {
  return spawnSync(SYSTEM_PYTHON, ["-c", script], {
    encoding: "utf-8",
    env: {
      ...process.env,
      PYTHONIOENCODING: "utf-8",
    },
  });
}

describe("local_tts_bridge.py", () => {
  it.runIf(HAS_SYSTEM_PYTHON)("requires NeuTTS to expose an explicit sample rate", () => {
    const completed = runBridgeUnitScript(`
import importlib.util
import sys
import types

spec = importlib.util.spec_from_file_location("local_tts_bridge", ${JSON.stringify(BRIDGE_PATH)})
bridge = importlib.util.module_from_spec(spec)
assert spec.loader is not None
spec.loader.exec_module(bridge)

bridge.decode_reference_audio = lambda _value: b"reference wav bytes"
bridge.validate_reference_wav = lambda _value: None
bridge.is_neutts_python_compatible = lambda: True
bridge.get_installed_package_version = lambda _package: "1.2.0"
bridge.detect_neutts_compatibility = lambda _version: "current_1_2_x_or_newer"
bridge.prepare_neutts_runtime = lambda _mode: None
bridge.check_espeak = lambda: (True, "espeak-ng 1.52", "espeak-ng")
bridge.array_to_wav_base64 = lambda _audio, _sample_rate: "UklGRg=="

class FakeNeuTTS:
    def __init__(self, **_kwargs):
        pass

    def encode_reference(self, _path):
        return "reference-codes"

    def infer(self, _text, _ref_codes, _ref_text):
        return [0.0, 0.1]

module = types.ModuleType("neutts")
module.NeuTTS = FakeNeuTTS
sys.modules["neutts"] = module

try:
    bridge.generate_neutts({
        "text": "Hello from NeuTTS.",
        "referenceText": "Reference transcript.",
        "referenceAudioBase64": "UklGRg==",
    })
except RuntimeError as exc:
    if "sample_rate" not in str(exc):
        raise
else:
    raise AssertionError("generate_neutts accepted a runtime without sample_rate")
`);

    expect(completed.status, completed.stderr || completed.stdout).toBe(0);
  });

  it.runIf(HAS_SYSTEM_PYTHON)("uses the sample rate returned by Kani generation", () => {
    const completed = runBridgeUnitScript(`
import importlib.util
import sys
import types

spec = importlib.util.spec_from_file_location("local_tts_bridge", ${JSON.stringify(BRIDGE_PATH)})
bridge = importlib.util.module_from_spec(spec)
assert spec.loader is not None
spec.loader.exec_module(bridge)

bridge.detect_kani_package = lambda: ("kani-tts-2", "2.0.0")
bridge.detect_kani_transformers_version = lambda: "4.56.0"
bridge.array_to_wav_base64 = lambda _audio, _sample_rate: "UklGRg=="

class FakeKaniTTS:
    def __init__(self, *_args, **_kwargs):
        pass

    def generate(self, *_args, **_kwargs):
        return [0.0, 0.1], 44100

module = types.ModuleType("kani_tts")
module.KaniTTS = FakeKaniTTS
sys.modules["kani_tts"] = module

result = bridge.generate_kani({"text": "Hello from Kani."})
if result["sampleRate"] != 44100:
    raise AssertionError(f"Expected Kani sampleRate 44100, got {result['sampleRate']}")
`);

    expect(completed.status, completed.stderr || completed.stdout).toBe(0);
  });

  it.runIf(RUN_LOCAL_BRIDGE_TESTS)("reports NeuTTS compatibility metadata during probe", () => {
    const completed = runNeuttsBridge("probe");

    expect(completed.status).toBe(0);
    const payload = getResultPayload(completed.stdout);
    expect(payload.ok).toBe(true);
    expect(payload.result?.package).toBe("neutts");
    expect(typeof payload.result?.packageVersion).toBe("string");
    expect(["legacy_0_1_x", "current_1_2_x_or_newer"]).toContain(payload.result?.compatibilityMode);
  }, 15_000);

  it.runIf(RUN_LOCAL_BRIDGE_TESTS)("surfaces missing espeak-ng clearly when PATH is unavailable", () => {
    const completed = runNeuttsBridge("probe", {}, {
      ...process.env,
      PATH: "",
    });

    expect(completed.status).toBe(0);
    const payload = getResultPayload(completed.stdout);
    expect(payload.ok).toBe(true);
    expect(payload.result?.ready).toBe(false);
    expect(String(payload.result?.message)).toMatch(/espeak-ng/i);
  });

  it.runIf(RUN_LOCAL_BRIDGE_TESTS)("emits progress before returning invalid reference audio errors", () => {
    const completed = runNeuttsBridge("generate", {
      text: "Generate this sample locally.",
      referenceText: "Reference transcript",
      referenceAudioBase64: "%%%not-base64%%%",
    });

    expect(completed.status).toBe(0);
    const progressLines = completed.stdout
      .split(/\r?\n/)
      .filter((line) => line.startsWith(PROGRESS_PREFIX))
      .map((line) => JSON.parse(line.slice(PROGRESS_PREFIX.length)) as { phase: string; message: string });

    expect(progressLines).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ phase: "runtime_check" }),
      ]),
    );

    const payload = getResultPayload(completed.stdout);
    expect(payload.ok).toBe(false);
    expect(payload.error).toContain("Reference audio is not valid base64-encoded WAV data.");
  });
});
