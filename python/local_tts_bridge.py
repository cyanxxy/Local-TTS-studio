#!/usr/bin/env python3
"""Local TTS bridge for Electron IPC.

This script runs a single action per process and returns structured stdout lines
prefixed with __PROGRESS__ and __RESULT__ so the parent process can separate
bridge progress from library noise.
"""

from __future__ import annotations

import argparse
import base64
import binascii
import ctypes
import ctypes.util
import gc
import hashlib
import io
import json
import os
import socket
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import traceback
import wave
from contextlib import contextmanager
from glob import glob
from pathlib import Path
from typing import Any, Callable

if sys.platform == "darwin":
    os.environ.setdefault("PYTORCH_ENABLE_MPS_FALLBACK", "1")

RESULT_PREFIX = "__RESULT__"
PROGRESS_PREFIX = "__PROGRESS__"
# The original stdout, captured before any redirect_stdout_to_stderr() swap. The
# heartbeat thread runs concurrently with library calls that redirect sys.stdout
# to stderr, so emit()/emit_progress() must always target this real stream to
# keep __RESULT__/__PROGRESS__ lines on stdout where the parent process reads them.
_REAL_STDOUT = sys.stdout
# Set per request while a persistent `serve` worker handles it, so every
# __RESULT__/__PROGRESS__ line carries the originating requestId. It stays None
# for the one-shot probe/generate actions, where the parent owns one process per
# request and needs no correlation id.
_CURRENT_REQUEST_ID: str | None = None
_PROGRESS_SINK: Callable[[dict[str, Any]], None] | None = None
HEARTBEAT_INTERVAL_SEC = 10.0
NEUTTS_MIN_PYTHON = (3, 10)
NEUTTS_MAX_EXCLUSIVE_PYTHON = (3, 14)
KANI_MIN_TRANSFORMERS = (4, 56, 0)
KANI_MAX_TRANSFORMERS_EXCLUSIVE = (5, 0, 0)
KANI_DEFAULT_LANGUAGE_TAG = "en_us"
KANI_DEFAULT_MAX_NEW_TOKENS = 1024
KANI_LANGUAGE_TAGS = [
    "en_us",
    "en_nyork",
    "en_oakl",
    "en_glasg",
    "en_bost",
    "en_scou",
]
QWEN3_FAST_CUSTOM_VOICE_REPO = "Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice"
QWEN3_QUALITY_CUSTOM_VOICE_REPO = "Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice"
QWEN3_CUSTOM_VOICE_REPO = QWEN3_FAST_CUSTOM_VOICE_REPO
QWEN3_DEFAULT_SPEAKER = "Ryan"
QWEN3_DEFAULT_LANGUAGE = "Auto"
QWEN3_SPEAKERS = [
    "Vivian",
    "Serena",
    "Uncle_Fu",
    "Dylan",
    "Eric",
    "Ryan",
    "Aiden",
    "Ono_Anna",
    "Sohee",
]
QWEN3_LANGUAGES = [
    "Auto",
    "Chinese",
    "English",
    "Japanese",
    "Korean",
    "German",
    "French",
    "Russian",
    "Portuguese",
    "Spanish",
    "Italian",
]
QWEN3_MAX_CHUNK_CHARS = 320
QWEN3_INTER_CHUNK_SILENCE_SEC = 0.2
PHONEMIZER_ESPEAK_LIBRARY_ENV = "PHONEMIZER_ESPEAK_LIBRARY"
PHONEMIZER_ESPEAK_LEGACY_PATH_ENV = "PHONEMIZER_ESPEAK_PATH"
ESPEAK_DATA_PATH_ENV = "ESPEAK_DATA_PATH"
WEBSOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"


@contextmanager
def redirect_stdout_to_stderr() -> Any:
    original = sys.stdout
    try:
        sys.stdout = sys.stderr
        yield
    finally:
        sys.stdout = original


def emit(payload: dict[str, Any]) -> None:
    if _CURRENT_REQUEST_ID is not None and "requestId" not in payload:
        payload = {**payload, "requestId": _CURRENT_REQUEST_ID}
    print(f"{RESULT_PREFIX}{json.dumps(payload, ensure_ascii=False)}", flush=True, file=_REAL_STDOUT)


def emit_progress(phase: str, message: str, *, started_at: float | None = None) -> None:
    payload: dict[str, Any] = {
        "phase": phase,
        "message": message,
    }
    if started_at is not None:
        payload["elapsedSec"] = round(max(0.0, time.time() - started_at), 3)
    if _CURRENT_REQUEST_ID is not None:
        payload["requestId"] = _CURRENT_REQUEST_ID
    if _PROGRESS_SINK is not None:
        _PROGRESS_SINK(payload)
        return
    print(f"{PROGRESS_PREFIX}{json.dumps(payload, ensure_ascii=False)}", flush=True, file=_REAL_STDOUT)


@contextmanager
def heartbeat(phase: str, message: str, *, started_at: float, interval: float = HEARTBEAT_INTERVAL_SEC) -> Any:
    """Emit periodic progress while a long, blocking call runs.

    First-run model downloads and inference can each take minutes with no output
    of their own. Without a steady signal the parent process cannot tell "slow but
    working" from "hung", so it would either kill healthy runs or wait forever.
    This keeps a heartbeat flowing on stdout so the parent's idle watchdog only
    fires when the process truly stops making progress.
    """
    stop = threading.Event()

    def beat() -> None:
        while not stop.wait(interval):
            emit_progress(phase, message, started_at=started_at)

    thread = threading.Thread(target=beat, daemon=True)
    thread.start()
    try:
        yield
    finally:
        stop.set()
        thread.join(timeout=2.0)


def fail(message: str, *, details: str | None = None) -> None:
    emit({"ok": False, "error": message, "details": details})


def record_timing(timings: dict[str, float], key: str, started_at: float) -> None:
    timings[key] = round(max(0.0, time.time() - started_at), 3)


def parse_stdin_payload() -> dict[str, Any]:
    raw = sys.stdin.read().strip()
    if not raw:
        return {}
    loaded = json.loads(raw)
    if not isinstance(loaded, dict):
        raise ValueError("Expected a JSON object payload on stdin.")
    return loaded


def configure_cache_dir(cache_dir: str) -> None:
    base = Path(cache_dir)
    hub_dir = base / "hub"
    transformers_dir = base / "transformers"

    base.mkdir(parents=True, exist_ok=True)
    hub_dir.mkdir(parents=True, exist_ok=True)
    transformers_dir.mkdir(parents=True, exist_ok=True)

    os.environ["HF_HOME"] = str(base)
    os.environ["HF_HUB_CACHE"] = str(hub_dir)
    os.environ["HUGGINGFACE_HUB_CACHE"] = str(hub_dir)
    if os.environ.get("OPEN_TTS_LEGACY_TRANSFORMERS_CACHE") == "1":
        os.environ["TRANSFORMERS_CACHE"] = str(transformers_dir)


def get_espeak_install_hint() -> str:
    bundled_hint = (
        "Current NeuTTS wheels normally bundle eSpeak NG. Reinstall `neutts` in this "
        "Python environment first; if you are using a custom/source install, install "
        "eSpeak NG and set `PHONEMIZER_ESPEAK_LIBRARY` plus `ESPEAK_DATA_PATH` if needed."
    )
    if sys.platform == "darwin":
        return (
            f"{bundled_hint} On macOS, a system fallback can be installed with "
            "`brew install espeak-ng`."
        )
    if sys.platform == "win32":
        return (
            f"{bundled_hint} On Windows, install eSpeak NG and set "
            "`PHONEMIZER_ESPEAK_LIBRARY` if the bundled library is unavailable."
        )
    return f"{bundled_hint} On Linux, install espeak-ng with your system package manager if the bundled library is unavailable."


def check_espeak_backend() -> tuple[bool, str | None, str | None]:
    try:
        from phonemizer.backend.espeak.wrapper import EspeakWrapper

        wrapper = EspeakWrapper()
        version = getattr(wrapper, "version", None)
        data_path = getattr(wrapper, "data_path", None)
        if isinstance(version, (tuple, list)):
            version_text = ".".join(str(part) for part in version)
        elif version is None:
            version_text = "unknown"
        else:
            version_text = str(version)

        suffix = f" data at: {data_path}" if data_path else ""
        return True, f"eSpeak NG library {version_text}{suffix}", "library"
    except Exception:
        return False, None, None


def load_espeak_library(path: str) -> tuple[bool, str | None]:
    library_path = str(Path(path).expanduser())
    if not Path(library_path).is_file():
        return False, f"eSpeak library does not exist: {library_path}"

    data_path = get_espeak_data_path_for_library(library_path)
    previous_data_path = os.environ.get(ESPEAK_DATA_PATH_ENV)
    try:
        from phonemizer.backend.espeak.wrapper import EspeakWrapper

        if data_path:
            os.environ[ESPEAK_DATA_PATH_ENV] = str(data_path)
        EspeakWrapper.set_library(library_path)
        wrapper = EspeakWrapper()
        _ = wrapper.version
        _ = wrapper.data_path
        return True, None
    except Exception as phonemizer_exc:
        if previous_data_path is None:
            os.environ.pop(ESPEAK_DATA_PATH_ENV, None)
        else:
            os.environ[ESPEAK_DATA_PATH_ENV] = previous_data_path
        try:
            ctypes.CDLL(library_path)
            return True, None
        except Exception as ctypes_exc:
            return False, f"{phonemizer_exc}; ctypes load failed: {ctypes_exc}"


def unique_candidates(candidates: list[str]) -> list[str]:
    seen: set[str] = set()
    unique: list[str] = []
    for candidate in candidates:
        normalized = candidate.strip()
        if not normalized or normalized in seen:
            continue
        seen.add(normalized)
        unique.append(normalized)
    return unique


