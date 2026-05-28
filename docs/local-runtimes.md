# Desktop Local Runtimes

Electron exposes optional local Python-runtime integrations for NeuTTS Nano, Kani-TTS-2, and Qwen3-TTS. The desktop package includes the Electron app and bridge script, but it does not bundle Python or model weights.

On first use, if no usable runtime is found and no Python executable override is set, Electron creates a managed virtual environment and installs the selected runtime package automatically:

- NeuTTS: `.venv-neutts` with `neutts`
- Kani: `.venv-kani` with `kani-tts-2`, then `transformers==4.56.0`
- Qwen3: `.venv-qwen3` with `qwen-tts` and `torch`

Managed environments use Python 3.12. If Python 3.12 is not installed but `uv` is available, Electron uses `uv venv --python 3.12` so uv can provide the interpreter. Development builds create these environments in the repo root. Packaged builds create them under the app's user data directory. Set `OPEN_TTS_DISABLE_AUTO_PYTHON_SETUP=1` to disable this behavior.

Current NeuTTS wheels normally bundle the eSpeak NG shared library and data needed by phonemizer. The bridge validates that Python-level eSpeak backend first and only falls back to a system `espeak-ng`/`espeak` command if the bundled backend is unavailable.

## Python Discovery Order

Electron resolves a usable Python runtime in this order:

1. The Python executable entered in the app's runtime settings
2. `TTS_NEUTTS_PYTHON_BIN`, `TTS_KANI_PYTHON_BIN`, or `TTS_QWEN3_PYTHON_BIN` for the selected model
3. `TTS_PYTHON_BIN`
4. Local virtualenv names, if they exist:
   - NeuTTS: `.venv-neutts` -> `.venv313` -> shared `.venv`
   - Kani: `.venv-kani` -> `.venv313` -> shared `.venv`
   - Qwen3: `.venv-qwen3` -> `.venv-qwen` -> `.venv312` -> shared `.venv`
5. System Python:
   - macOS/Linux: `python3.13` -> `python3.12` -> `python3.11` -> `python3.10` -> `python3` -> `python`
   - Windows: `py` -> `python`
6. Managed first-run setup for the selected runtime, using Python 3.12 or uv, unless disabled

In development, Electron resolves virtualenv names from the repo root. In packaged apps, runtime discovery is stricter: Electron searches only the packaged app path and its resources directory unless an explicit Python executable or environment variable is provided.

## NeuTTS Nano

Open TTS supports legacy repo environments such as `.venv-neutts` with `neutts 0.1.x`, plus current official NeuTTS installs from Neuphonic docs.

Requirements:

- Python 3.10 through 3.13
- `pip install neutts`
- A usable eSpeak NG backend. Current NeuTTS wheels bundle this; source/custom installs may need system eSpeak NG plus `PHONEMIZER_ESPEAK_LIBRARY`.
- A reference transcript plus a real mono WAV clip

Manual development setup:

```bash
python3.13 -m venv .venv-neutts
source .venv-neutts/bin/activate
pip install --upgrade pip
pip install neutts
```

Packaged-app notes:

- `TTS_NEUTTS_PYTHON_BIN` is the most reliable override for packaged builds.
- Finder / Explorer launches may not inherit a useful `PATH`, so the bridge checks NeuTTS' bundled eSpeak library before trying command-line `espeak-ng`.
- If you use a custom NeuTTS source install without bundled eSpeak files, install eSpeak NG and set `PHONEMIZER_ESPEAK_LIBRARY` plus `ESPEAK_DATA_PATH` if phonemizer cannot locate it.

## Kani-TTS-2

Requirements:

- Python 3.10+
- `pip install kani-tts-2`
- `pip install -U "transformers==4.56.0"`
- An importable `kani_tts`

On macOS, the bridge defaults Kani to CPU to avoid known MPS issues.

## Qwen3-TTS CustomVoice

Open TTS supports `Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice` as an Electron-only local runtime. It is not wired into the browser WebGPU worker path because the released model ships Qwen-specific `qwen-tts` / safetensors assets rather than ONNX / Transformers.js browser artifacts.

Requirements:

- Python 3.10+
- An importable `qwen_tts`
- An importable `torch`
- CUDA-capable GPU strongly recommended for practical generation speed
- FlashAttention 2 optional, but recommended by the Qwen runtime for lower GPU memory usage

Manual development setup:

```bash
python3.12 -m venv .venv-qwen3
source .venv-qwen3/bin/activate
pip install --upgrade pip
pip install qwen-tts torch
```

If you have a CUDA environment, install the PyTorch build and optional FlashAttention package that match your driver/toolkit before launching Electron. You can also point Open TTS at a pre-existing environment with `TTS_QWEN3_PYTHON_BIN=/absolute/path/to/python`.

The Qwen3 page exposes speaker-scoped language selection, optional instruction prompt, device map, dtype, attention implementation, temperature, top-p, and max token controls.

## Runtime Probe

The probe reports:

- resolved interpreter path
- where that interpreter came from
- Python version
- detected package and version
- NeuTTS compatibility mode, when relevant
- eSpeak NG backend status, when relevant
- Qwen3 CUDA / FlashAttention warnings, when relevant

A successful probe means the interpreter can launch the bridge and expose the required package. It does not prove that every reference WAV or generation request will succeed.

## Troubleshooting

| App message | Meaning | Fix |
|---|---|---|
| `No usable Python runtime found` | Electron could not resolve a Python interpreter | Set Python in app settings, or set the relevant `TTS_*_PYTHON_BIN` environment variable |
| `NeuTTS currently requires Python 3.10-3.13` | Interpreter is too new or too old for current NeuTTS | Point the app at Python 3.10 through 3.13 |
| `Failed to import neutts` | Python launched, but the environment does not expose `neutts` | Activate that environment and run `pip install neutts` |
| `Failed to import qwen_tts` | Python launched, but the environment does not expose Qwen's TTS package | Activate that environment and install `qwen-tts` |
| `Qwen3-TTS requires torch` | Qwen runtime is present, but PyTorch is missing | Install the PyTorch build that matches your CPU/GPU environment |
| `CUDA was not detected` | Qwen3 can try CPU/MPS, but the 1.7B model is slow and memory-heavy there | Use a CUDA environment when possible, or expect long generation times |
| `no usable eSpeak NG backend was found` | NeuTTS is installed, but phonemizer could not load bundled or system eSpeak support | Reinstall current `neutts`; for custom/source installs, install eSpeak NG and set `PHONEMIZER_ESPEAK_LIBRARY` plus `ESPEAK_DATA_PATH` |
| `Reference audio must be a valid WAV file` | Uploaded reference clip is not a readable WAV | Convert the clip to WAV before uploading |
| `Reference text is required` | NeuTTS needs the exact transcript of the reference clip | Paste the spoken transcript exactly as heard in the WAV |
