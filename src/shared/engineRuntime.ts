import type { GenerationStats, ModelState } from "../types";

/**
 * The fields every surface reads off whichever runtime is currently driving it.
 * The browser path is assembled from several hooks rather than one object, so
 * it is adapted into this shape instead of the shape being bent to fit it.
 */
export interface SurfaceRuntime {
  modelState: ModelState;
  canGenerate: boolean;
  isGenerating: boolean;
  generationProgress: number;
  stats: GenerationStats;
  error: string | null;
  handleGenerate: () => void;
  handleStop: () => void;
  retryLoad: () => void;
}

/** Stops an engine's generation, and clears the audio it put in the shared player. */
export interface RuntimeControls {
  cancel: () => void;
  reset: () => void;
}