def get_known_espeak_library_candidates() -> list[str]:
    if sys.platform == "darwin":
        return [
            "/opt/homebrew/opt/espeak-ng/lib/libespeak-ng.dylib",
            "/usr/local/opt/espeak-ng/lib/libespeak-ng.dylib",
            "/opt/homebrew/lib/libespeak-ng.dylib",
            "/usr/local/lib/libespeak-ng.dylib",
            "/opt/homebrew/lib/libespeak.dylib",
            "/usr/local/lib/libespeak.dylib",
        ]
    if sys.platform == "win32":
        return [
            r"C:\Program Files\eSpeak NG\libespeak-ng.dll",
            r"C:\Program Files (x86)\eSpeak NG\libespeak-ng.dll",
        ]
    return [
        "/usr/lib/libespeak-ng.so",
        "/usr/lib/libespeak-ng.so.1",
        "/usr/lib/x86_64-linux-gnu/libespeak-ng.so",
        "/usr/lib/x86_64-linux-gnu/libespeak-ng.so.1",
        "/usr/local/lib/libespeak-ng.so",
        "/usr/local/lib/libespeak-ng.so.1",
        "/usr/lib/libespeak.so",
        "/usr/lib/libespeak.so.1",
        "/usr/lib/x86_64-linux-gnu/libespeak.so",
        "/usr/lib/x86_64-linux-gnu/libespeak.so.1",
        "/usr/local/lib/libespeak.so",
        "/usr/local/lib/libespeak.so.1",
    ]


def get_neutts_package_dir() -> Path | None:
    import importlib.util

    try:
        spec = importlib.util.find_spec("neutts")
    except Exception:
        return None

    if spec is None:
        return None

    locations = spec.submodule_search_locations
    if locations:
        first_location = next(iter(locations), None)
        return Path(first_location).resolve() if first_location else None

    if spec.origin:
        return Path(spec.origin).resolve().parent

    return None


def get_neutts_bundled_espeak_library_candidates() -> list[str]:
    package_dir = get_neutts_package_dir()
    if package_dir is None:
        return []

    if sys.platform == "darwin":
        patterns = ["libespeak-ng*.dylib", "libespeak*.dylib"]
    elif sys.platform == "win32":
        patterns = ["*espeak-ng*.dll", "*espeak*.dll"]
    else:
        patterns = ["libespeak-ng.so*", "libespeak-ng*.so*", "libespeak.so*", "libespeak*.so*"]

    candidates: list[str] = []
    for pattern in patterns:
        candidates.extend(glob(str(package_dir / pattern)))
    return candidates


def get_espeak_data_path_for_library(library_path: str) -> Path | None:
    library_dir = Path(library_path).expanduser().resolve().parent
    data_path = library_dir / "espeak-ng-data"
    return data_path if data_path.is_dir() else None


def get_ctypes_espeak_library_candidates() -> list[str]:
    candidates: list[str] = []
    for library_name in ("espeak-ng", "espeak"):
        try:
            detected = ctypes.util.find_library(library_name)
        except Exception:
            detected = None
        if detected:
            candidates.append(detected)
    return candidates


def get_known_espeak_executable_candidates() -> list[str]:
    candidates = ["espeak-ng", "espeak"]
    if sys.platform == "darwin":
        candidates.extend([
            "/opt/homebrew/bin/espeak-ng",
            "/usr/local/bin/espeak-ng",
            "/opt/homebrew/bin/espeak",
            "/usr/local/bin/espeak",
        ])
    elif sys.platform == "win32":
        candidates.extend([
            r"C:\Program Files\eSpeak NG\espeak-ng.exe",
            r"C:\Program Files (x86)\eSpeak NG\espeak-ng.exe",
            r"C:\Program Files\eSpeak NG\command_line\espeak-ng.exe",
            r"C:\Program Files (x86)\eSpeak NG\command_line\espeak-ng.exe",
        ])
    else:
        candidates.extend([
            "/usr/bin/espeak-ng",
            "/usr/local/bin/espeak-ng",
            "/bin/espeak-ng",
            "/usr/bin/espeak",
            "/usr/local/bin/espeak",
            "/bin/espeak",
        ])
    return candidates


def resolve_executable_candidate(candidate: str) -> str | None:
    if os.path.isabs(candidate) or os.sep in candidate or (os.altsep and os.altsep in candidate):
        path = Path(candidate).expanduser()
        return str(path) if path.is_file() else None
    return shutil.which(candidate)


def run_espeak_version(command: str) -> tuple[bool, str | None, str | None]:
    try:
        completed = subprocess.run(
            [command, "--version"],
            capture_output=True,
            text=True,
            timeout=10,
            check=False,
        )
    except (OSError, subprocess.SubprocessError) as exc:
        return False, None, str(exc)

    output = (completed.stdout or completed.stderr).strip()
    if completed.returncode == 0:
        first_line = output.splitlines()
        version_line = first_line[0] if first_line else Path(command).name
        return True, version_line, None
    return False, None, output or f"exit code {completed.returncode}"


def espeak_command_label(path_or_command: str) -> str:
    name = Path(path_or_command).name.lower()
    return "espeak-ng" if "espeak-ng" in name else "espeak"


def detect_espeak() -> dict[str, Any]:
    env_library = os.environ.get(PHONEMIZER_ESPEAK_LIBRARY_ENV, "").strip()
    if env_library:
        library_path = str(Path(env_library).expanduser())
        ok, error = load_espeak_library(library_path)
        if not ok:
            return {
                "ok": False,
                "source": PHONEMIZER_ESPEAK_LIBRARY_ENV,
                "path": library_path,
                "message": f"{PHONEMIZER_ESPEAK_LIBRARY_ENV} points to an unusable eSpeak library: {library_path}. {error or ''}".strip(),
            }
        return {
            "ok": True,
            "source": PHONEMIZER_ESPEAK_LIBRARY_ENV,
            "path": library_path,
            "version": f"eSpeak NG library: {library_path}",
            "message": "eSpeak NG backend is ready.",
        }

    legacy_path = os.environ.get(PHONEMIZER_ESPEAK_LEGACY_PATH_ENV, "").strip()
    if legacy_path:
        resolved_legacy_path = str(Path(legacy_path).expanduser())
        if Path(resolved_legacy_path).is_file():
            if "libespeak" in Path(resolved_legacy_path).name.lower():
                ok, error = load_espeak_library(resolved_legacy_path)
                if ok:
                    os.environ[PHONEMIZER_ESPEAK_LIBRARY_ENV] = resolved_legacy_path
                    return {
                        "ok": True,
                        "source": PHONEMIZER_ESPEAK_LEGACY_PATH_ENV,
                        "path": resolved_legacy_path,
                        "version": f"eSpeak NG library: {resolved_legacy_path}",
                        "message": "eSpeak NG backend is ready.",
                    }
                return {
                    "ok": False,
                    "source": PHONEMIZER_ESPEAK_LEGACY_PATH_ENV,
                    "path": resolved_legacy_path,
                    "message": f"{PHONEMIZER_ESPEAK_LEGACY_PATH_ENV} points to an unusable eSpeak library: {resolved_legacy_path}. {error or ''}".strip(),
                }
            ok, version, error = run_espeak_version(resolved_legacy_path)
            if ok:
                return {
                    "ok": True,
                    "source": PHONEMIZER_ESPEAK_LEGACY_PATH_ENV,
                    "path": resolved_legacy_path,
                    "version": version,
                    "message": "eSpeak NG backend is ready.",
                }
            return {
                "ok": False,
                "source": PHONEMIZER_ESPEAK_LEGACY_PATH_ENV,
                "path": resolved_legacy_path,
                "message": f"{PHONEMIZER_ESPEAK_LEGACY_PATH_ENV} points to an unusable eSpeak executable: {resolved_legacy_path}. {error or ''}".strip(),
            }

    ok, version, source = check_espeak()
    return {
        "ok": ok,
        "source": source,
        "path": None,
        "version": version,
        "message": (
            "eSpeak NG backend is ready."
            if ok
            else f"No usable eSpeak NG backend was found. {get_espeak_install_hint()}"
        ),
    }


def check_espeak() -> tuple[bool, str | None, str | None]:
    for library_path in unique_candidates(get_neutts_bundled_espeak_library_candidates()):
        if os.path.isabs(library_path) and not Path(library_path).is_file():
            continue
        ok, _error = load_espeak_library(library_path)
        if ok:
            if os.path.isabs(library_path):
                os.environ[PHONEMIZER_ESPEAK_LIBRARY_ENV] = library_path
            return True, f"Bundled eSpeak NG library: {library_path}", "bundled-library"

    backend_ok, backend_version, backend_source = check_espeak_backend()
    if backend_ok:
        return backend_ok, backend_version, backend_source

    for library_path in unique_candidates(get_known_espeak_library_candidates() + get_ctypes_espeak_library_candidates()):
        if os.path.isabs(library_path) and not Path(library_path).is_file():
            continue
        ok, _error = load_espeak_library(library_path)
        if ok:
            if os.path.isabs(library_path):
                os.environ[PHONEMIZER_ESPEAK_LIBRARY_ENV] = library_path
            return True, f"eSpeak NG library: {library_path}", "library"

    for candidate in unique_candidates(get_known_espeak_executable_candidates()):
        resolved = resolve_executable_candidate(candidate)
        if not resolved:
            continue
        ok, version, _error = run_espeak_version(resolved)
        if ok:
            return True, version, espeak_command_label(resolved)

    return False, None, None


def is_neutts_python_compatible() -> bool:
    return NEUTTS_MIN_PYTHON <= sys.version_info < NEUTTS_MAX_EXCLUSIVE_PYTHON


def neutts_python_requirement_message() -> str:
    return "NeuTTS currently requires Python 3.10-3.13. Set Python executable to a compatible interpreter."


