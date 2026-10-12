/**
 * Kitten TTS Nano 0.8 worker. One fp32 graph (standard ops only) runs on
 * WebGPU when it initializes and on WASM otherwise; a WebGPU session that
 * fails to load or warm up falls back to WASM on the bytes already in memory.
 */
import type { WorkerInMessage } from "../types";
import { loadEspeakPhonemizer } from "../lib/espeakPhonemizer";
import { chunkKittenText, KITTEN_CACHE_NAME, KITTEN_SAMPLE_RATE, KittenRuntime } from "../lib/kittenRuntime";
import { KITTEN_DEFAULT_VOICE, KITTEN_VOICES, parseKittenConfig, parseKittenVoices } from "../lib/kittenVoices";
import { PHONEMIZER_MODULE_URL } from "../lib/onnxWasmAssets";
import {
  deletePinnedAssetCache,
  fetchPinnedAsset,
  pinnedAssetSizes,
  prunePinnedAssetCache,
} from "../lib/pinnedModelAssets";
import { configureStyleTtsWasm, createStyleTtsSession, releaseStyleTtsSession } from "../lib/styleTtsRuntime";
import { loadWithBackendFallback } from "./kit/backends";
import { startPhonemeWorker, type PhonemeEngine } from "./kit/phonemeWorker";
import { KITTEN_ASSETS } from "./manifests/kitten";

const LABEL = "Kitten TTS";
const WARM_UP_TEXT = "Hello.";
const MODEL_FILE = "kitten_tts_nano_v0_8.onnx";
const VOICES_FILE = "voices.npz";
const CONFIG_FILE = "config.json";
const ALL_FILES = [MODEL_FILE, VOICES_FILE, CONFIG_FILE];

const engine: PhonemeEngine = {
  label: LABEL,
  expectedBytes: () => pinnedAssetSizes(KITTEN_ASSETS, ALL_FILES),
  async load(progress) {
    configureStyleTtsWasm();
    const fetchFile = (file: string) => fetchPinnedAsset(KITTEN_ASSETS, file, { cacheName: KITTEN_CACHE_NAME, label: LABEL, progress });
    const [modelBuffer, voicesBuffer, configBuffer, phonemize] = await Promise.all([
      fetchFile(MODEL_FILE),
      fetchFile(VOICES_FILE),
      fetchFile(CONFIG_FILE),
      loadEspeakPhonemizer(PHONEMIZER_MODULE_URL),
    ]);
    const styles = parseKittenVoices(voicesBuffer);
    const config = parseKittenConfig(configBuffer);

    const { instance: runtime, backend } = await loadWithBackendFallback({
      backends: ["webgpu", "wasm"],
      async load(candidate) {
        const session = await createStyleTtsSession(modelBuffer, candidate);
        try {
          return new KittenRuntime(session, styles, config, phonemize);
        } catch (error) {
          await releaseStyleTtsSession(session);
          throw error;
        }
      },
      // Warm-up also proves the backend: WebGPU can produce NaN audio for this graph.
      warmUp: async (instance) => {
        await instance.synthesize(WARM_UP_TEXT, KITTEN_DEFAULT_VOICE, 1);
      },
      dispose: (instance) => instance.dispose(),
      failureMessage: `${LABEL} failed to load.`,
    });
    void prunePinnedAssetCache(KITTEN_CACHE_NAME, [KITTEN_ASSETS]);
    return {
      backend,
      voices: KITTEN_VOICES.map((voice) => voice.id),
      sampleRate: KITTEN_SAMPLE_RATE,
      planChunks: (text) => chunkKittenText(text, backend),
      synthesize: (text, voice, speed) => runtime.synthesize(text, voice, speed),
      dispose: () => runtime.dispose(),
    };
  },
  clearCache: () => deletePinnedAssetCache(KITTEN_CACHE_NAME),
};

const runtime = startPhonemeWorker(engine);
self.onmessage = (event: MessageEvent<WorkerInMessage>) => {
  runtime.handleMessage(event.data);
};
