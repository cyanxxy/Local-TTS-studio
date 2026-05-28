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
bridge.check_espeak = lambda: (True, "eSpeak NG library 1.52", "library")
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
bridge.detect_kani_transformers_version = lambda: "4.56.1"
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

  it.runIf(HAS_SYSTEM_PYTHON)("rejects NeuTTS reference WAV files with unsupported metadata", () => {
    const completed = runBridgeUnitScript(`
import importlib.util
import io
import wave

spec = importlib.util.spec_from_file_location("local_tts_bridge", ${JSON.stringify(BRIDGE_PATH)})
bridge = importlib.util.module_from_spec(spec)
assert spec.loader is not None
spec.loader.exec_module(bridge)

def make_wav(channels, sample_rate):
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as wav_file:
        wav_file.setnchannels(channels)
        wav_file.setsampwidth(2)
        wav_file.setframerate(sample_rate)
        wav_file.writeframes(b"\\x00\\x00" * channels)
    return buffer.getvalue()

bridge.validate_reference_wav(make_wav(1, 24000))

try:
    bridge.validate_reference_wav(make_wav(2, 24000))
except ValueError as exc:
    if "mono" not in str(exc):
        raise
else:
    raise AssertionError("Stereo reference WAV was accepted")

try:
    bridge.validate_reference_wav(make_wav(1, 8000))
except ValueError as exc:
    if "sample rate" not in str(exc):
        raise
else:
    raise AssertionError("Low sample-rate reference WAV was accepted")
`);

    expect(completed.status, completed.stderr || completed.stdout).toBe(0);
  });

  it.runIf(HAS_SYSTEM_PYTHON)("uses the sample rate returned by Qwen3 generation", () => {
    const completed = runBridgeUnitScript(`
import importlib.util
import sys
import types

spec = importlib.util.spec_from_file_location("local_tts_bridge", ${JSON.stringify(BRIDGE_PATH)})
bridge = importlib.util.module_from_spec(spec)
assert spec.loader is not None
spec.loader.exec_module(bridge)

bridge.array_to_wav_base64 = lambda _audio, _sample_rate: "UklGRg=="

class FakeCuda:
    @staticmethod
    def is_available():
        return True

torch_module = types.ModuleType("torch")
torch_module.cuda = FakeCuda()
torch_module.bfloat16 = "bfloat16"
torch_module.float16 = "float16"
torch_module.float32 = "float32"
sys.modules["torch"] = torch_module

class FakeQwen3TTSModel:
    loaded_kwargs = None
    generated_kwargs = None

    @classmethod
    def from_pretrained(cls, _model_repo, **kwargs):
        cls.loaded_kwargs = kwargs
        return cls()

    def generate_custom_voice(self, **kwargs):
        FakeQwen3TTSModel.generated_kwargs = kwargs
        return [[0.0, 0.1]], 24000

    def get_supported_speakers(self):
        return ["Ryan", "Aiden"]

module = types.ModuleType("qwen_tts")
module.Qwen3TTSModel = FakeQwen3TTSModel
sys.modules["qwen_tts"] = module

result = bridge.generate_qwen3({
    "text": "Hello from Qwen.",
    "speaker": "Aiden",
    "language": "English",
    "deviceMap": "cuda:0",
    "dtype": "bfloat16",
    "attnImplementation": "flash_attention_2",
    "temperature": 0.75,
    "topP": 0.9,
    "maxNewTokens": 512,
})
if result["sampleRate"] != 24000:
    raise AssertionError(f"Expected Qwen3 sampleRate 24000, got {result['sampleRate']}")
if FakeQwen3TTSModel.loaded_kwargs["device_map"] != "cuda:0":
    raise AssertionError("Qwen3 device_map was not forwarded")
if FakeQwen3TTSModel.generated_kwargs["speaker"] != "Aiden":
    raise AssertionError("Qwen3 speaker was not forwarded")
if FakeQwen3TTSModel.generated_kwargs["top_p"] != 0.9:
    raise AssertionError("Qwen3 top_p was not forwarded")
`);

    expect(completed.status, completed.stderr || completed.stdout).toBe(0);
  });

  it.runIf(HAS_SYSTEM_PYTHON)("reports a missing NeuTTS distribution before importing neutts", () => {
    const completed = runBridgeUnitScript(`
import importlib.util

spec = importlib.util.spec_from_file_location("local_tts_bridge", ${JSON.stringify(BRIDGE_PATH)})
bridge = importlib.util.module_from_spec(spec)
assert spec.loader is not None
spec.loader.exec_module(bridge)

bridge.is_neutts_python_compatible = lambda: True
bridge.get_installed_package_version = lambda _package: None
bridge.is_module_available = lambda _module: False

result = bridge.probe_neutts()
if result["ready"]:
    raise AssertionError("NeuTTS probe reported ready without neutts")
if "NeuTTS is not installed" not in result["message"]:
    raise AssertionError(result["message"])
if "Failed to import" in result["message"]:
    raise AssertionError(result["message"])
`);

    expect(completed.status, completed.stderr || completed.stdout).toBe(0);
  });

  it.runIf(HAS_SYSTEM_PYTHON)("reports missing eSpeak before importing neutts", () => {
    const completed = runBridgeUnitScript(`
import importlib.util
import sys
import types

spec = importlib.util.spec_from_file_location("local_tts_bridge", ${JSON.stringify(BRIDGE_PATH)})
bridge = importlib.util.module_from_spec(spec)
assert spec.loader is not None
spec.loader.exec_module(bridge)

bridge.is_neutts_python_compatible = lambda: True
bridge.get_installed_package_version = lambda _package: "1.2.0"
bridge.detect_neutts_compatibility = lambda _version: "current_1_2_x_or_newer"
bridge.is_module_available = lambda _module: True
bridge.detect_espeak = lambda: {"ok": False, "message": "eSpeak missing from test"}

module = types.ModuleType("neutts")
def fail_import(*_args, **_kwargs):
    raise AssertionError("neutts import should not run before eSpeak is available")
module.__getattr__ = fail_import
sys.modules["neutts"] = module

result = bridge.probe_neutts()
if result["ready"]:
    raise AssertionError("NeuTTS probe reported ready without eSpeak")
if "eSpeak missing from test" not in result["message"]:
    raise AssertionError(result["message"])
`);

    expect(completed.status, completed.stderr || completed.stdout).toBe(0);
  });

  it.runIf(HAS_SYSTEM_PYTHON)("reports a missing Kani distribution before importing kani_tts", () => {
    const completed = runBridgeUnitScript(`
import importlib.util

spec = importlib.util.spec_from_file_location("local_tts_bridge", ${JSON.stringify(BRIDGE_PATH)})
bridge = importlib.util.module_from_spec(spec)
assert spec.loader is not None
spec.loader.exec_module(bridge)

bridge.detect_kani_package = lambda: (None, None)
bridge.detect_kani_transformers_version = lambda: None

result = bridge.probe_kani()
if result["ready"]:
    raise AssertionError("Kani probe reported ready without kani-tts-2")
if "Kani-TTS-2 is not installed" not in result["message"]:
    raise AssertionError(result["message"])
if "Failed to import" in result["message"]:
    raise AssertionError(result["message"])
`);

    expect(completed.status, completed.stderr || completed.stdout).toBe(0);
  });

  it.runIf(HAS_SYSTEM_PYTHON)("reports a missing Qwen distribution before importing qwen_tts", () => {
    const completed = runBridgeUnitScript(`
import builtins
import importlib.util

spec = importlib.util.spec_from_file_location("local_tts_bridge", ${JSON.stringify(BRIDGE_PATH)})
bridge = importlib.util.module_from_spec(spec)
assert spec.loader is not None
spec.loader.exec_module(bridge)

bridge.get_installed_package_version = lambda _package: None

real_import = builtins.__import__
def guarded_import(name, *args, **kwargs):
    if name == "torch":
        raise AssertionError("torch import should not run when qwen-tts is missing")
    return real_import(name, *args, **kwargs)

builtins.__import__ = guarded_import
try:
    result = bridge.probe_qwen3()
finally:
    builtins.__import__ = real_import

if result["ready"]:
    raise AssertionError("Qwen3 probe reported ready without qwen-tts")
if "qwen-tts is not installed" not in result["message"]:
    raise AssertionError(result["message"])
if "Failed to import" in result["message"]:
    raise AssertionError(result["message"])
`);

    expect(completed.status, completed.stderr || completed.stdout).toBe(0);
  });

  it.runIf(HAS_SYSTEM_PYTHON)("detects eSpeak through PHONEMIZER_ESPEAK_LIBRARY", () => {
    const completed = runBridgeUnitScript(`
import importlib.util
import os
import tempfile

spec = importlib.util.spec_from_file_location("local_tts_bridge", ${JSON.stringify(BRIDGE_PATH)})
bridge = importlib.util.module_from_spec(spec)
assert spec.loader is not None
spec.loader.exec_module(bridge)

with tempfile.NamedTemporaryFile() as library:
    os.environ["PHONEMIZER_ESPEAK_LIBRARY"] = library.name
    bridge.load_espeak_library = lambda _path: (True, None)
    detected = bridge.detect_espeak()

if not detected["ok"]:
    raise AssertionError(detected)
if detected["source"] != "PHONEMIZER_ESPEAK_LIBRARY":
    raise AssertionError(detected)
if detected["path"] != library.name:
    raise AssertionError(detected)
`);

    expect(completed.status, completed.stderr || completed.stdout).toBe(0);
  });

  it.runIf(HAS_SYSTEM_PYTHON)("reports an invalid PHONEMIZER_ESPEAK_LIBRARY as an actionable eSpeak failure", () => {
    const completed = runBridgeUnitScript(`
import importlib.util
import os

spec = importlib.util.spec_from_file_location("local_tts_bridge", ${JSON.stringify(BRIDGE_PATH)})
bridge = importlib.util.module_from_spec(spec)
assert spec.loader is not None
spec.loader.exec_module(bridge)

os.environ["PHONEMIZER_ESPEAK_LIBRARY"] = "/definitely/missing/libespeak-ng.dylib"
detected = bridge.detect_espeak()

if detected["ok"]:
    raise AssertionError(detected)
if "PHONEMIZER_ESPEAK_LIBRARY" not in detected["message"]:
    raise AssertionError(detected)
if "/definitely/missing/libespeak-ng.dylib" not in detected["message"]:
    raise AssertionError(detected)
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

  it.runIf(RUN_LOCAL_BRIDGE_TESTS)("detects NeuTTS bundled eSpeak backend when PATH is unavailable", () => {
    const completed = runNeuttsBridge("probe", {}, {
      ...process.env,
      PATH: "",
    });

    expect(completed.status).toBe(0);
    const payload = getResultPayload(completed.stdout);
    expect(payload.ok).toBe(true);
    expect(payload.result?.ready).toBe(true);
    expect(String(payload.result?.message)).toMatch(/ready/i);
    expect(String(payload.result?.espeakVersion)).toMatch(/eSpeak NG/i);
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