def detect_neutts_compatibility(package_version: str | None) -> str | None:
    if not package_version:
        return None

    major = package_version.split(".", 1)[0]
    if major == "0":
        return "legacy_0_1_x"
    return "current_1_2_x_or_newer"


def prepare_neutts_runtime(compatibility_mode: str | None) -> None:
    """Work around optional runtime extras that neutts does not guard robustly."""
    if compatibility_mode != "legacy_0_1_x":
        return

    try:
        import perth

        if hasattr(perth, "PerthImplicitWatermarker") and getattr(perth, "PerthImplicitWatermarker", None) is None:
            delattr(perth, "PerthImplicitWatermarker")
    except Exception:
        # NeuTTS treats watermarking as optional, so the bridge should not fail here.
        pass


def get_installed_package_version(package_name: str) -> str | None:
    try:
        from importlib.metadata import version

        return version(package_name)
    except Exception:
        return None


def detect_kani_package() -> tuple[str | None, str | None]:
    kani2_version = get_installed_package_version("kani-tts-2")
    if kani2_version:
        return "kani-tts-2", kani2_version

    legacy_version = get_installed_package_version("kani-tts")
    if legacy_version:
        return "kani-tts", legacy_version

    return None, None


def detect_kani_transformers_version() -> str | None:
    return get_installed_package_version("transformers")


def parse_version_tuple(version: str | None) -> tuple[int, int, int] | None:
    if not version:
        return None
    parts = version.split("+", 1)[0].split(".", 3)
    parsed: list[int] = []
    for part in parts[:3]:
        digits = ""
        for char in part:
            if char.isdigit():
                digits += char
            else:
                break
        if not digits:
            return None
        parsed.append(int(digits))
    while len(parsed) < 3:
        parsed.append(0)
    return tuple(parsed)  # type: ignore[return-value]


def is_kani_transformers_compatible(version: str | None) -> bool:
    parsed = parse_version_tuple(version)
    if parsed is None:
        return False
    return KANI_MIN_TRANSFORMERS <= parsed < KANI_MAX_TRANSFORMERS_EXCLUSIVE


def kani_transformers_requirement_message() -> str:
    return "Kani-TTS-2 requires transformers>=4.56,<5 in the selected Python environment."


def is_module_available(module_name: str) -> bool:
    if module_name in sys.modules:
        return True

    import importlib.util

    try:
        return importlib.util.find_spec(module_name) is not None
    except Exception:
        return False


def detect_qwen3_runtime() -> tuple[str | None, bool, bool, str | None]:
    package_version = get_installed_package_version("qwen-tts")
    torch_version = get_installed_package_version("torch")
    return package_version, False, is_module_available("flash_attn"), torch_version


def decode_reference_audio(ref_audio_base64: Any) -> bytes:
    if not isinstance(ref_audio_base64, str) or not ref_audio_base64.strip():
        raise ValueError("Reference audio is required for NeuTTS voice cloning.")

    try:
        return base64.b64decode(ref_audio_base64, validate=True)
    except (binascii.Error, ValueError) as exc:
        raise ValueError("Reference audio is not valid base64-encoded WAV data.") from exc


def validate_reference_wav(reference_audio_bytes: bytes) -> None:
    if len(reference_audio_bytes) < 44 or reference_audio_bytes[:4] != b"RIFF" or reference_audio_bytes[8:12] != b"WAVE":
        raise ValueError("Reference audio must be a valid WAV file.")

    try:
        with wave.open(io.BytesIO(reference_audio_bytes), "rb") as wav_file:
            if wav_file.getnframes() <= 0:
                raise ValueError("Reference WAV file does not contain audio frames.")
            if wav_file.getnchannels() != 1:
                raise ValueError("Reference WAV must be mono audio.")
            sample_rate = wav_file.getframerate()
            if sample_rate < 16_000 or sample_rate > 48_000:
                raise ValueError("Reference WAV sample rate must be between 16 kHz and 48 kHz.")
    except wave.Error as exc:
        raise ValueError("Reference audio must be a readable WAV file.") from exc


def probe_neutts() -> dict[str, Any]:
    package_version = get_installed_package_version("neutts")
    compatibility_mode = detect_neutts_compatibility(package_version)
    warnings: list[str] = []

    if compatibility_mode == "legacy_0_1_x":
        warnings.append(
            "Legacy NeuTTS 0.1.x detected. Current official NeuTTS installs are preferred, "
            "but this runtime remains supported while the API stays compatible."
        )

    if not is_neutts_python_compatible():
        return {
            "ready": False,
            "message": neutts_python_requirement_message(),
            "pythonVersion": sys.version.split()[0],
            "package": "neutts",
            "packageVersion": package_version,
            "requiresPython": "<3.14,>=3.10",
            "compatibilityMode": compatibility_mode,
            "warnings": warnings,
        }

    neutts_module_available = is_module_available("neutts")
    if not package_version and not neutts_module_available:
        return {
            "ready": False,
            "message": "NeuTTS is not installed. Install neutts in the selected Python environment.",
            "pythonVersion": sys.version.split()[0],
            "package": "neutts",
            "packageVersion": package_version,
            "compatibilityMode": compatibility_mode,
            "warnings": warnings,
        }
    if not neutts_module_available:
        return {
            "ready": False,
            "message": "NeuTTS package metadata is present, but Python cannot find the neutts module. Reinstall neutts in the selected Python environment.",
            "pythonVersion": sys.version.split()[0],
            "package": "neutts",
            "packageVersion": package_version,
            "compatibilityMode": compatibility_mode,
            "warnings": warnings,
        }

    espeak = detect_espeak()
    espeak_ok = bool(espeak.get("ok"))
    espeak_version = espeak.get("version")
    espeak_source = espeak.get("source")
    if espeak_ok and espeak_source == "espeak":
        warnings.append("Using `espeak` fallback. `espeak-ng` is preferred for current NeuTTS installs.")

    if not espeak_ok:
        return {
            "ready": False,
            "message": f"NeuTTS package is installed, but no usable eSpeak NG backend was found. {espeak.get('message') or get_espeak_install_hint()}",
            "pythonVersion": sys.version.split()[0],
            "package": "neutts",
            "packageVersion": package_version,
            "compatibilityMode": compatibility_mode,
            "warnings": warnings,
            "espeakVersion": espeak_version,
            "espeakPath": espeak.get("path"),
            "espeakSource": espeak_source,
        }

    prepare_neutts_runtime(compatibility_mode)
    try:
        __import__("neutts")
    except Exception as exc:
        return {
            "ready": False,
            "message": f"NeuTTS package and eSpeak were detected, but importing neutts failed: {exc}. Reinstall neutts in the selected Python environment.",
            "pythonVersion": sys.version.split()[0],
            "package": "neutts",
            "packageVersion": package_version,
            "compatibilityMode": compatibility_mode,
            "warnings": warnings,
            "espeakVersion": espeak_version,
            "espeakPath": espeak.get("path"),
            "espeakSource": espeak_source,
        }

    return {
        "ready": True,
        "message": "NeuTTS runtime is ready.",
        "pythonVersion": sys.version.split()[0],
        "package": "neutts",
        "packageVersion": package_version,
        "compatibilityMode": compatibility_mode,
        "warnings": warnings,
        "espeakVersion": espeak_version,
        "espeakPath": espeak.get("path"),
        "espeakSource": espeak_source,
    }


def probe_kani() -> dict[str, Any]:
    package_name, package_version = detect_kani_package()
    transformers_version = detect_kani_transformers_version()

    if package_name == "kani-tts":
        return {
            "ready": False,
            "message": "Legacy kani-tts is installed. This app's Kani page targets Kani-TTS-2, so install kani-tts-2 in the selected Python environment.",
            "pythonVersion": sys.version.split()[0],
            "package": package_name,
            "packageVersion": package_version,
        }

    if package_name != "kani-tts-2":
        return {
            "ready": False,
            "message": "Kani-TTS-2 is not installed. Install kani-tts-2 in the selected Python environment.",
            "pythonVersion": sys.version.split()[0],
            "package": "kani-tts-2",
            "packageVersion": package_version,
        }

    if not is_kani_transformers_compatible(transformers_version):
        return {
            "ready": False,
            "message": (
                f"{kani_transformers_requirement_message()} "
                f"Detected {transformers_version or 'no transformers package'}."
            ),
            "pythonVersion": sys.version.split()[0],
            "package": package_name,
            "packageVersion": package_version,
            "transformersVersion": transformers_version,
        }

    if not is_module_available("kani_tts"):
        return {
            "ready": False,
            "message": "Kani-TTS-2 is installed, but Python cannot find the kani_tts module. Reinstall kani-tts-2 in the selected Python environment.",
            "pythonVersion": sys.version.split()[0],
            "package": package_name,
            "packageVersion": package_version,
            "transformersVersion": transformers_version,
        }

    try:
        __import__("kani_tts")
    except Exception as exc:
        return {
            "ready": False,
            "message": f"Kani-TTS-2 is installed, but importing kani_tts failed: {exc}. Reinstall kani-tts-2 and transformers>=4.56,<5 in the selected Python environment.",
            "pythonVersion": sys.version.split()[0],
            "package": package_name,
            "packageVersion": package_version,
            "transformersVersion": transformers_version,
        }

    return {
        "ready": True,
        "message": "Kani-TTS-2 runtime is ready.",
        "pythonVersion": sys.version.split()[0],
        "package": package_name,
        "packageVersion": package_version,
        "transformersVersion": transformers_version,
    }


