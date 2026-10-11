/**
 * Kitten TTS Nano 0.8 worker. WebGPU runs the fp32 graph (standard ops only);
 * WASM-only devices get the int8 graph, whose dynamic-quantization ops WebGPU
 * lacks, at less than half the download. When WebGPU fails to load or warm
 * up, the fp32 bytes already in memory run on WASM instead of downloading the
 * int8 graph too. Both graphs share one voices.npz and config.json.
 */
import { PHONEMIZER_MODULE_URL } from "virtual:phonemizer-assets";
import type { InferenceBackend } from "../types";
import { loadEspeakPhonemizer } from "../lib/espeakPhonemizer";
import { chunkKittenText, KITTEN_CACHE_NAME, KITTEN_SAMPLE_RATE, KittenRuntime } from "../lib/kittenRuntime";
import { KITTEN_DEFAULT_VOICE, KITTEN_VOICES, parseKittenConfig, parseKittenVoices } from "../lib/kittenVoices";
import {
  KITTEN_CONFIG_FILE,
  KITTEN_NANO_FP32_MODEL,
  KITTEN_NANO_INT8_MODEL,
  KITTEN_VOICES_FILE,
} from "../lib/manifests/kitten";
import type { PinnedModelFile } from "../lib/manifests/types";
import {
  deletePinnedModelCache,
  fetchPinnedModelFile,
  prunePinnedModelCache,
  trackDownloadProgress,
} from "../lib/pinnedModelAssets";
import { configureStyleTtsWasm, createStyleTtsSession, releaseStyleTtsSession, type StyleTtsSession } from "../lib/styleTtsRuntime";
import { startStyleTtsWorker, type LoadedStyleTtsModel, type StyleTtsEngine } from "../lib/styleTtsWorkerHost";
import { canInitializeWebGPU } from "../lib/webgpu";

const LABEL = "Kitten TTS";
const WARM_UP_TEXT = "Hello.";
const ALL_FILES = [KITTEN_NANO_FP32_MODEL, KITTEN_NANO_INT8_MODEL, KITTEN_VOICES_FILE, KITTEN_CONFIG_FILE];

async function load(onProgress: (fraction: number) => void): Promise<LoadedStyleTtsModel> {
  configureStyleTtsWasm();
  const webgpu = await canInitializeWebGPU();
  const modelFile = webgpu ? KITTEN_NANO_FP32_MODEL : KITTEN_NANO_INT8_MODEL;
  const backends: InferenceBackend[] = webgpu ? ["webgpu", "wasm"] : ["wasm"];
  const track = trackDownloadProgress([modelFile, KITTEN_VOICES_FILE, KITTEN_CONFIG_FILE], onProgress);
  const fetchFile = (file: PinnedModelFile) => fetchPinnedModelFile(file, { cacheName: KITTEN_CACHE_NAME, label: LABEL, onProgress: track(file) });
  const [modelBuffer, voicesBuffer, configBuffer, phonemize] = await Promise.all([
    fetchFile(modelFile),
    fetchFile(KITTEN_VOICES_FILE),
    fetchFile(KITTEN_CONFIG_FILE),
    loadEspeakPhonemizer(PHONEMIZER_MODULE_URL),
  ]);
  const styles = parseKittenVoices(voicesBuffer);
  const config = parseKittenConfig(configBuffer);

  let lastError: unknown = null;
  for (const backend of backends) {
    let session: StyleTtsSession | null = null;
    try {
      session = await createStyleTtsSession(modelBuffer, backend);
      const runtime = new KittenRuntime(session, styles, config, phonemize);
      // Warm-up also proves the backend: WebGPU can produce NaN audio for this graph.
      await runtime.synthesize(WARM_UP_TEXT, KITTEN_DEFAULT_VOICE, 1);
      void prunePinnedModelCache(KITTEN_CACHE_NAME, ALL_FILES);
      return {
        backend,
        voices: KITTEN_VOICES.map((voice) => voice.id),
        sampleRate: KITTEN_SAMPLE_RATE,
        planChunks: (text) => chunkKittenText(text, backend),
        synthesize: (text, voice, speed) => runtime.synthesize(text, voice, speed),
        dispose: () => runtime.dispose(),
      };
    } catch (error) {
      lastError = error;
      await releaseStyleTtsSession(session);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(`${LABEL} failed to load.`);
}

const engine: StyleTtsEngine = {
  label: LABEL,
  load,
  clearCache: () => deletePinnedModelCache(KITTEN_CACHE_NAME),
};

startStyleTtsWorker(engine, self);
