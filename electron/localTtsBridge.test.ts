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
const SYSTEM_PYTHON = process.env.PYTHON ?? "python3";
const HAS_SYSTEM_PYTHON = spawnSync(SYSTEM_PYTHON, [
  "-c",
  "import sys; raise SystemExit(0 if sys.version_info >= (3, 10) else 1)",
], { encoding: "utf-8" }).status === 0;
const RUN_LOCAL_BRIDGE_TESTS = process.env.OPEN_TTS_RUN_LOCAL_BRIDGE_TESTS === "1"
  && fs.existsSync(NEUTTS_PYTHON);

function runNeuttsBridge(
  action: "probe",
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

  it.runIf(HAS_SYSTEM_PYTHON)("defaults and validates Kani language tags before generation", () => {
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
    sample_rate = 22050
    status = "available_language_tags"
    language_tags_list = ["en_us", "en_bost"]
    generated_kwargs = None

    def __init__(self, *_args, **_kwargs):
        pass

    def generate(self, *_args, **kwargs):
        FakeKaniTTS.generated_kwargs = kwargs
        return [0.0, 0.1], "Hello from Kani."

module = types.ModuleType("kani_tts")
module.KaniTTS = FakeKaniTTS
sys.modules["kani_tts"] = module

result = bridge.generate_kani({"text": "Hello from Kani."})
if result["sampleRate"] != 22050:
    raise AssertionError(f"Expected Kani sampleRate 22050, got {result['sampleRate']}")
if FakeKaniTTS.generated_kwargs["language_tag"] != "en_us":
    raise AssertionError(FakeKaniTTS.generated_kwargs)

try:
    bridge.generate_kani({"text": "Hello from Kani.", "languageTag": "en_bad"})
except RuntimeError as exc:
    if "Unsupported Kani language tag" not in str(exc):
        raise
else:
    raise AssertionError("Unsupported Kani language tag was accepted")
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
    loaded_repo = None
    loaded_kwargs = None
    generated_kwargs = None

    @classmethod
    def from_pretrained(cls, model_repo, **kwargs):
        cls.loaded_repo = model_repo
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
if result["modelRepo"] != "Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice":
    raise AssertionError(result["modelRepo"])
if FakeQwen3TTSModel.loaded_repo != "Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice":
    raise AssertionError(FakeQwen3TTSModel.loaded_repo)
if FakeQwen3TTSModel.loaded_kwargs["device_map"] != "cuda:0":
    raise AssertionError("Qwen3 device_map was not forwarded")
if FakeQwen3TTSModel.generated_kwargs["speaker"] != "Aiden":
    raise AssertionError("Qwen3 speaker was not forwarded")
if FakeQwen3TTSModel.generated_kwargs["top_p"] != 0.9:
    raise AssertionError("Qwen3 top_p was not forwarded")
`);

    expect(completed.status, completed.stderr || completed.stdout).toBe(0);
  });

  it.runIf(HAS_SYSTEM_PYTHON)("auto-selects Qwen3 0.6B with MPS settings on Apple acceleration", () => {
    const completed = runBridgeUnitScript(`
import importlib.util
import sys
import types

spec = importlib.util.spec_from_file_location("local_tts_bridge", ${JSON.stringify(BRIDGE_PATH)})
bridge = importlib.util.module_from_spec(spec)
assert spec.loader is not None
spec.loader.exec_module(bridge)

bridge.array_to_wav_base64 = lambda _audio, _sample_rate: "UklGRg=="
bridge.is_module_available = lambda module_name: False if module_name == "flash_attn" else True

class FakeCuda:
    @staticmethod
    def is_available():
        return False

class FakeMps:
    @staticmethod
    def is_available():
        return True

torch_module = types.ModuleType("torch")
torch_module.cuda = FakeCuda()
torch_module.backends = types.SimpleNamespace(mps=FakeMps())
torch_module.bfloat16 = "bfloat16"
torch_module.float16 = "float16"
torch_module.float32 = "float32"
torch_module.ones = lambda _shape, device=None, dtype=None: types.SimpleNamespace(dtype=dtype)
sys.modules["torch"] = torch_module

class FakeQwen3TTSModel:
    loaded_repo = None
    loaded_kwargs = None

    @classmethod
    def from_pretrained(cls, model_repo, **kwargs):
        cls.loaded_repo = model_repo
        cls.loaded_kwargs = kwargs
        return cls()

    def generate_custom_voice(self, **_kwargs):
        return [[0.0, 0.1]], 24000

module = types.ModuleType("qwen_tts")
module.Qwen3TTSModel = FakeQwen3TTSModel
sys.modules["qwen_tts"] = module

result = bridge.generate_qwen3({
    "text": "Hello from Qwen.",
    "modelRepo": "auto",
    "deviceMap": "auto",
    "dtype": "auto",
    "attnImplementation": "auto",
})
if result["modelRepo"] != "Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice":
    raise AssertionError(result["modelRepo"])
if FakeQwen3TTSModel.loaded_repo != "Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice":
    raise AssertionError(FakeQwen3TTSModel.loaded_repo)
if FakeQwen3TTSModel.loaded_kwargs["device_map"] != "mps":
    raise AssertionError(FakeQwen3TTSModel.loaded_kwargs)
if FakeQwen3TTSModel.loaded_kwargs["dtype"] != "bfloat16":
    raise AssertionError(FakeQwen3TTSModel.loaded_kwargs)
if FakeQwen3TTSModel.loaded_kwargs["attn_implementation"] != "sdpa":
    raise AssertionError(FakeQwen3TTSModel.loaded_kwargs)
`);

    expect(completed.status, completed.stderr || completed.stdout).toBe(0);
  });

  it.runIf(HAS_SYSTEM_PYTHON)("falls back to float32 when Qwen3 MPS bfloat16 is unavailable", () => {
    const completed = runBridgeUnitScript(`
import importlib.util
import types

spec = importlib.util.spec_from_file_location("local_tts_bridge", ${JSON.stringify(BRIDGE_PATH)})
bridge = importlib.util.module_from_spec(spec)
assert spec.loader is not None
spec.loader.exec_module(bridge)

bridge.is_module_available = lambda module_name: False if module_name == "flash_attn" else True

class FakeCuda:
    @staticmethod
    def is_available():
        return False

class FakeMps:
    @staticmethod
    def is_available():
        return True

def unavailable_ones(*_args, **_kwargs):
    raise RuntimeError("bfloat16 unsupported")

torch_module = types.ModuleType("torch")
torch_module.cuda = FakeCuda()
torch_module.backends = types.SimpleNamespace(mps=FakeMps())
torch_module.bfloat16 = "bfloat16"
torch_module.float16 = "float16"
torch_module.float32 = "float32"
torch_module.ones = unavailable_ones

profile = bridge.select_qwen3_runtime_profile(torch_module)
if profile["deviceMap"] != "mps":
    raise AssertionError(profile)
if profile["dtype"] != "float32":
    raise AssertionError(profile)
if profile["attention"] != "sdpa":
    raise AssertionError(profile)
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

  it.runIf(HAS_SYSTEM_PYTHON)("recommends the fastest Qwen3 profile on CUDA", () => {
    const completed = runBridgeUnitScript(`
import importlib.util
import sys
import types

spec = importlib.util.spec_from_file_location("local_tts_bridge", ${JSON.stringify(BRIDGE_PATH)})
bridge = importlib.util.module_from_spec(spec)
assert spec.loader is not None
spec.loader.exec_module(bridge)

bridge.get_installed_package_version = lambda package: "1.0.0" if package == "qwen-tts" else "2.12.0"

class FakeCuda:
    @staticmethod
    def is_available():
        return True

class FakeMps:
    @staticmethod
    def is_available():
        return False

torch_module = types.ModuleType("torch")
torch_module.__version__ = "2.12.0"
torch_module.cuda = FakeCuda()
torch_module.backends = types.SimpleNamespace(mps=FakeMps())
torch_module.bfloat16 = "bfloat16"
torch_module.float16 = "float16"
torch_module.float32 = "float32"
sys.modules["torch"] = torch_module
sys.modules["qwen_tts"] = types.ModuleType("qwen_tts")

result = bridge.probe_qwen3()
if not result["ready"]:
    raise AssertionError(result["message"])
if result["recommendedModelRepo"] != "Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice":
    raise AssertionError(result["recommendedModelRepo"])
if result["recommendedDeviceMap"] != "cuda:0":
    raise AssertionError(result["recommendedDeviceMap"])
if result["recommendedDtype"] != "bfloat16":
    raise AssertionError(result["recommendedDtype"])
if result["recommendedAttention"] != "sdpa":
    raise AssertionError(result["recommendedAttention"])
if "CUDA was detected. Auto mode will use the faster 0.6B CustomVoice model with CUDA acceleration." not in result["warnings"]:
    raise AssertionError(result["warnings"])
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

  it.runIf(HAS_SYSTEM_PYTHON)("prefers the eSpeak library bundled with installed NeuTTS", () => {
    const completed = runBridgeUnitScript(`
import importlib.util
import os
from pathlib import Path
import sys
import tempfile

spec = importlib.util.spec_from_file_location("local_tts_bridge", ${JSON.stringify(BRIDGE_PATH)})
bridge = importlib.util.module_from_spec(spec)
assert spec.loader is not None
spec.loader.exec_module(bridge)

with tempfile.TemporaryDirectory() as temp_dir:
    package_dir = Path(temp_dir) / "neutts"
    package_dir.mkdir()
    if sys.platform == "win32":
        library = package_dir / "espeak-ng.dll"
    elif sys.platform == "darwin":
        library = package_dir / "libespeak-ng.dylib"
    else:
        library = package_dir / "libespeak-ng.so"
    library.write_bytes(b"placeholder")
    data_path = package_dir / "espeak-ng-data"
    data_path.mkdir()

    attempted = []
    bridge.get_neutts_package_dir = lambda: package_dir
    bridge.load_espeak_library = lambda path: attempted.append(path) or (True, None)
    bridge.check_espeak_backend = lambda: (_ for _ in ()).throw(
        AssertionError("system eSpeak lookup should not run before bundled lookup")
    )

    if bridge.get_espeak_data_path_for_library(str(library)) != data_path.resolve():
        raise AssertionError("Bundled eSpeak data path was not detected")

    ok, version, source = bridge.check_espeak()

    if not ok:
        raise AssertionError("Bundled eSpeak was not accepted")
    if source != "bundled-library":
        raise AssertionError(source)
    if str(library) not in attempted:
        raise AssertionError(attempted)
    if os.environ.get("PHONEMIZER_ESPEAK_LIBRARY") != str(library):
        raise AssertionError("Bundled eSpeak library was not exported to phonemizer")
    if "Bundled eSpeak NG library" not in version:
        raise AssertionError(version)
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

  it.runIf(RUN_LOCAL_BRIDGE_TESTS)("emits progress before returning invalid reference audio errors over serve-ws", () => {
    // Generation is WebSocket-only; --action generate no longer exists. Drive a
    // real serve-ws worker and assert the same progress + ok:false behavior the
    // legacy one-shot generate path used to surface for invalid reference audio.
    const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "open-tts-bridge-"));
    try {
      const completed = runBridgeUnitScript(`
import json
import socket
import subprocess
import threading
import time

def send_text(sock, payload):
    data = json.dumps(payload).encode("utf-8")
    if len(data) < 126:
        header = bytes([0x81, len(data)])
    elif len(data) <= 0xFFFF:
        header = bytes([0x81, 126]) + len(data).to_bytes(2, "big")
    else:
        header = bytes([0x81, 127]) + len(data).to_bytes(8, "big")
    sock.sendall(header + data)

def recv_exact(sock, size):
    chunks = []
    remaining = size
    while remaining:
        chunk = sock.recv(remaining)
        if not chunk:
            raise AssertionError("socket closed while reading frame")
        chunks.append(chunk)
        remaining -= len(chunk)
    return b"".join(chunks)

def recv_frame(sock):
    first = recv_exact(sock, 1)[0]
    second = recv_exact(sock, 1)[0]
    length = second & 0x7F
    if length == 126:
        length = int.from_bytes(recv_exact(sock, 2), "big")
    elif length == 127:
        length = int.from_bytes(recv_exact(sock, 8), "big")
    payload = recv_exact(sock, length)
    return first & 0x0F, payload

def recv_json(sock):
    opcode, payload = recv_frame(sock)
    assert opcode == 1, opcode
    return json.loads(payload.decode("utf-8"))

probe = socket.socket()
probe.bind(("127.0.0.1", 0))
port = probe.getsockname()[1]
probe.close()

worker = subprocess.Popen([
    ${JSON.stringify(NEUTTS_PYTHON)},
    ${JSON.stringify(BRIDGE_PATH)},
    "--action", "serve-ws",
    "--model", "neutts",
    "--cache-dir", ${JSON.stringify(cacheDir)},
    "--host", "127.0.0.1",
    "--port", str(port),
])
try:
    deadline = time.time() + 5
    while True:
        client = socket.socket()
        try:
            client.connect(("127.0.0.1", port))
            break
        except OSError:
            client.close()
            if time.time() > deadline:
                raise
            time.sleep(0.02)

    client.sendall(
        b"GET / HTTP/1.1\\r\\n"
        b"Host: 127.0.0.1\\r\\n"
        b"Upgrade: websocket\\r\\n"
        b"Connection: Upgrade\\r\\n"
        b"Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\\r\\n"
        b"Sec-WebSocket-Version: 13\\r\\n\\r\\n"
    )
    handshake = b""
    while b"\\r\\n\\r\\n" not in handshake:
        handshake += client.recv(4096)
    assert b"101 Switching Protocols" in handshake, handshake

    send_text(client, {"requestId": "ws-bad", "payload": {
        "text": "Generate this sample locally.",
        "referenceText": "Reference transcript",
        "referenceAudioBase64": "%%%not-base64%%%",
    }})

    saw_runtime_check = False
    while True:
        message = recv_json(client)
        if message["type"] == "progress":
            if message.get("phase") == "runtime_check":
                saw_runtime_check = True
            continue
        if message["type"] == "result":
            assert message["ok"] is False, message
            assert "Reference audio is not valid base64-encoded WAV data." in message["error"], message
            break
        raise AssertionError(message)
    assert saw_runtime_check, "expected a runtime_check progress frame"

    send_text(client, {"command": "shutdown"})
    client.close()
    worker.wait(timeout=5)
finally:
    if worker.poll() is None:
        worker.kill()
        worker.wait(timeout=5)
`);

      expect(completed.status, completed.stderr || completed.stdout).toBe(0);
    } finally {
      fs.rmSync(cacheDir, { recursive: true, force: true });
    }
  });

  it.runIf(HAS_SYSTEM_PYTHON)("serve_websocket sends Qwen3 progress and results without stdout result fallback", () => {
    const completed = runBridgeUnitScript(`
import importlib.util
import io
import json
import socket
import tempfile
import threading
import time

spec = importlib.util.spec_from_file_location("local_tts_bridge", ${JSON.stringify(BRIDGE_PATH)})
bridge = importlib.util.module_from_spec(spec)
assert spec.loader is not None
spec.loader.exec_module(bridge)

def send_text(sock, payload):
    data = json.dumps(payload).encode("utf-8")
    if len(data) < 126:
        header = bytes([0x81, len(data)])
    elif len(data) <= 0xFFFF:
        header = bytes([0x81, 126]) + len(data).to_bytes(2, "big")
    else:
        header = bytes([0x81, 127]) + len(data).to_bytes(8, "big")
    sock.sendall(header + data)

def recv_exact(sock, size):
    chunks = []
    remaining = size
    while remaining:
        chunk = sock.recv(remaining)
        if not chunk:
            raise AssertionError("socket closed while reading frame")
        chunks.append(chunk)
        remaining -= len(chunk)
    return b"".join(chunks)

def recv_frame(sock):
    first = recv_exact(sock, 1)[0]
    second = recv_exact(sock, 1)[0]
    length = second & 0x7F
    if length == 126:
        length = int.from_bytes(recv_exact(sock, 2), "big")
    elif length == 127:
        length = int.from_bytes(recv_exact(sock, 8), "big")
    payload = recv_exact(sock, length)
    return first & 0x0F, payload

def recv_json(sock):
    opcode, payload = recv_frame(sock)
    assert opcode == 1, opcode
    return json.loads(payload.decode("utf-8"))

def fake_generate_ws(payload, *, host=None, audio_chunk_sink=None, encode_wav=True):
    assert host is not None, "WebSocket serve must pass a resident host for qwen3"
    assert encode_wav is False, "WebSocket Qwen3 should not base64-encode a final WAV"
    bridge.emit_progress("inference", "working", started_at=None)
    assert audio_chunk_sink is not None, "WebSocket Qwen3 should stream binary audio chunks"
    audio_chunk_sink({
        "index": 0,
        "total": 1,
        "sampleRate": 24000,
        "sampleCount": 2,
        "silenceAfterSamples": 0,
    }, b"\\x00\\x00\\x00\\x00\\x00\\x00\\x80?")
    return {
        "audioTransport": "websocket-binary",
        "audioChunkCount": 1,
        "sampleRate": 24000,
        "modelRepo": "x",
        "durationSec": 1.0,
        "elapsedSec": 0.5,
        "phaseTimingsSec": {"modelLoadSec": 0.0, "inferenceSec": 0.48, "outputEncodingSec": 0.02},
    }

bridge.generate_qwen3 = fake_generate_ws
captured = io.StringIO()
bridge._REAL_STDOUT = captured

probe = socket.socket()
probe.bind(("127.0.0.1", 0))
port = probe.getsockname()[1]
probe.close()

thread = threading.Thread(
    target=lambda: bridge.serve_websocket("qwen3", tempfile.mkdtemp(), "127.0.0.1", port),
    daemon=True,
)
thread.start()

deadline = time.time() + 2
while True:
    client = socket.socket()
    try:
        client.connect(("127.0.0.1", port))
        break
    except OSError:
        client.close()
        if time.time() > deadline:
            raise
        time.sleep(0.02)

client.sendall(
    b"GET / HTTP/1.1\\r\\n"
    b"Host: 127.0.0.1\\r\\n"
    b"Upgrade: websocket\\r\\n"
    b"Connection: Upgrade\\r\\n"
    b"Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\\r\\n"
    b"Sec-WebSocket-Version: 13\\r\\n\\r\\n"
)
handshake = b""
while b"\\r\\n\\r\\n" not in handshake:
    handshake += client.recv(4096)
assert b"101 Switching Protocols" in handshake, handshake

send_text(client, {"requestId": "ws-a", "payload": {"text": "hi"}})
progress = recv_json(client)
chunk_meta = recv_json(client)
opcode, audio_payload = recv_frame(client)
result = recv_json(client)
assert progress["type"] == "progress" and progress["requestId"] == "ws-a", progress
assert chunk_meta["type"] == "audio_chunk" and chunk_meta["requestId"] == "ws-a", chunk_meta
assert opcode == 2 and audio_payload == b"\\x00\\x00\\x00\\x00\\x00\\x00\\x80?", (opcode, audio_payload)
assert result["type"] == "result" and result["ok"] is True and result["requestId"] == "ws-a", result
assert "wavBase64" not in result["result"], result
assert result["result"]["audioTransport"] == "websocket-binary", result
assert bridge.RESULT_PREFIX not in captured.getvalue(), captured.getvalue()

send_text(client, {"command": "shutdown"})
client.close()
thread.join(timeout=2)
assert not thread.is_alive(), "WebSocket bridge did not shut down"
`);

    expect(completed.status, completed.stderr || completed.stdout).toBe(0);
  });

  it.runIf(HAS_SYSTEM_PYTHON).each([
    {
      label: "NeuTTS",
      model: "neutts",
      generateFn: "generate_neutts",
      sampleRate: 24000,
    },
    {
      label: "Kani",
      model: "kani",
      generateFn: "generate_kani",
      sampleRate: 22050,
    },
  ])(
    "serve_websocket streams a single $label binary chunk without stdout result fallback",
    ({ model, generateFn, sampleRate }) => {
      const completed = runBridgeUnitScript(`
import importlib.util
import io
import json
import socket
import tempfile
import threading
import time

spec = importlib.util.spec_from_file_location("local_tts_bridge", ${JSON.stringify(BRIDGE_PATH)})
bridge = importlib.util.module_from_spec(spec)
assert spec.loader is not None
spec.loader.exec_module(bridge)

def send_text(sock, payload):
    data = json.dumps(payload).encode("utf-8")
    if len(data) < 126:
        header = bytes([0x81, len(data)])
    elif len(data) <= 0xFFFF:
        header = bytes([0x81, 126]) + len(data).to_bytes(2, "big")
    else:
        header = bytes([0x81, 127]) + len(data).to_bytes(8, "big")
    sock.sendall(header + data)

def recv_exact(sock, size):
    chunks = []
    remaining = size
    while remaining:
        chunk = sock.recv(remaining)
        if not chunk:
            raise AssertionError("socket closed while reading frame")
        chunks.append(chunk)
        remaining -= len(chunk)
    return b"".join(chunks)

def recv_frame(sock):
    first = recv_exact(sock, 1)[0]
    second = recv_exact(sock, 1)[0]
    length = second & 0x7F
    if length == 126:
        length = int.from_bytes(recv_exact(sock, 2), "big")
    elif length == 127:
        length = int.from_bytes(recv_exact(sock, 8), "big")
    payload = recv_exact(sock, length)
    return first & 0x0F, payload

def recv_json(sock):
    opcode, payload = recv_frame(sock)
    assert opcode == 1, opcode
    return json.loads(payload.decode("utf-8"))

def fake_generate_ws(payload, *, host=None, audio_chunk_sink=None, encode_wav=True):
    assert host is not None, "WebSocket serve must pass a resident host"
    assert encode_wav is False, "WebSocket generation should not base64-encode a final WAV"
    assert audio_chunk_sink is not None, "WebSocket generation should stream binary audio chunks"
    bridge.emit_progress("inference", "working", started_at=None)
    audio_chunk_sink({
        "index": 0,
        "total": 1,
        "sampleRate": ${sampleRate},
        "sampleCount": 2,
        "silenceAfterSamples": 0,
    }, b"\\x00\\x00\\x00\\x00\\x00\\x00\\x80?")
    return {
        "audioTransport": "websocket-binary",
        "audioChunkCount": 1,
        "sampleRate": ${sampleRate},
        "modelRepo": "x",
        "durationSec": 1.0,
        "elapsedSec": 0.5,
        "phaseTimingsSec": {"modelLoadSec": 0.0, "inferenceSec": 0.48, "outputEncodingSec": 0.02},
    }

bridge.${generateFn} = fake_generate_ws
captured = io.StringIO()
bridge._REAL_STDOUT = captured

probe = socket.socket()
probe.bind(("127.0.0.1", 0))
port = probe.getsockname()[1]
probe.close()

thread = threading.Thread(
    target=lambda: bridge.serve_websocket(${JSON.stringify(model)}, tempfile.mkdtemp(), "127.0.0.1", port),
    daemon=True,
)
thread.start()

deadline = time.time() + 2
while True:
    client = socket.socket()
    try:
        client.connect(("127.0.0.1", port))
        break
    except OSError:
        client.close()
        if time.time() > deadline:
            raise
        time.sleep(0.02)

client.sendall(
    b"GET / HTTP/1.1\\r\\n"
    b"Host: 127.0.0.1\\r\\n"
    b"Upgrade: websocket\\r\\n"
    b"Connection: Upgrade\\r\\n"
    b"Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\\r\\n"
    b"Sec-WebSocket-Version: 13\\r\\n\\r\\n"
)
handshake = b""
while b"\\r\\n\\r\\n" not in handshake:
    handshake += client.recv(4096)
assert b"101 Switching Protocols" in handshake, handshake

send_text(client, {"requestId": "ws-a", "payload": {"text": "hi"}})
progress = recv_json(client)
chunk_meta = recv_json(client)
opcode, audio_payload = recv_frame(client)
result = recv_json(client)
assert progress["type"] == "progress" and progress["requestId"] == "ws-a", progress
assert chunk_meta["type"] == "audio_chunk" and chunk_meta["requestId"] == "ws-a", chunk_meta
assert chunk_meta["index"] == 0 and chunk_meta["total"] == 1, chunk_meta
assert chunk_meta["silenceAfterSamples"] == 0, chunk_meta
assert opcode == 2 and audio_payload == b"\\x00\\x00\\x00\\x00\\x00\\x00\\x80?", (opcode, audio_payload)
assert result["type"] == "result" and result["ok"] is True and result["requestId"] == "ws-a", result
assert "wavBase64" not in result["result"], result
assert result["result"]["audioTransport"] == "websocket-binary", result
assert result["result"]["audioChunkCount"] == 1, result
assert bridge.RESULT_PREFIX not in captured.getvalue(), captured.getvalue()

# A failing request must report ok:false but keep the worker alive.
def fake_generate_fail(payload, *, host=None, audio_chunk_sink=None, encode_wav=True):
    raise RuntimeError("boom")
bridge.${generateFn} = fake_generate_fail
send_text(client, {"requestId": "ws-bad", "payload": {"text": "hi"}})
failure = recv_json(client)
assert failure["type"] == "result" and failure["ok"] is False, failure
assert "boom" in failure["error"], failure
assert thread.is_alive(), "worker must survive a failing request"

send_text(client, {"command": "shutdown"})
client.close()
thread.join(timeout=2)
assert not thread.is_alive(), "WebSocket bridge did not shut down"
`);

      expect(completed.status, completed.stderr || completed.stdout).toBe(0);
    },
  );

  it.runIf(HAS_SYSTEM_PYTHON)("NeuttsModelHost loads once per profile and re-encodes the reference each request", () => {
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

constructions = {"n": 0}
class FakeNeuTTS:
    sample_rate = 24000

    def __init__(self, **_kwargs):
        constructions["n"] += 1
        self.encode_calls = 0

    def encode_reference(self, _path):
        self.encode_calls += 1
        return "reference-codes"

    def infer(self, _text, _ref_codes, _ref_text):
        return [0.0, 0.1]

module = types.ModuleType("neutts")
module.NeuTTS = FakeNeuTTS
sys.modules["neutts"] = module

releases = {"n": 0}
bridge.release_accelerator_memory = lambda *, started_at=None: releases.__setitem__("n", releases["n"] + 1)

host = bridge.NeuttsModelHost()
key = ("neuphonic/neutts-nano", "neuphonic/neucodec", "cpu", "cpu")
first = host.acquire(*key, started_at=0.0)
second = host.acquire(*key, started_at=0.0)
assert constructions["n"] == 1, constructions
assert releases["n"] == 0, releases
assert first is second, "same profile must reuse the resident NeuTTS instance"

third = host.acquire("neuphonic/neutts-nano", "neuphonic/neucodec", "mps", "cpu", started_at=0.0)
assert constructions["n"] == 2, constructions
assert releases["n"] == 1, releases
assert third is not second

# A full generate_neutts call must re-encode the reference each request (no
# per-request reference state cached on the host).
payload = {
    "text": "Hello from NeuTTS.",
    "referenceText": "Reference transcript.",
    "referenceAudioBase64": "UklGRg==",
}
host2 = bridge.NeuttsModelHost()
bridge.generate_neutts(payload, host=host2)
bridge.generate_neutts(payload, host=host2)
resident = host2._model
assert constructions["n"] == 3, "second host loads exactly one NeuTTS instance"
assert resident.encode_calls == 2, "reference must be re-encoded every request"
`);

    expect(completed.status, completed.stderr || completed.stdout).toBe(0);
  });

  it.runIf(HAS_SYSTEM_PYTHON)("KaniModelHost reloads when max_new_tokens changes but reuses across .generate() args", () => {
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

constructions = {"n": 0, "max_new_tokens": []}
class FakeKaniTTS:
    sample_rate = 22050
    status = "no_language_tags"

    def __init__(self, *_args, max_new_tokens=None, **_kwargs):
        constructions["n"] += 1
        constructions["max_new_tokens"].append(max_new_tokens)

    def generate(self, *_args, **_kwargs):
        return [0.0, 0.1], 22050

module = types.ModuleType("kani_tts")
module.KaniTTS = FakeKaniTTS
sys.modules["kani_tts"] = module

releases = {"n": 0}
bridge.release_accelerator_memory = lambda *, started_at=None: releases.__setitem__("n", releases["n"] + 1)

host = bridge.KaniModelHost()
first = host.acquire("nineninesix/kani-tts-2-en", "cpu", 1024, started_at=0.0)
second = host.acquire("nineninesix/kani-tts-2-en", "cpu", 1024, started_at=0.0)
assert constructions["n"] == 1, constructions
assert releases["n"] == 0, releases
assert first is second, "same key must reuse the resident KaniTTS instance"

third = host.acquire("nineninesix/kani-tts-2-en", "cpu", 4000, started_at=0.0)
assert constructions["n"] == 2, constructions
assert releases["n"] == 1, releases
assert third is not second

# Per-request .generate() args (temperature/top_p/...) must not force a reload.
host2 = bridge.KaniModelHost()
base = {"text": "Hello from Kani.", "deviceMap": "cpu"}
bridge.generate_kani({**base, "temperature": 0.7})
bridge.generate_kani({**base, "temperature": 1.3, "topP": 0.8})
# generate_kani builds its own resident host only when passed one; pass host2.
bridge.generate_kani({**base, "temperature": 0.7}, host=host2)
bridge.generate_kani({**base, "temperature": 1.3, "topP": 0.8}, host=host2)
# host2 saw two requests with identical constructor key -> exactly one load.
assert host2._key == ("nineninesix/kani-tts-2-en", "cpu", 1024), host2._key
`);

    expect(completed.status, completed.stderr || completed.stdout).toBe(0);
  });

  it.runIf(HAS_SYSTEM_PYTHON)("Qwen3ModelHost loads once per profile and reloads when it changes", () => {
    const completed = runBridgeUnitScript(`
import importlib.util
import sys

spec = importlib.util.spec_from_file_location("local_tts_bridge", ${JSON.stringify(BRIDGE_PATH)})
bridge = importlib.util.module_from_spec(spec)
assert spec.loader is not None
spec.loader.exec_module(bridge)

calls = {"n": 0}
def fake_load(profile, *, started_at):
    calls["n"] += 1
    return ("MODEL", calls["n"])
bridge.load_qwen3_model = fake_load
releases = {"n": 0}
bridge.release_accelerator_memory = lambda *, started_at=None: releases.__setitem__("n", releases["n"] + 1)

host = bridge.Qwen3ModelHost()
profile = {"modelRepo": "R", "deviceMap": "cpu", "dtype": "float32", "attention": "eager"}
first = host.acquire(dict(profile), started_at=0.0)
second = host.acquire(dict(profile), started_at=0.0)
assert calls["n"] == 1, calls
assert releases["n"] == 0, releases
assert first is second, "same profile must reuse the resident model"

third = host.acquire({**profile, "dtype": "bfloat16"}, started_at=0.0)
assert calls["n"] == 2, calls
assert releases["n"] == 1, releases
assert third is not second
`);

    expect(completed.status, completed.stderr || completed.stdout).toBe(0);
  });

  it.runIf(HAS_SYSTEM_PYTHON)("generate_qwen3 reuses a host-provided model across calls", () => {
    const completed = runBridgeUnitScript(`
import importlib.util
import sys
import types

spec = importlib.util.spec_from_file_location("local_tts_bridge", ${JSON.stringify(BRIDGE_PATH)})
bridge = importlib.util.module_from_spec(spec)
assert spec.loader is not None
spec.loader.exec_module(bridge)

sys.modules["torch"] = types.ModuleType("torch")
bridge.select_qwen3_runtime_profile = lambda *a, **k: {
    "modelRepo": "R", "deviceMap": "cpu", "dtype": "float32", "attention": "eager",
}
bridge.array_to_wav_base64 = lambda _audio, _sr: "AAA"

calls = {"n": 0}
class FakeModel:
    def generate_custom_voice(self, **_kwargs):
        return ([[0.0, 0.1, 0.2]], 24000)
    def get_supported_speakers(self):
        return ["ryan"]
def fake_load(profile, *, started_at):
    calls["n"] += 1
    return FakeModel()
bridge.load_qwen3_model = fake_load

host = bridge.Qwen3ModelHost()
first = bridge.generate_qwen3({"text": "hi", "speaker": "Ryan", "language": "English"}, host=host)
second = bridge.generate_qwen3({"text": "again", "speaker": "Ryan", "language": "English"}, host=host)
assert calls["n"] == 1, calls
assert first["sampleRate"] == 24000 and second["sampleRate"] == 24000
`);

    expect(completed.status, completed.stderr || completed.stdout).toBe(0);
  });

  it.runIf(HAS_SYSTEM_PYTHON)("splits long Qwen3 text into bounded inference chunks", () => {
    const completed = runBridgeUnitScript(`
import importlib.util

spec = importlib.util.spec_from_file_location("local_tts_bridge", ${JSON.stringify(BRIDGE_PATH)})
bridge = importlib.util.module_from_spec(spec)
assert spec.loader is not None
spec.loader.exec_module(bridge)

text = "First sentence. " + ("This clause is intentionally long, " * 20) + "final words."
chunks = bridge.split_qwen3_text(text, max_chars=120)
assert len(chunks) > 1, chunks
assert all(len(chunk) <= 120 for chunk in chunks), chunks
assert chunks[0] == "First sentence.", chunks
`);

    expect(completed.status, completed.stderr || completed.stdout).toBe(0);
  });

  it.runIf(HAS_SYSTEM_PYTHON)("prefers an offline load when the model snapshot is already cached", () => {
    const completed = runBridgeUnitScript(`
import importlib.util
import os
import sys
import types

spec = importlib.util.spec_from_file_location("local_tts_bridge", ${JSON.stringify(BRIDGE_PATH)})
bridge = importlib.util.module_from_spec(spec)
assert spec.loader is not None
spec.loader.exec_module(bridge)

sys.modules["torch"] = types.ModuleType("torch")
bridge.parse_qwen3_dtype = lambda name: name
bridge.qwen3_snapshot_present = lambda _repo: True

seen = {}
class FakeModel:
    @staticmethod
    def from_pretrained(repo, **kwargs):
        seen["offline"] = os.environ.get("HF_HUB_OFFLINE")
        seen["repo"] = repo
        return "MODEL"
qwen_module = types.ModuleType("qwen_tts")
qwen_module.Qwen3TTSModel = FakeModel
sys.modules["qwen_tts"] = qwen_module

os.environ.pop("HF_HUB_OFFLINE", None)
profile = {"modelRepo": "R", "deviceMap": "cpu", "dtype": "float32", "attention": "eager"}
model = bridge.load_qwen3_model(profile, started_at=0.0)
assert model == "MODEL"
assert seen["offline"] == "1", seen
assert os.environ.get("HF_HUB_OFFLINE") is None, "offline env must be restored after loading"

# Verify the context manager round-trips a pre-existing value too.
os.environ["HF_HUB_OFFLINE"] = "0"
with bridge.huggingface_offline(True):
    assert os.environ["HF_HUB_OFFLINE"] == "1"
assert os.environ["HF_HUB_OFFLINE"] == "0"
`);

    expect(completed.status, completed.stderr || completed.stdout).toBe(0);
  });

  it.runIf(HAS_SYSTEM_PYTHON)("leaves Qwen3 eager by default and compiles only when explicitly enabled", () => {
    const completed = runBridgeUnitScript(`
import importlib.util
import os
import sys
import types

spec = importlib.util.spec_from_file_location("local_tts_bridge", ${JSON.stringify(BRIDGE_PATH)})
bridge = importlib.util.module_from_spec(spec)
assert spec.loader is not None
spec.loader.exec_module(bridge)

calls = []
torch = types.ModuleType("torch")
def fake_compile(model, *, mode):
    calls.append((model, mode))
    return ("compiled", model, mode)
torch.compile = fake_compile
sys.modules["torch"] = torch

class FakeQwen:
    def __init__(self):
        self.model = "inner"

os.environ.pop("OPEN_TTS_ENABLE_QWEN3_TORCH_COMPILE", None)
model = bridge.maybe_compile_qwen3_model(FakeQwen(), started_at=0.0)
assert calls == [], calls
assert model.model == "inner", model.model

os.environ["OPEN_TTS_ENABLE_QWEN3_TORCH_COMPILE"] = "1"
model = bridge.maybe_compile_qwen3_model(FakeQwen(), started_at=0.0)
assert calls == [("inner", "reduce-overhead")], calls
assert model.model == ("compiled", "inner", "reduce-overhead"), model.model
`);

    expect(completed.status, completed.stderr || completed.stdout).toBe(0);
  });
});