def probe_qwen3() -> dict[str, Any]:
    package_version, cuda_available, flash_attn_available, torch_version = detect_qwen3_runtime()
    warnings: list[str] = []

    if not package_version:
        return {
            "ready": False,
            "message": "qwen-tts is not installed. Install qwen-tts in the selected Python environment.",
            "pythonVersion": sys.version.split()[0],
            "package": "qwen-tts",
            "packageVersion": package_version,
        }

    if not is_module_available("qwen_tts"):
        return {
            "ready": False,
            "message": "qwen-tts is installed, but Python cannot find the qwen_tts module. Reinstall qwen-tts in the selected Python environment.",
            "pythonVersion": sys.version.split()[0],
            "package": "qwen-tts",
            "packageVersion": package_version,
            "torchVersion": torch_version,
        }

    torch_package_version = get_installed_package_version("torch")
    if not torch_package_version and not is_module_available("torch"):
        return {
            "ready": False,
            "message": "Qwen3-TTS requires torch in the selected Python environment. Install torch alongside qwen-tts.",
            "pythonVersion": sys.version.split()[0],
            "package": "qwen-tts",
            "packageVersion": package_version,
            "torchVersion": torch_package_version,
        }

    try:
        torch_module = __import__("torch")
    except Exception as exc:
        return {
            "ready": False,
            "message": f"Qwen3-TTS requires an importable torch package in the selected Python environment: {exc}. Reinstall torch alongside qwen-tts.",
            "pythonVersion": sys.version.split()[0],
            "package": "qwen-tts",
            "packageVersion": package_version,
            "torchVersion": torch_package_version,
        }
    cuda_available = is_qwen3_cuda_available(torch_module)
    mps_available = is_qwen3_mps_available(torch_module)
    torch_version = getattr(torch_module, "__version__", None) or torch_package_version

    try:
        __import__("qwen_tts")
    except Exception as exc:
        return {
            "ready": False,
            "message": f"qwen-tts is installed, but importing qwen_tts failed: {exc}. Reinstall qwen-tts in the selected Python environment.",
            "pythonVersion": sys.version.split()[0],
            "package": "qwen-tts",
            "packageVersion": package_version,
            "torchVersion": torch_package_version,
        }

    recommended = select_qwen3_runtime_profile(torch_module)
    if cuda_available:
        warnings.append("CUDA was detected. Auto mode will use the faster 0.6B CustomVoice model with CUDA acceleration.")
        if not flash_attn_available:
            warnings.append("FlashAttention 2 was not detected. Auto mode will use SDPA; install flash-attn in this environment for lower GPU memory usage.")
    elif mps_available:
        warnings.append(f"Apple MPS was detected. Auto mode will use the faster 0.6B CustomVoice model with {recommended['dtype']} MPS acceleration.")
        if recommended["dtype"] == "float32":
            warnings.append("MPS bfloat16 was not available in this PyTorch build, so Auto avoids float16 and uses float32 for Qwen3-TTS stability.")
    else:
        warnings.append("No CUDA or Apple MPS accelerator was detected. Auto mode will use the faster 0.6B CustomVoice model on CPU, which can still be slow.")
    if torch_version:
        warnings.append(f"Detected torch {torch_version}.")

    return {
        "ready": True,
        "message": "Qwen3-TTS runtime is ready.",
        "pythonVersion": sys.version.split()[0],
        "package": "qwen-tts",
        "packageVersion": package_version,
        "torchVersion": torch_version or torch_package_version,
        "recommendedModelRepo": recommended["modelRepo"],
        "recommendedDeviceMap": recommended["deviceMap"],
        "recommendedDtype": recommended["dtype"],
        "recommendedAttention": recommended["attention"],
        "warnings": warnings,
    }


def array_to_wav_base64(audio: Any, sample_rate: int) -> str:
    import numpy as np

    array = np.asarray(audio, dtype=np.float32).reshape(-1)
    if array.size == 0:
        raise ValueError("Model returned empty audio.")

    array = np.nan_to_num(array, nan=0.0, posinf=0.0, neginf=0.0)
    peak = float(np.max(np.abs(array)))
    if peak > 1.0:
        array = array / peak

    pcm = (array * 32767.0).clip(-32768, 32767).astype("<i2")

    with io.BytesIO() as wav_buffer:
        with wave.open(wav_buffer, "wb") as wav_file:
            wav_file.setnchannels(1)
            wav_file.setsampwidth(2)
            wav_file.setframerate(sample_rate)
            wav_file.writeframes(pcm.tobytes())
        return base64.b64encode(wav_buffer.getvalue()).decode("ascii")


def audio_to_float32_bytes(audio: Any) -> tuple[bytes, int]:
    import numpy as np

    array = np.asarray(audio, dtype="<f4").reshape(-1)
    if array.size == 0:
        raise ValueError("Model returned empty audio.")
    array = np.nan_to_num(array, nan=0.0, posinf=0.0, neginf=0.0).astype("<f4", copy=False)
    return array.tobytes(), int(array.size)


def parse_sample_rate(value: Any) -> int | None:
    if isinstance(value, bool):
        return None

    if isinstance(value, int):
        sample_rate = value
    elif isinstance(value, float) and value.is_integer():
        sample_rate = int(value)
    else:
        return None

    return sample_rate if sample_rate > 0 else None


def require_sample_rate(runtime_name: str, *candidates: Any) -> int:
    for candidate in candidates:
        sample_rate = parse_sample_rate(candidate)
        if sample_rate is not None:
            return sample_rate

    raise RuntimeError(
        f"{runtime_name} runtime did not expose a valid positive integer sample_rate."
    )


def normalize_kani_language_tag(value: Any) -> str:
    if value is None:
        return KANI_DEFAULT_LANGUAGE_TAG

    language_tag = str(value).strip().lower()
    return language_tag or KANI_DEFAULT_LANGUAGE_TAG


def normalize_kani_language_tags(value: Any) -> list[str]:
    if not isinstance(value, (list, tuple)):
        return []

    tags: list[str] = []
    for entry in value:
        tag = str(entry).strip().lower()
        if tag and tag not in tags:
            tags.append(tag)
    return tags


def resolve_kani_language_tag(tts: Any, requested_language_tag: str) -> str | None:
    status = getattr(tts, "status", None)
    if status == "no_language_tags":
        return None

    available_tags = normalize_kani_language_tags(getattr(tts, "language_tags_list", None))
    if status != "available_language_tags":
        if requested_language_tag not in KANI_LANGUAGE_TAGS:
            supported = ", ".join(KANI_LANGUAGE_TAGS)
            raise RuntimeError(f"Unsupported Kani language tag `{requested_language_tag}`. Supported tags: {supported}.")
        return requested_language_tag

    if not available_tags:
        return requested_language_tag

    if requested_language_tag in available_tags:
        return requested_language_tag

    if requested_language_tag == KANI_DEFAULT_LANGUAGE_TAG:
        return available_tags[0]

    supported = ", ".join(available_tags)
    raise RuntimeError(f"Unsupported Kani language tag `{requested_language_tag}`. Supported tags: {supported}.")


def generate_neutts(
    payload: dict[str, Any],
    *,
    host: "NeuttsModelHost | None" = None,
    audio_chunk_sink: Callable[[dict[str, Any], Any], None] | None = None,
    encode_wav: bool = True,
) -> dict[str, Any]:
    if not is_neutts_python_compatible():
        raise RuntimeError("NeuTTS requires Python <3.14. Choose a Python 3.10-3.13 executable.")

    emit_progress("runtime_check", "Checking NeuTTS runtime...", started_at=None)
    text = str(payload.get("text", "")).strip()
    if not text:
        raise ValueError("Text is required.")

    ref_text = str(payload.get("referenceText", "")).strip()
    if not ref_text:
        raise ValueError("Reference text is required for NeuTTS voice cloning.")

    backbone_repo = str(payload.get("modelRepo") or "neuphonic/neutts-nano")
    codec_repo = str(payload.get("codecRepo") or "neuphonic/neucodec")
    backbone_device = str(payload.get("backboneDevice") or "cpu")
    codec_device = str(payload.get("codecDevice") or "cpu")

    reference_audio_bytes = decode_reference_audio(payload.get("referenceAudioBase64"))
    validate_reference_wav(reference_audio_bytes)

    package_version = get_installed_package_version("neutts")
    compatibility_mode = detect_neutts_compatibility(package_version)
    prepare_neutts_runtime(compatibility_mode)

    espeak_ok, _, _ = check_espeak()
    if not espeak_ok:
        raise RuntimeError(f"NeuTTS requires a usable eSpeak NG backend before generation can start. {get_espeak_install_hint()}")

    started = time.time()
    phase_timings: dict[str, float] = {}
    emit_progress("model_load", f"Loading {backbone_repo} and {codec_repo}...", started_at=started)
    temp_path: str | None = None
    try:
        with tempfile.NamedTemporaryFile(delete=False, suffix=".wav") as temp_audio:
            temp_audio.write(reference_audio_bytes)
            temp_path = temp_audio.name

        phase_started = time.time()
        if host is not None:
            tts = host.acquire(
                backbone_repo,
                codec_repo,
                backbone_device,
                codec_device,
                started_at=started,
            )
        else:
            from neutts import NeuTTS

            with heartbeat(
                "model_load",
                f"Loading {backbone_repo} and {codec_repo} (first run downloads the models)...",
                started_at=started,
            ):
                with redirect_stdout_to_stderr():
                    tts = NeuTTS(
                        backbone_repo=backbone_repo,
                        backbone_device=backbone_device,
                        codec_repo=codec_repo,
                        codec_device=codec_device,
                    )
        record_timing(phase_timings, "modelLoadSec", phase_started)

        emit_progress("reference_encoding", "Encoding reference audio...", started_at=started)
        phase_started = time.time()
        ref_codes = tts.encode_reference(temp_path)
        record_timing(phase_timings, "referenceEncodingSec", phase_started)
        emit_progress("inference", "Running NeuTTS inference...", started_at=started)
        phase_started = time.time()
        with heartbeat("inference", "Running NeuTTS inference...", started_at=started):
            wav = tts.infer(text, ref_codes, ref_text)
        record_timing(phase_timings, "inferenceSec", phase_started)
        sample_rate = require_sample_rate("NeuTTS", getattr(tts, "sample_rate", None))
        emit_progress("output_encoding", "Encoding generated WAV output...", started_at=started)

        # Serialize the full waveform once; reuse the sample count for duration so
        # the reported length matches the bytes actually streamed (single chunk).
        phase_started = time.time()
        chunk_bytes, chunk_samples = audio_to_float32_bytes(wav)
        if audio_chunk_sink is not None:
            audio_chunk_sink(
                {
                    "index": 0,
                    "total": 1,
                    "sampleRate": sample_rate,
                    "sampleCount": chunk_samples,
                    "silenceAfterSamples": 0,
                },
                chunk_bytes,
            )
        record_timing(phase_timings, "outputEncodingSec", phase_started)

        if encode_wav:
            return {
                "wavBase64": array_to_wav_base64(wav, sample_rate),
                "sampleRate": sample_rate,
                "modelRepo": backbone_repo,
                "durationSec": chunk_samples / sample_rate,
                "elapsedSec": time.time() - started,
                "phaseTimingsSec": phase_timings,
            }
        return {
            "sampleRate": sample_rate,
            "modelRepo": backbone_repo,
            "durationSec": chunk_samples / sample_rate,
            "elapsedSec": time.time() - started,
            "audioTransport": "websocket-binary",
            "audioChunkCount": 1,
            "phaseTimingsSec": phase_timings,
        }
    finally:
        if temp_path:
            try:
                Path(temp_path).unlink(missing_ok=True)
            except OSError:
                pass


