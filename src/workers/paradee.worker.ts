/**
 * Paradee-8M worker: one 9 MB int8 graph, WASM only. It is small and fast
 * enough (about 5x real time on one WASM thread, 11x on four, measured with
 * onnxruntime-web 1.26) that skipping WebGPU's adapter and shader start-up is
 * what makes it start instantly.
 */
import { PHONEMIZER_MODULE_URL } from "virtual:phonemizer-assets";
import { loadEspeakPhonemizer } from "../lib/espeakPhonemizer";
import { PARADEE_CONFIG_FILE, PARADEE_INT8_MODEL } from "../lib/manifests/paradee";
import type { PinnedModelFile } from "../lib/manifests/types";
import {
  chunkParadeeText,
  PARADEE_CACHE_NAME,
  PARADEE_SAMPLE_RATE,
  PARADEE_VOICE,
  ParadeeRuntime,
  parseParadeeVocabulary,
} from "../lib/paradeeRuntime";
import {
  deletePinnedModelCache,
  fetchPinnedModelFile,
  prunePinnedModelCache,
  trackDownloadProgress,
} from "../lib/pinnedModelAssets";
import { configureStyleTtsWasm, createStyleTtsSession, releaseStyleTtsSession, type StyleTtsSession } from "../lib/styleTtsRuntime";
import { startStyleTtsWorker, type LoadedStyleTtsModel, type StyleTtsEngine } from "../lib/styleTtsWorkerHost";

const LABEL = "Paradee";
const WARM_UP_TEXT = "Hello.";
const ALL_FILES = [PARADEE_INT8_MODEL, PARADEE_CONFIG_FILE];

async function load(onProgress: (fraction: number) => void): Promise<LoadedStyleTtsModel> {
  configureStyleTtsWasm();
  const track = trackDownloadProgress(ALL_FILES, onProgress);
  const fetchFile = (file: PinnedModelFile) => fetchPinnedModelFile(file, { cacheName: PARADEE_CACHE_NAME, label: LABEL, onProgress: track(file) });
  const [modelBuffer, configBuffer, phonemize] = await Promise.all([
    fetchFile(PARADEE_INT8_MODEL),
    fetchFile(PARADEE_CONFIG_FILE),
    loadEspeakPhonemizer(PHONEMIZER_MODULE_URL),
  ]);
  const vocabulary = parseParadeeVocabulary(configBuffer);
  let session: StyleTtsSession | null = null;
  try {
    session = await createStyleTtsSession(modelBuffer, "wasm");
    const runtime = new ParadeeRuntime(session, vocabulary, phonemize);
    await runtime.synthesize(WARM_UP_TEXT, 1);
    void prunePinnedModelCache(PARADEE_CACHE_NAME, ALL_FILES);
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
}

const engine: StyleTtsEngine = {
  label: LABEL,
  load,
  clearCache: () => deletePinnedModelCache(PARADEE_CACHE_NAME),
};

startStyleTtsWorker(engine, self);
