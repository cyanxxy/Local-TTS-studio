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
import io
import json
import os
import subprocess
import sys
import tempfile
import time
import traceback
import wave
from contextlib import contextmanager
from pathlib import Path
from typing import Any

RESULT_PREFIX = "__RESULT__"
PROGRESS_PREFIX = "__PROGRESS__"
NEUTTS_MIN_PYTHON = (3, 10)
NEUTTS_MAX_EXCLUSIVE_PYTHON = (3, 14)
QWEN3_CUSTOM_VOICE_REPO = "Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice"
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


@contextmanager
def swallow_stdout() -> Any:
    original = sys.stdout
    try:
        sys.stdout = io.StringIO()
        yield
    finally:
        sys.stdout = original


def emit(payload: dict[str, Any]) -> None:
    print(f"{RESULT_PREFIX}{json.dumps(payload, ensure_ascii=False)}", flush=True)


def emit_progress(phase: str, message: str, *, started_at: float | None = None) -> None:
    payload: dict[str, Any] = {
        "phase": phase,
        "message": message,
    }
    if started_at is not None:
        payload["elapsedSec"] = round(max(0.0, time.time() - started_at), 3)
    print(f"{PROGRESS_PREFIX}{json.dumps(payload, ensure_ascii=False)}", flush=True)


def fail(message: str, *, details: str | None = None) -> None:
    emit({"ok": False, "error": message, "details": details})


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
    if sys.platform == "darwin":
        return (
            "Install espeak-ng with Homebrew (`brew install espeak-ng`). "
            "Packaged app launches from Finder may not inherit your shell PATH, so set PATH "
            "or point the app at a Python runtime that can already resolve espeak-ng."
        )
    if sys.platform == "win32":
        return (
            "Install eSpeak NG and, if phonemizer still cannot find it, set "
            "`PHONEMIZER_ESPEAK_LIBRARY` and `PHONEMIZER_ESPEAK_PATH`."
        )
    return "Install espeak-ng with your system package manager and make sure it is available on PATH."


def check_espeak() -> tuple[bool, str | None, str | None]:
    candidates = ["espeak-ng", "espeak"]
    for cmd in candidates:
        try:
            completed = subprocess.run(
                [cmd, "--version"],
                capture_output=True,
                text=True,
                timeout=10,
                check=False,
            )
            if completed.returncode == 0:
                first_line = (completed.stdout or completed.stderr).splitlines()
                version_line = first_line[0] if first_line else cmd
                return True, version_line, cmd
        except (OSError, subprocess.SubprocessError):
            continue
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


def is_module_available(module_name: str) -> bool:
    import importlib.util

    return importlib.util.find_spec(module_name) is not None


def detect_qwen3_runtime() -> tuple[str | None, bool, bool, str | None]:
    package_version = get_installed_package_version("qwen-tts")
    torch_cuda_available = False
    torch_version: str | None = None

    try:
        import torch

        torch_cuda_available = bool(torch.cuda.is_available())
        torch_version = getattr(torch, "__version__", None)
    except Exception:
        pass

    return package_version, torch_cuda_available, is_module_available("flash_attn"), torch_version


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

    prepare_neutts_runtime(compatibility_mode)

    try:
        __import__("neutts")
    except Exception as exc:
        return {
            "ready": False,
            "message": f"Failed to import neutts: {exc}",
            "pythonVersion": sys.version.split()[0],
            "package": "neutts",
            "packageVersion": package_version,
            "compatibilityMode": compatibility_mode,
            "warnings": warnings,
        }

    espeak_ok, espeak_version, espeak_command = check_espeak()
    if espeak_ok and espeak_command == "espeak":
        warnings.append("Using `espeak` fallback. `espeak-ng` is preferred for current NeuTTS installs.")

    return {
        "ready": espeak_ok,
        "message": (
            "NeuTTS runtime is ready."
            if espeak_ok
            else f"NeuTTS package is installed, but espeak-ng was not found. {get_espeak_install_hint()}"
        ),
        "pythonVersion": sys.version.split()[0],
        "package": "neutts",
        "packageVersion": package_version,
        "compatibilityMode": compatibility_mode,
        "warnings": warnings,
        "espeakVersion": espeak_version,
    }