def generate_kani(
    payload: dict[str, Any],
    *,
    host: "KaniModelHost | None" = None,
    audio_chunk_sink: Callable[[dict[str, Any], Any], None] | None = None,
    encode_wav: bool = True,
) -> dict[str, Any]:
    emit_progress("runtime_check", "Checking Kani-TTS-2 runtime...", started_at=None)
    package_name, package_version = detect_kani_package()
    if package_name != "kani-tts-2":
        installed = (
            f"{package_name} {package_version}" if package_name and package_version else package_name
        ) or "no Kani package"
        raise RuntimeError(
            f"Kani-TTS-2 generation requires the `kani-tts-2` package. The selected interpreter currently exposes {installed}."
        )

    transformers_version = detect_kani_transformers_version()
    if not is_kani_transformers_compatible(transformers_version):
        raise RuntimeError(
            f"{kani_transformers_requirement_message()} "
            f"The selected interpreter exposes {transformers_version or 'no transformers package'}."
        )

    text = str(payload.get("text", "")).strip()
    if not text:
        raise ValueError("Text is required.")

    model_repo = str(payload.get("modelRepo") or "nineninesix/kani-tts-2-en")
    language_tag = normalize_kani_language_tag(payload.get("languageTag"))

    temperature = float(payload.get("temperature") or 1.0)
    top_p = float(payload.get("topP") or 0.95)
    repetition_penalty = float(payload.get("repetitionPenalty") or 1.1)
    max_new_tokens = int(payload.get("maxNewTokens") or KANI_DEFAULT_MAX_NEW_TOKENS)
    # Kani-TTS currently has an MPS/CPU placement mismatch on macOS when device_map="auto".
    # Force CPU on macOS to keep generation stable for end users.
    default_device_map = "cpu" if sys.platform == "darwin" else "auto"
    device_map = str(payload.get("deviceMap") or default_device_map)

    started = time.time()
    phase_timings: dict[str, float] = {}
    emit_progress("model_load", f"Loading {model_repo}...", started_at=started)
    phase_started = time.time()
    if host is not None:
        tts = host.acquire(model_repo, device_map, max_new_tokens, started_at=started)
    else:
        from kani_tts import KaniTTS

        with heartbeat(
            "model_load",
            f"Loading {model_repo} (first run downloads the model)...",
            started_at=started,
        ):
            with redirect_stdout_to_stderr():
                tts = KaniTTS(
                    model_repo,
                    device_map=device_map,
                    max_new_tokens=max_new_tokens,
                    suppress_logs=True,
                    show_info=False,
                )
    record_timing(phase_timings, "modelLoadSec", phase_started)
    language_tag = resolve_kani_language_tag(tts, language_tag)

    emit_progress("inference", "Running Kani-TTS-2 inference...", started_at=started)
    phase_started = time.time()
    with heartbeat("inference", "Running Kani-TTS-2 inference...", started_at=started), redirect_stdout_to_stderr():
        wav, generated_metadata = tts.generate(
            text,
            language_tag=language_tag,
            temperature=temperature,
            top_p=top_p,
            repetition_penalty=repetition_penalty,
        )
    record_timing(phase_timings, "inferenceSec", phase_started)

    sample_rate = require_sample_rate(
        "Kani-TTS-2",
        generated_metadata,
        getattr(tts, "sample_rate", None),
    )

    emit_progress("output_encoding", "Encoding generated WAV output...", started_at=started)

    # Serialize the full waveform once; reuse the sample count for duration so
    # the reported length matches the bytes actually streamed (single chunk).
    phase_started = time.time()
    chunk_bytes, chunk_samples = audio_to_float32_bytes(wav)
    if audio_chunk_sink is not None:
        audio_chunk_sink(
            {
                "index": 0,
                "total": 1,
                "sampleRate": sample_rate,
                "sampleCount": chunk_samples,
                "silenceAfterSamples": 0,
            },
            chunk_bytes,
        )
    record_timing(phase_timings, "outputEncodingSec", phase_started)

    if encode_wav:
        return {
            "wavBase64": array_to_wav_base64(wav, sample_rate),
            "sampleRate": sample_rate,
            "modelRepo": model_repo,
            "durationSec": chunk_samples / sample_rate,
            "elapsedSec": time.time() - started,
            "phaseTimingsSec": phase_timings,
        }
    return {
        "sampleRate": sample_rate,
        "modelRepo": model_repo,
        "durationSec": chunk_samples / sample_rate,
        "elapsedSec": time.time() - started,
        "audioTransport": "websocket-binary",
        "audioChunkCount": 1,
        "phaseTimingsSec": phase_timings,
    }


def is_qwen3_mps_available(torch_module: Any) -> bool:
    backends = getattr(torch_module, "backends", None)
    mps = getattr(backends, "mps", None)
    is_available = getattr(mps, "is_available", None)
    if not callable(is_available):
        return False
    try:
        return bool(is_available())
    except Exception:
        return False


def is_qwen3_mps_bfloat16_available(torch_module: Any) -> bool:
    if not is_qwen3_mps_available(torch_module):
        return False
    bfloat16 = getattr(torch_module, "bfloat16", None)
    ones = getattr(torch_module, "ones", None)
    if bfloat16 is None or not callable(ones):
        return False
    try:
        tensor = ones((1,), device="mps", dtype=bfloat16)
        return getattr(tensor, "dtype", None) == bfloat16
    except Exception:
        return False


def is_qwen3_cuda_available(torch_module: Any) -> bool:
    cuda = getattr(torch_module, "cuda", None)
    is_available = getattr(cuda, "is_available", None)
    if not callable(is_available):
        return False
    try:
        return bool(is_available())
    except Exception:
        return False


def select_qwen3_runtime_profile(
    torch_module: Any,
    *,
    requested_model_repo: Any = None,
    requested_device_map: Any = None,
    requested_dtype: Any = None,
    requested_attention: Any = None,
) -> dict[str, str]:
    cuda_available = is_qwen3_cuda_available(torch_module)
    mps_available = is_qwen3_mps_available(torch_module)
    mps_bfloat16_available = is_qwen3_mps_bfloat16_available(torch_module)
    flash_attn_available = is_module_available("flash_attn")

    requested_device = str(requested_device_map or "auto").strip().lower()
    if not requested_device or requested_device == "auto":
        if cuda_available:
            device_map = "cuda:0"
        elif mps_available:
            device_map = "mps"
        else:
            device_map = "cpu"
    else:
        device_map = requested_device

    requested_model = str(requested_model_repo or "auto").strip()
    if not requested_model or requested_model == "auto":
        model_repo = QWEN3_FAST_CUSTOM_VOICE_REPO
    else:
        model_repo = requested_model

    dtype = str(requested_dtype or "auto").strip().lower()
    if not dtype or dtype == "auto":
        if device_map.startswith("cuda"):
            dtype = "bfloat16"
        elif device_map == "mps":
            dtype = "bfloat16" if mps_bfloat16_available else "float32"
        else:
            dtype = "float32"

    attention = str(requested_attention or "auto").strip()
    if not attention or attention == "auto":
        if device_map.startswith("cuda") and flash_attn_available:
            attention = "flash_attention_2"
        elif device_map.startswith("cuda") or device_map == "mps":
            attention = "sdpa"
        else:
            attention = "eager"

    return {
        "modelRepo": model_repo,
        "deviceMap": device_map,
        "dtype": dtype,
        "attention": attention,
    }


def parse_qwen3_dtype(dtype_name: str) -> Any:
    import torch

    if dtype_name == "bfloat16":
        return torch.bfloat16
    if dtype_name == "float16":
        return torch.float16
    if dtype_name == "float32":
        return torch.float32

    return torch.float32


def normalize_qwen3_choice(value: Any, choices: list[str], default: str) -> str:
    if not isinstance(value, str):
        return default
    stripped = value.strip()
    return stripped if stripped in choices else default


def qwen3_mps_float16_stability_message() -> str:
    return (
        "Qwen3-TTS is unstable on Apple MPS with float16 in this environment. "
        "Use dtype Auto, bfloat16, or float32."
    )


