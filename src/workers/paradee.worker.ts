/**
 * Paradee-8M worker: one 9 MB int8 graph, WASM only. It is small and fast
 * enough (about 5x real time on one WASM thread, 11x on four, measured with
 * onnxruntime-web 1.26) that skipping WebGPU's adapter and shader start-up is
 * what makes it start instantly.
 */
import type { WorkerInMessage } from "../types";
import { loadEspeakPhonemizer } from "../lib/espeakPhonemizer";
import { PHONEMIZER_MODULE_URL } from "../lib/onnxWasmAssets";
import {
  chunkParadeeText,
  PARADEE_CACHE_NAME,
  PARADEE_SAMPLE_RATE,
  PARADEE_VOICE,
  ParadeeRuntime,
  parseParadeeVocabulary,
} from "../lib/paradeeRuntime";
import {
  deletePinnedAssetCache,
  fetchPinnedAsset,
  pinnedAssetSizes,
  prunePinnedAssetCache,
} from "../lib/pinnedModelAssets";
import { configureStyleTtsWasm, createStyleTtsSession, releaseStyleTtsSession, type StyleTtsSession } from "../lib/styleTtsRuntime";
import { startPhonemeWorker, type PhonemeEngine } from "./kit/phonemeWorker";
import { PARADEE_ASSETS } from "./manifests/paradee";

const LABEL = "Paradee";
const WARM_UP_TEXT = "Hello.";
const MODEL_FILE = "onnx/paradee_int8.onnx";
const CONFIG_FILE = "config.json";
const ALL_FILES = [MODEL_FILE, CONFIG_FILE];

const engine: PhonemeEngine = {
  label: LABEL,
  expectedBytes: pinnedAssetSizes(PARADEE_ASSETS, ALL_FILES),
  async load(progress) {
    configureStyleTtsWasm();
    const fetchFile = (file: string) => fetchPinnedAsset(PARADEE_ASSETS, file, { cacheName: PARADEE_CACHE_NAME, label: LABEL, progress });
    const [modelBuffer, configBuffer, phonemize] = await Promise.all([
      fetchFile(MODEL_FILE),
      fetchFile(CONFIG_FILE),
      loadEspeakPhonemizer(PHONEMIZER_MODULE_URL),
    ]);
    const vocabulary = parseParadeeVocabulary(configBuffer);
    let session: StyleTtsSession | null = null;
    try {
      session = await createStyleTtsSession(modelBuffer, "wasm");
      const runtime = new ParadeeRuntime(session, vocabulary, phonemize);
      await runtime.synthesize(WARM_UP_TEXT, 1);
      void prunePinnedAssetCache(PARADEE_CACHE_NAME, [PARADEE_ASSETS]);
      return {
        backend: "wasm",
        voices: [PARADEE_VOICE],
        sampleRate: PARADEE_SAMPLE_RATE,
        planChunks: chunkParadeeText,
        synthesize: async (text, _voice, speed) => ({ audio: await runtime.synthesize(text, speed) }),
        dispose: () => runtime.dispose(),
      };
    } catch (error) {
      await releaseStyleTtsSession(session);
      throw error;
    }
  },
  clearCache: () => deletePinnedAssetCache(PARADEE_CACHE_NAME),
};

const runtime = startPhonemeWorker(engine);
self.onmessage = (event: MessageEvent<WorkerInMessage>) => {
  runtime.handleMessage(event.data);
};