def probe_kani() -> dict[str, Any]:
    package_name, package_version = detect_kani_package()
    transformers_version = detect_kani_transformers_version()

    try:
        __import__("kani_tts")
    except Exception as exc:
        return {
            "ready": False,
            "message": f"Failed to import kani_tts: {exc}",
            "pythonVersion": sys.version.split()[0],
            "package": package_name or "kani-tts-2",
            "packageVersion": package_version,
        }

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
        }

    if transformers_version != "4.56.0":
        return {
            "ready": False,
            "message": (
                "Kani-TTS-2 requires transformers==4.56.0 in the selected Python environment. "
                f"Detected {transformers_version or 'no transformers package'}."
            ),
            "pythonVersion": sys.version.split()[0],
            "package": package_name,
            "packageVersion": package_version,
        }

    return {
        "ready": True,
        "message": "Kani-TTS-2 runtime is ready.",
        "pythonVersion": sys.version.split()[0],
        "package": package_name,
        "packageVersion": package_version,
    }


def probe_qwen3() -> dict[str, Any]:
    package_version, cuda_available, flash_attn_available, torch_version = detect_qwen3_runtime()
    warnings: list[str] = []

    try:
        __import__("qwen_tts")
    except Exception as exc:
        return {
            "ready": False,
            "message": f"Failed to import qwen_tts: {exc}",
            "pythonVersion": sys.version.split()[0],
            "package": "qwen-tts",
            "packageVersion": package_version,
        }

    try:
        __import__("torch")
    except Exception as exc:
        return {
            "ready": False,
            "message": f"Qwen3-TTS requires torch in the selected Python environment: {exc}",
            "pythonVersion": sys.version.split()[0],
            "package": "qwen-tts",
            "packageVersion": package_version,
        }

    if not cuda_available:
        warnings.append("CUDA was not detected. Qwen3-TTS can attempt CPU/MPS generation, but the 1.7B model is expected to be slow and memory-heavy.")
    if not flash_attn_available:
        warnings.append("FlashAttention 2 was not detected. It is optional, but recommended by Qwen for lower GPU memory usage.")
    if torch_version:
        warnings.append(f"Detected torch {torch_version}.")

    return {
        "ready": True,
        "message": "Qwen3-TTS runtime is ready.",
        "pythonVersion": sys.version.split()[0],
        "package": "qwen-tts",
        "packageVersion": package_version,
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


def generate_neutts(payload: dict[str, Any]) -> dict[str, Any]:
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
        raise RuntimeError(f"NeuTTS requires espeak-ng before generation can start. {get_espeak_install_hint()}")

    started = time.time()
    emit_progress("model_load", f"Loading {backbone_repo} and {codec_repo}...", started_at=started)
    from neutts import NeuTTS
    temp_path: str | None = None
    try:
        with tempfile.NamedTemporaryFile(delete=False, suffix=".wav") as temp_audio:
            temp_audio.write(reference_audio_bytes)
            temp_path = temp_audio.name

        with swallow_stdout():
            tts = NeuTTS(
                backbone_repo=backbone_repo,
                backbone_device=backbone_device,
                codec_repo=codec_repo,
                codec_device=codec_device,
            )

        emit_progress("reference_encoding", "Encoding reference audio...", started_at=started)
        ref_codes = tts.encode_reference(temp_path)
        emit_progress("inference", "Running NeuTTS inference...", started_at=started)
        wav = tts.infer(text, ref_codes, ref_text)
        sample_rate = require_sample_rate("NeuTTS", getattr(tts, "sample_rate", None))
        emit_progress("output_encoding", "Encoding generated WAV output...", started_at=started)

        return {
            "wavBase64": array_to_wav_base64(wav, sample_rate),
            "sampleRate": sample_rate,
            "modelRepo": backbone_repo,
            "durationSec": len(wav) / sample_rate,
            "elapsedSec": time.time() - started,
        }
    finally:
        if temp_path:
            try:
                Path(temp_path).unlink(missing_ok=True)
            except OSError:
                pass


def generate_kani(payload: dict[str, Any]) -> dict[str, Any]:
    package_name, package_version = detect_kani_package()
    if package_name != "kani-tts-2":
        installed = (
            f"{package_name} {package_version}" if package_name and package_version else package_name
        ) or "no Kani package"
        raise RuntimeError(
            f"Kani-TTS-2 generation requires the `kani-tts-2` package. The selected interpreter currently exposes {installed}."
        )

    transformers_version = detect_kani_transformers_version()
    if transformers_version != "4.56.0":
        raise RuntimeError(
            "Kani-TTS-2 generation requires transformers==4.56.0. "
            f"The selected interpreter exposes {transformers_version or 'no transformers package'}."
        )

    text = str(payload.get("text", "")).strip()
    if not text:
        raise ValueError("Text is required.")

    model_repo = str(payload.get("modelRepo") or "nineninesix/kani-tts-2-en")
    language_tag = payload.get("languageTag")
    if isinstance(language_tag, str):
        language_tag = language_tag.strip() or None
    else:
        language_tag = None

    temperature = float(payload.get("temperature") or 1.0)
    top_p = float(payload.get("topP") or 0.95)
    repetition_penalty = float(payload.get("repetitionPenalty") or 1.1)
    max_new_tokens = int(payload.get("maxNewTokens") or 3000)
    # Kani-TTS currently has an MPS/CPU placement mismatch on macOS when device_map="auto".
    # Force CPU on macOS to keep generation stable for end users.
    default_device_map = "cpu" if sys.platform == "darwin" else "auto"
    device_map = str(payload.get("deviceMap") or default_device_map)

    from kani_tts import KaniTTS

    started = time.time()
    with swallow_stdout():
        tts = KaniTTS(
            model_repo,
            device_map=device_map,
            max_new_tokens=max_new_tokens,
            suppress_logs=True,
            show_info=False,
        )

    wav, generated_sample_rate = tts.generate(
        text,
        language_tag=language_tag,
        temperature=temperature,
        top_p=top_p,
        repetition_penalty=repetition_penalty,
    )

    sample_rate = require_sample_rate(
        "Kani-TTS-2",
        generated_sample_rate,
        getattr(tts, "sample_rate", None),
    )

    return {
        "wavBase64": array_to_wav_base64(wav, sample_rate),
        "sampleRate": sample_rate,
        "modelRepo": model_repo,
        "durationSec": len(wav) / sample_rate,
        "elapsedSec": time.time() - started,
    }


def parse_qwen3_dtype(dtype_name: str, cuda_available: bool) -> Any:
    import torch

    if dtype_name == "bfloat16":
        return torch.bfloat16
    if dtype_name == "float16":
        return torch.float16
    if dtype_name == "float32":
        return torch.float32

    return torch.bfloat16 if cuda_available else torch.float32


def normalize_qwen3_choice(value: Any, choices: list[str], default: str) -> str:
    if not isinstance(value, str):
        return default
    stripped = value.strip()
    return stripped if stripped in choices else default


def generate_qwen3(payload: dict[str, Any]) -> dict[str, Any]:
    text = str(payload.get("text", "")).strip()
    if not text:
        raise ValueError("Text is required.")

    model_repo = str(payload.get("modelRepo") or QWEN3_CUSTOM_VOICE_REPO)
    speaker = normalize_qwen3_choice(payload.get("speaker"), QWEN3_SPEAKERS, QWEN3_DEFAULT_SPEAKER)
    language = normalize_qwen3_choice(payload.get("language"), QWEN3_LANGUAGES, QWEN3_DEFAULT_LANGUAGE)
    instruct = str(payload.get("instruct") or "").strip()
    dtype_name = str(payload.get("dtype") or "auto").strip().lower()
    attn_implementation = str(payload.get("attnImplementation") or "auto").strip()

    import torch
    from qwen_tts import Qwen3TTSModel

    cuda_available = bool(torch.cuda.is_available())
    device_map = str(
        payload.get("deviceMap")
        or ("cuda:0" if cuda_available else "cpu")
    ).strip().lower()
    if device_map == "auto":
        device_map = "cuda:0" if cuda_available else "cpu"

    started = time.time()
    emit_progress("model_load", f"Loading {model_repo} with {device_map}...", started_at=started)

    load_kwargs: dict[str, Any] = {
        "device_map": device_map,
        "dtype": parse_qwen3_dtype(dtype_name, cuda_available),
    }
    if attn_implementation and attn_implementation != "auto":
        load_kwargs["attn_implementation"] = attn_implementation

    with swallow_stdout():
        model = Qwen3TTSModel.from_pretrained(model_repo, **load_kwargs)

    generation_kwargs: dict[str, Any] = {}
    if isinstance(payload.get("maxNewTokens"), int):
        generation_kwargs["max_new_tokens"] = int(payload["maxNewTokens"])
    if isinstance(payload.get("temperature"), (int, float)):
        generation_kwargs["temperature"] = float(payload["temperature"])
    if isinstance(payload.get("topP"), (int, float)):
        generation_kwargs["top_p"] = float(payload["topP"])

    emit_progress("inference", f"Generating {language} speech with {speaker}...", started_at=started)
    call_kwargs: dict[str, Any] = {
        "text": text,
        "language": language,
        "speaker": speaker,
        **generation_kwargs,
    }
    if instruct:
        call_kwargs["instruct"] = instruct

    wavs, sample_rate = model.generate_custom_voice(**call_kwargs)
    if not wavs:
        raise RuntimeError("Qwen3-TTS returned no audio.")
    wav = wavs[0]

    supported_speakers: list[str] = []
    try:
        maybe_speakers = model.get_supported_speakers()
        if isinstance(maybe_speakers, list):
            supported_speakers = [str(item) for item in maybe_speakers]
    except Exception:
        supported_speakers = QWEN3_SPEAKERS

    sample_rate = require_sample_rate("Qwen3-TTS", sample_rate)
    emit_progress("output_encoding", "Encoding generated WAV output...", started_at=started)

    return {
        "wavBase64": array_to_wav_base64(wav, sample_rate),
        "sampleRate": sample_rate,
        "modelRepo": model_repo,
        "durationSec": len(wav) / sample_rate,
        "elapsedSec": time.time() - started,
        "speakerStatus": f"{speaker} · {language}",
        "speakers": supported_speakers or QWEN3_SPEAKERS,
    }


def run() -> None:
    parser = argparse.ArgumentParser(description="Run local NeuTTS/Kani inference tasks.")
    parser.add_argument("--action", required=True, choices=["probe", "generate"])
    parser.add_argument("--model", required=True, choices=["neutts", "kani", "qwen3"])
    parser.add_argument("--cache-dir", required=True)
    args = parser.parse_args()

    if args.model == "neutts" and args.action == "generate" and not is_neutts_python_compatible():
        raise RuntimeError("NeuTTS requires Python <3.14 and >=3.10.")

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

    if args.model == "neutts":
        result = generate_neutts(payload)
    elif args.model == "qwen3":
        result = generate_qwen3(payload)
    else:
        result = generate_kani(payload)

    emit({"ok": True, "result": result})


if __name__ == "__main__":
    try:
        run()
    except Exception as exc:  # pragma: no cover - defensive fallback
        fail(str(exc), details=traceback.format_exc())