def qwen3_snapshot_present(model_repo: str) -> bool:
    """Return True when the model's config is already in the local HF cache.

    Lets the loader prefer an offline load: transformers' `fix_mistral_regex`
    path calls `model_info()` — a live request to huggingface.co — on every
    load, even when the snapshot is fully cached. Setting HF_HUB_OFFLINE when the
    model is present keeps cached generations fully local (the app's core
    promise) and removes a per-load network round-trip and its stall risk.
    """
    try:
        from huggingface_hub import try_to_load_from_cache
    except Exception:
        return False
    try:
        cached = try_to_load_from_cache(model_repo, "config.json")
    except Exception:
        return False
    return isinstance(cached, str)


@contextmanager
def huggingface_offline(enabled: bool) -> Any:
    if not enabled:
        yield
        return
    keys = ("HF_HUB_OFFLINE", "TRANSFORMERS_OFFLINE")
    previous = {key: os.environ.get(key) for key in keys}
    for key in keys:
        os.environ[key] = "1"
    try:
        yield
    finally:
        for key, value in previous.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value


def load_qwen3_model(profile: dict[str, str], *, started_at: float) -> Any:
    import torch  # noqa: F401  (surface a clear ImportError before the library uses torch)
    from qwen_tts import Qwen3TTSModel

    model_repo = profile["modelRepo"]
    device_map = profile["deviceMap"]
    dtype_name = profile["dtype"]
    attn_implementation = profile["attention"]

    load_kwargs: dict[str, Any] = {
        "device_map": device_map,
        "dtype": parse_qwen3_dtype(dtype_name),
    }
    if attn_implementation:
        load_kwargs["attn_implementation"] = attn_implementation

    cached = qwen3_snapshot_present(model_repo)
    emit_progress(
        "model_load",
        f"Loading {model_repo} with {device_map}, {dtype_name}, {attn_implementation}...",
        started_at=started_at,
    )

    def _from_pretrained(offline: bool) -> Any:
        with huggingface_offline(offline):
            with redirect_stdout_to_stderr():
                return Qwen3TTSModel.from_pretrained(model_repo, **load_kwargs)

    try:
        with heartbeat(
            "model_load",
            f"Loading {model_repo} (first run downloads the model, this can take several minutes)...",
            started_at=started_at,
        ):
            if cached:
                try:
                    model = _from_pretrained(offline=True)
                    return maybe_compile_qwen3_model(model, started_at=started_at)
                except Exception:
                    # A cached config does not prove a complete snapshot, so fall
                    # back to an online load that can fetch any missing files.
                    model = _from_pretrained(offline=False)
                    return maybe_compile_qwen3_model(model, started_at=started_at)
            model = _from_pretrained(offline=False)
            return maybe_compile_qwen3_model(model, started_at=started_at)
    except Exception as exc:
        if device_map == "mps" and dtype_name == "float16":
            raise RuntimeError(qwen3_mps_float16_stability_message()) from exc
        raise


def maybe_compile_qwen3_model(model: Any, *, started_at: float | None = None) -> Any:
    # torch.compile can add a large first-load delay on CPU and Apple MPS, and
    # short interactive TTS requests often do not amortize that cost. Keep it as
    # an explicit power-user opt-in instead of slowing every resident load.
    if (
        os.environ.get("OPEN_TTS_ENABLE_QWEN3_TORCH_COMPILE") != "1"
        or os.environ.get("OPEN_TTS_DISABLE_QWEN3_TORCH_COMPILE") == "1"
    ):
        return model

    try:
        import torch

        compile_fn = getattr(torch, "compile", None)
        inner_model = getattr(model, "model", None)
        if not callable(compile_fn) or inner_model is None:
            return model

        emit_progress("model_compile", "Compiling Qwen3-TTS inference graph...", started_at=started_at)
        model.model = compile_fn(inner_model, mode="reduce-overhead")
    except Exception as exc:
        emit_progress("model_compile", f"Torch compile unavailable; using eager mode ({exc}).", started_at=started_at)
    return model


def release_accelerator_memory(*, started_at: float | None = None) -> None:
    """Force Python and torch allocators to release a discarded resident model.

    Generic gc + best-effort torch cache flush; shared by all resident model
    hosts (Qwen3/NeuTTS/Kani) when they reload on a profile change.
    """
    emit_progress("model_release", "Releasing previous model memory...", started_at=started_at)
    gc.collect()
    try:
        import torch

        if is_qwen3_cuda_available(torch):
            torch.cuda.empty_cache()
        elif is_qwen3_mps_available(torch) and hasattr(torch, "mps") and hasattr(torch.mps, "empty_cache"):
            torch.mps.empty_cache()
    except Exception:
        # Cache flushing is a best-effort memory-pressure optimization; failing
        # to flush must not prevent the replacement model from loading.
        pass


class Qwen3ModelHost:
    """Keeps one Qwen3 model resident across requests in a persistent worker.

    Loading the model and the first MPS/CUDA inference warmup dominate wall time,
    so the `serve` loop reuses a single instance whenever the requested (repo,
    device, dtype, attention) profile is unchanged, and only reloads — releasing
    the previous model first to bound memory — when that profile changes.
    """

    def __init__(self) -> None:
        self._model: Any = None
        self._key: tuple[str, str, str, str] | None = None

    def acquire(self, profile: dict[str, str], *, started_at: float) -> Any:
        key = (
            profile["modelRepo"],
            profile["deviceMap"],
            profile["dtype"],
            profile["attention"],
        )
        if self._model is not None and self._key == key:
            emit_progress(
                "model_load",
                f"Reusing loaded {profile['modelRepo']} ({profile['deviceMap']}, {profile['dtype']}).",
                started_at=started_at,
            )
            return self._model

        # Release any previously loaded model before allocating the replacement.
        had_model = self._model is not None
        self._model = None
        self._key = None
        if had_model:
            release_accelerator_memory(started_at=started_at)
        model = load_qwen3_model(profile, started_at=started_at)
        self._model = model
        self._key = key
        return model


class NeuttsModelHost:
    """Keeps one NeuTTS instance resident across requests in a persistent worker.

    Loading the backbone/codec models dominates wall time, so the WebSocket
    worker reuses a single instance whenever the requested (backbone_repo,
    codec_repo, backbone_device, codec_device) profile is unchanged, and only
    reloads — releasing the previous model first to bound memory — when that
    profile changes. Reference audio/text and the prompt vary per request, so
    encode_reference + infer always run fresh in generate_neutts; no reference
    codes are cached on the host.
    """

    def __init__(self) -> None:
        self._model: Any = None
        self._key: tuple[str, str, str, str] | None = None

    def acquire(
        self,
        backbone_repo: str,
        codec_repo: str,
        backbone_device: str,
        codec_device: str,
        *,
        started_at: float,
    ) -> Any:
        key = (backbone_repo, codec_repo, backbone_device, codec_device)
        if self._model is not None and self._key == key:
            emit_progress(
                "model_load",
                f"Reusing loaded {backbone_repo} and {codec_repo}...",
                started_at=started_at,
            )
            return self._model

        # Release any previously loaded model before allocating the replacement.
        had_model = self._model is not None
        self._model = None
        self._key = None
        if had_model:
            release_accelerator_memory(started_at=started_at)
        from neutts import NeuTTS

        with heartbeat(
            "model_load",
            f"Loading {backbone_repo} and {codec_repo} (first run downloads the models)...",
            started_at=started_at,
        ):
            with redirect_stdout_to_stderr():
                model = NeuTTS(
                    backbone_repo=backbone_repo,
                    backbone_device=backbone_device,
                    codec_repo=codec_repo,
                    codec_device=codec_device,
                )
        self._model = model
        self._key = key
        return model


class KaniModelHost:
    """Keeps one KaniTTS instance resident across requests in a persistent worker.

    `max_new_tokens` is a KaniTTS constructor argument, so it is part of the key
    alongside (model_repo, device_map): changing it forces a reload. The
    per-request `.generate()` arguments (language_tag, temperature, top_p,
    repetition_penalty) vary freely and never trigger a reload.
    """

    def __init__(self) -> None:
        self._model: Any = None
        self._key: tuple[str, str, int] | None = None

    def acquire(
        self,
        model_repo: str,
        device_map: str,
        max_new_tokens: int,
        *,
        started_at: float,
    ) -> Any:
        key = (model_repo, device_map, max_new_tokens)
        if self._model is not None and self._key == key:
            emit_progress(
                "model_load",
                f"Reusing loaded {model_repo} ({device_map})...",
                started_at=started_at,
            )
            return self._model

        # Release any previously loaded model before allocating the replacement.
        had_model = self._model is not None
        self._model = None
        self._key = None
        if had_model:
            release_accelerator_memory(started_at=started_at)
        from kani_tts import KaniTTS

        with heartbeat(
            "model_load",
            f"Loading {model_repo} (first run downloads the model)...",
            started_at=started_at,
        ):
            with redirect_stdout_to_stderr():
                model = KaniTTS(
                    model_repo,
                    device_map=device_map,
                    max_new_tokens=max_new_tokens,
                    suppress_logs=True,
                    show_info=False,
                )
        self._model = model
        self._key = key
        return model


def make_model_host(model: str) -> Any:
    """Build the resident model host for the worker's --model selection."""
    if model == "qwen3":
        return Qwen3ModelHost()
    if model == "neutts":
        return NeuttsModelHost()
    if model == "kani":
        return KaniModelHost()
    raise RuntimeError(f"Unsupported model for WebSocket serving: {model!r}.")


def _generate_for_model(
    model: str,
    payload: dict[str, Any],
    *,
    host: Any,
    audio_chunk_sink: Callable[[dict[str, Any], Any], None],
) -> dict[str, Any]:
    """Dispatch a WebSocket generation request to the right runtime."""
    kwargs = {"host": host, "audio_chunk_sink": audio_chunk_sink, "encode_wav": False}
    if model == "neutts":
        return generate_neutts(payload, **kwargs)
    if model == "kani":
        return generate_kani(payload, **kwargs)
    if model == "qwen3":
        return generate_qwen3(payload, **kwargs)
    raise RuntimeError(f"Unsupported model: {model!r}.")


