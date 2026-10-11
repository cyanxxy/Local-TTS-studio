import {
  selectInferenceThreads,
  type InferenceThreadCaps,
  type InferenceThreadEnvironment,
} from "./nativeModels/inferenceThreads";

export type Audio8ThreadEnvironment = InferenceThreadEnvironment;

/**
 * The INT4 graphs are memory-bandwidth bound: measurements on a
 * six-performance-core M1 Pro put four threads ahead of both five and six.
 * Capping at four preserves that win while automatically using fewer threads
 * on any smaller M-series layout. Elsewhere the count remains capped because
 * the graphs stop scaling well before the machine runs out of cores.
 */
const AUDIO8_THREAD_CAPS: InferenceThreadCaps = { appleSilicon: 4, other: 6 };

/** Intra-op thread count for the Audio8 ONNX sessions. */
export function selectAudio8InferenceThreads(
  environment: Audio8ThreadEnvironment = {},
): number {
  return selectInferenceThreads(AUDIO8_THREAD_CAPS, environment);
}