def split_qwen3_text(text: str, *, max_chars: int = QWEN3_MAX_CHUNK_CHARS) -> list[str]:
    normalized = " ".join(text.split())
    if not normalized:
        return []

    import re

    sentence_parts = [
        part.strip()
        for part in re.split(r"(?<=[.!?。！？；;])\s+", normalized)
        if part.strip()
    ]
    if not sentence_parts:
        sentence_parts = [normalized]

    chunks: list[str] = []
    current = ""

    def flush_current() -> None:
        nonlocal current
        if current:
            chunks.append(current)
            current = ""

    def append_piece(piece: str) -> None:
        nonlocal current
        if not piece:
            return
        if len(piece) > max_chars:
            flush_current()
            chunks.extend(split_long_qwen3_piece(piece, max_chars=max_chars))
            return
        candidate = f"{current} {piece}".strip() if current else piece
        if len(candidate) <= max_chars:
            current = candidate
        else:
            flush_current()
            current = piece

    for sentence in sentence_parts:
        append_piece(sentence)
    flush_current()
    return chunks or [normalized]


def split_long_qwen3_piece(piece: str, *, max_chars: int) -> list[str]:
    separators = [", ", "; ", ": ", " - ", " "]
    parts = [piece]
    for separator in separators:
        if all(len(part) <= max_chars for part in parts):
            break
        next_parts: list[str] = []
        for part in parts:
            if len(part) <= max_chars:
                next_parts.append(part)
            else:
                next_parts.extend(chunk_by_separator(part, separator, max_chars=max_chars))
        parts = next_parts
    if all(len(part) <= max_chars for part in parts):
        return [part.strip() for part in parts if part.strip()]
    return [
        piece[index:index + max_chars].strip()
        for index in range(0, len(piece), max_chars)
        if piece[index:index + max_chars].strip()
    ]


def chunk_by_separator(piece: str, separator: str, *, max_chars: int) -> list[str]:
    if separator not in piece:
        return [piece]
    chunks: list[str] = []
    current = ""
    for raw_part in piece.split(separator):
        part = raw_part.strip()
        if not part:
            continue
        next_piece = part if not current else f"{current}{separator}{part}"
        if len(next_piece) <= max_chars:
            current = next_piece
        else:
            if current:
                chunks.append(current)
            current = part
    if current:
        chunks.append(current)
    return chunks


def concatenate_audio_chunks(chunks: list[Any], *, sample_rate: int, silence_sec: float) -> Any:
    if not chunks:
        raise RuntimeError("Qwen3-TTS returned no audio.")
    if len(chunks) == 1 or silence_sec <= 0:
        return chunks[0]

    import numpy as np

    arrays = [np.asarray(chunk, dtype=np.float32).reshape(-1) for chunk in chunks]
    arrays = [array for array in arrays if array.size > 0]
    if not arrays:
        raise RuntimeError("Qwen3-TTS returned no audio.")
    if len(arrays) == 1 or silence_sec <= 0:
        return arrays[0]

    silence = np.zeros(max(0, int(round(sample_rate * silence_sec))), dtype=np.float32)
    interleaved: list[Any] = []
    for index, array in enumerate(arrays):
        if index > 0 and silence.size > 0:
            interleaved.append(silence)
        interleaved.append(array)
    return np.concatenate(interleaved)


def generate_qwen3(
    payload: dict[str, Any],
    *,
    host: "Qwen3ModelHost | None" = None,
    audio_chunk_sink: Callable[[dict[str, Any], Any], None] | None = None,
    encode_wav: bool = True,
) -> dict[str, Any]:
    text = str(payload.get("text", "")).strip()
    if not text:
        raise ValueError("Text is required.")

    speaker = normalize_qwen3_choice(payload.get("speaker"), QWEN3_SPEAKERS, QWEN3_DEFAULT_SPEAKER)
    language = normalize_qwen3_choice(payload.get("language"), QWEN3_LANGUAGES, QWEN3_DEFAULT_LANGUAGE)
    instruct = str(payload.get("instruct") or "").strip()

    import torch

    profile = select_qwen3_runtime_profile(
        torch,
        requested_model_repo=payload.get("modelRepo"),
        requested_device_map=payload.get("deviceMap"),
        requested_dtype=payload.get("dtype"),
        requested_attention=payload.get("attnImplementation"),
    )
    model_repo = profile["modelRepo"]
    device_map = profile["deviceMap"]
    dtype_name = profile["dtype"]

    started = time.time()
    phase_timings: dict[str, float] = {}
    phase_started = time.time()
    if host is not None:
        model = host.acquire(profile, started_at=started)
    else:
        model = load_qwen3_model(profile, started_at=started)
    record_timing(phase_timings, "modelLoadSec", phase_started)

    generation_kwargs: dict[str, Any] = {}
    if isinstance(payload.get("maxNewTokens"), int):
        generation_kwargs["max_new_tokens"] = int(payload["maxNewTokens"])
    if isinstance(payload.get("temperature"), (int, float)):
        generation_kwargs["temperature"] = float(payload["temperature"])
    if isinstance(payload.get("topP"), (int, float)):
        generation_kwargs["top_p"] = float(payload["topP"])

    text_chunks = split_qwen3_text(text)
    generated_chunks: list[Any] = []
    sample_rate: int | None = None
    total_samples = 0
    inference_sec = 0.0
    output_encoding_sec = 0.0
    for index, text_chunk in enumerate(text_chunks, start=1):
        chunk_suffix = f" ({index}/{len(text_chunks)})" if len(text_chunks) > 1 else ""
        emit_progress("inference", f"Generating {language} speech with {speaker}{chunk_suffix}...", started_at=started)
        call_kwargs: dict[str, Any] = {
            "text": text_chunk,
            "language": language,
            "speaker": speaker,
            **generation_kwargs,
        }
        if instruct:
            call_kwargs["instruct"] = instruct

        try:
            phase_started = time.time()
            with heartbeat("inference", f"Generating {language} speech with {speaker}{chunk_suffix}...", started_at=started):
                chunk_wavs, chunk_sample_rate = model.generate_custom_voice(**call_kwargs)
            inference_sec += max(0.0, time.time() - phase_started)
        except Exception as exc:
            if device_map == "mps" and dtype_name == "float16":
                raise RuntimeError(qwen3_mps_float16_stability_message()) from exc
            raise
        if not chunk_wavs:
            raise RuntimeError("Qwen3-TTS returned no audio.")
        parsed_sample_rate = require_sample_rate("Qwen3-TTS", chunk_sample_rate)
        if sample_rate is None:
            sample_rate = parsed_sample_rate
        elif parsed_sample_rate != sample_rate:
            raise RuntimeError("Qwen3-TTS returned inconsistent sample rates across text chunks.")
        chunk_audio = chunk_wavs[0]
        phase_started = time.time()
        chunk_bytes, chunk_samples = audio_to_float32_bytes(chunk_audio)
        silence_after_samples = (
            max(0, int(round(sample_rate * QWEN3_INTER_CHUNK_SILENCE_SEC)))
            if index < len(text_chunks)
            else 0
        )
        total_samples += chunk_samples + silence_after_samples
        if audio_chunk_sink is not None:
            audio_chunk_sink(
                {
                    "index": index - 1,
                    "total": len(text_chunks),
                    "sampleRate": sample_rate,
                    "sampleCount": chunk_samples,
                    "silenceAfterSamples": silence_after_samples,
                },
                chunk_bytes,
            )
        if encode_wav:
            generated_chunks.append(chunk_audio)
        output_encoding_sec += max(0.0, time.time() - phase_started)

    if sample_rate is None or (not generated_chunks and encode_wav):
        raise RuntimeError("Qwen3-TTS returned no audio.")

    phase_timings["inferenceSec"] = round(inference_sec, 3)
    phase_timings["outputEncodingSec"] = round(output_encoding_sec, 3)

    wav: Any | None = None
    if encode_wav:
        phase_started = time.time()
        wav = concatenate_audio_chunks(
            generated_chunks,
            sample_rate=sample_rate,
            silence_sec=QWEN3_INTER_CHUNK_SILENCE_SEC if len(generated_chunks) > 1 else 0.0,
        )
        output_encoding_sec += max(0.0, time.time() - phase_started)
        phase_timings["outputEncodingSec"] = round(output_encoding_sec, 3)

    supported_speakers: list[str] = []
    try:
        maybe_speakers = model.get_supported_speakers()
        if isinstance(maybe_speakers, list):
            # The library lowercases speaker names; map them back to the canonical
            # casing the UI uses (e.g. "ryan" -> "Ryan", "uncle_fu" -> "Uncle_Fu").
            canonical_by_lower = {name.lower(): name for name in QWEN3_SPEAKERS}
            supported_speakers = [
                canonical_by_lower.get(str(item).lower(), str(item)) for item in maybe_speakers
            ]
    except Exception:
        supported_speakers = QWEN3_SPEAKERS

    emit_progress("output_encoding", "Encoding generated WAV output...", started_at=started)

    result: dict[str, Any] = {
        "sampleRate": sample_rate,
        "modelRepo": model_repo,
        "durationSec": total_samples / sample_rate,
        "elapsedSec": time.time() - started,
        "phaseTimingsSec": phase_timings,
        "speakerStatus": f"{speaker} · {language}",
        "speakers": supported_speakers or QWEN3_SPEAKERS,
    }
    if encode_wav:
        result["wavBase64"] = array_to_wav_base64(wav, sample_rate)
    else:
        result["audioTransport"] = "websocket-binary"
        result["audioChunkCount"] = len(text_chunks)
    return result


class WebSocketProtocolError(RuntimeError):
    pass


class WebSocketConnection:
    """Minimal server-side WebSocket connection for the local Electron bridge."""

    def __init__(self, connection: socket.socket) -> None:
        self._connection = connection
        self._send_lock = threading.Lock()

    def handshake(self) -> None:
        request = b""
        while b"\r\n\r\n" not in request:
            chunk = self._connection.recv(4096)
            if not chunk:
                raise WebSocketProtocolError("WebSocket client disconnected during handshake.")
            request += chunk
            if len(request) > 64_000:
                raise WebSocketProtocolError("WebSocket handshake exceeded the maximum header size.")

        try:
            header_text = request.decode("latin1")
        except UnicodeDecodeError as exc:
            raise WebSocketProtocolError("WebSocket handshake was not valid HTTP.") from exc

        lines = header_text.split("\r\n")
        if not lines or not lines[0].startswith("GET "):
            raise WebSocketProtocolError("WebSocket handshake was not an HTTP GET request.")

        headers: dict[str, str] = {}
        for line in lines[1:]:
            if not line or ":" not in line:
                continue
            key, value = line.split(":", 1)
            headers[key.strip().lower()] = value.strip()

        if headers.get("upgrade", "").lower() != "websocket":
            raise WebSocketProtocolError("WebSocket handshake missing Upgrade: websocket.")
        if "upgrade" not in headers.get("connection", "").lower():
            raise WebSocketProtocolError("WebSocket handshake missing Connection: Upgrade.")

        websocket_key = headers.get("sec-websocket-key")
        if not websocket_key:
            raise WebSocketProtocolError("WebSocket handshake missing Sec-WebSocket-Key.")

        accept = base64.b64encode(
            hashlib.sha1(f"{websocket_key}{WEBSOCKET_GUID}".encode("ascii")).digest(),
        ).decode("ascii")
        response = (
            "HTTP/1.1 101 Switching Protocols\r\n"
            "Upgrade: websocket\r\n"
            "Connection: Upgrade\r\n"
            f"Sec-WebSocket-Accept: {accept}\r\n"
            "\r\n"
        )
        self._connection.sendall(response.encode("ascii"))

    def close(self) -> None:
        try:
            self._send_frame(0x8, b"")
        except Exception:
            pass
        try:
            self._connection.close()
        except OSError:
            pass

    def recv_text(self) -> str | None:
        fragments: list[bytes] = []
        fragment_opcode: int | None = None

        while True:
            first = self._recv_exact(1)
            if first is None:
                return None
            second = self._recv_exact(1)
            if second is None:
                return None

            first_byte = first[0]
            second_byte = second[0]
            fin = (first_byte & 0x80) != 0
            opcode = first_byte & 0x0F
            masked = (second_byte & 0x80) != 0
            length = second_byte & 0x7F

            if length == 126:
                extended = self._recv_exact(2)
                if extended is None:
                    return None
                length = int.from_bytes(extended, "big")
            elif length == 127:
                extended = self._recv_exact(8)
                if extended is None:
                    return None
                length = int.from_bytes(extended, "big")

            mask_key = self._recv_exact(4) if masked else b""
            if masked and mask_key is None:
                return None
            payload = self._recv_exact(length)
            if payload is None:
                return None
            if masked:
                payload = bytes(byte ^ mask_key[index % 4] for index, byte in enumerate(payload))

            if opcode == 0x8:
                return None
            if opcode == 0x9:
                self._send_frame(0xA, payload)
                continue
            if opcode == 0xA:
                continue
            if opcode in (0x1, 0x2):
                if fin:
                    if opcode != 0x1:
                        raise WebSocketProtocolError("Binary WebSocket requests are not supported.")
                    return payload.decode("utf-8")
                fragment_opcode = opcode
                fragments = [payload]
                continue
            if opcode == 0x0:
                if fragment_opcode is None:
                    raise WebSocketProtocolError("Unexpected WebSocket continuation frame.")
                fragments.append(payload)
                if not fin:
                    continue
                if fragment_opcode != 0x1:
                    raise WebSocketProtocolError("Binary WebSocket requests are not supported.")
                return b"".join(fragments).decode("utf-8")

            raise WebSocketProtocolError(f"Unsupported WebSocket opcode: {opcode}")

    def send_json(self, payload: dict[str, Any]) -> None:
        self.send_text(json.dumps(payload, ensure_ascii=False))

    def send_text(self, payload: str) -> None:
        self._send_frame(0x1, payload.encode("utf-8"))

    def send_binary(self, payload: bytes) -> None:
        self._send_frame(0x2, payload)

    def _send_frame(self, opcode: int, payload: bytes) -> None:
        header = bytearray([0x80 | opcode])
        length = len(payload)
        if length < 126:
            header.append(length)
        elif length <= 0xFFFF:
            header.append(126)
            header.extend(length.to_bytes(2, "big"))
        else:
            header.append(127)
            header.extend(length.to_bytes(8, "big"))
        with self._send_lock:
            self._connection.sendall(bytes(header) + payload)

    def _recv_exact(self, size: int) -> bytes | None:
        chunks: list[bytes] = []
        remaining = size
        while remaining > 0:
            chunk = self._connection.recv(remaining)
            if not chunk:
                return None
            chunks.append(chunk)
            remaining -= len(chunk)
        return b"".join(chunks)


def _send_websocket_error(websocket: WebSocketConnection, message: str, *, details: str | None = None) -> None:
    websocket.send_json({"type": "error", "ok": False, "error": message, "details": details})


def serve_websocket(model: str, cache_dir: str, host: str, port: int) -> None:
    """Serve persistent local-runtime requests over a local WebSocket.

    This is the resident transport used by Electron for all three local
    runtimes (NeuTTS, Kani, Qwen3). It intentionally does not emit bridge
    results on stdout; progress and completion travel only over WebSocket
    messages so transport failures surface instead of falling back to the
    legacy line-framed process protocol.
    """
    global _CURRENT_REQUEST_ID, _PROGRESS_SINK

    configure_cache_dir(cache_dir)
    model_host = make_model_host(model)

    server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    server.bind((host, port))
    server.listen(1)

    try:
        while True:
            connection, _address = server.accept()
            # Disable Nagle on the accepted data socket: requests are small JSON
            # frames followed by binary audio, so coalescing only adds latency.
            try:
                connection.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
            except (OSError, AttributeError):
                pass
            websocket = WebSocketConnection(connection)
            try:
                websocket.handshake()
                should_shutdown = _serve_websocket_connection(websocket, model, model_host)
            except Exception:
                try:
                    _send_websocket_error(websocket, "WebSocket bridge failed.", details=traceback.format_exc())
                except Exception:
                    pass
                should_shutdown = False
            finally:
                _CURRENT_REQUEST_ID = None
                _PROGRESS_SINK = None
                websocket.close()

            if should_shutdown:
                break
    finally:
        try:
            server.close()
        except OSError:
            pass


def _serve_websocket_connection(websocket: WebSocketConnection, model: str, model_host: Any) -> bool:
    global _CURRENT_REQUEST_ID, _PROGRESS_SINK

    while True:
        raw_message = websocket.recv_text()
        if raw_message is None:
            return False

        try:
            request = json.loads(raw_message)
        except json.JSONDecodeError:
            _send_websocket_error(websocket, "Invalid WebSocket request JSON.")
            continue
        if not isinstance(request, dict):
            _send_websocket_error(websocket, "WebSocket request must be a JSON object.")
            continue
        if request.get("command") == "shutdown":
            return True

        request_id = request.get("requestId")
        _CURRENT_REQUEST_ID = request_id if isinstance(request_id, str) else None
        payload = request.get("payload")
        if not isinstance(payload, dict):
            payload = {}

        def send_progress(progress_payload: dict[str, Any]) -> None:
            websocket.send_json({"type": "progress", **progress_payload})

        def send_audio_chunk(metadata: dict[str, Any], audio_bytes: Any) -> None:
            websocket.send_json({"type": "audio_chunk", "requestId": _CURRENT_REQUEST_ID, **metadata})
            websocket.send_binary(audio_bytes)

        _PROGRESS_SINK = send_progress
        try:
            result = _generate_for_model(
                model,
                payload,
                host=model_host,
                audio_chunk_sink=send_audio_chunk,
            )
            websocket.send_json({
                "type": "result",
                "requestId": _CURRENT_REQUEST_ID,
                "ok": True,
                "result": result,
            })
        except Exception as exc:
            websocket.send_json({
                "type": "result",
                "requestId": _CURRENT_REQUEST_ID,
                "ok": False,
                "error": str(exc),
                "details": traceback.format_exc(),
            })
        finally:
            _CURRENT_REQUEST_ID = None
            _PROGRESS_SINK = None


def run() -> None:
    parser = argparse.ArgumentParser(description="Run local NeuTTS/Kani inference tasks.")
    parser.add_argument("--action", required=True, choices=["probe", "serve-ws"])
    parser.add_argument("--model", required=True, choices=["neutts", "kani", "qwen3"])
    parser.add_argument("--cache-dir", required=True)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=0)
    args = parser.parse_args()

    if args.action == "serve-ws":
        if args.port <= 0:
            raise RuntimeError("WebSocket bridge requires a positive --port.")
        serve_websocket(args.model, args.cache_dir, args.host, args.port)
        return

    configure_cache_dir(args.cache_dir)
    payload = parse_stdin_payload()

    if args.action == "probe":
        if args.model == "neutts":
            result = probe_neutts()
        elif args.model == "qwen3":
            result = probe_qwen3()
        else:
            result = probe_kani()
        emit({"ok": True, "result": result})
        return


if __name__ == "__main__":
    try:
        run()
    except Exception as exc:  # pragma: no cover - defensive fallback
        fail(str(exc), details=traceback.format_exc())
