import type { RustBridgeEngineId } from "./models/registry";

/** Engines the main process drives through the Rust bridge IPC. */
export type LocalTtsModel = RustBridgeEngineId;

export interface LocalTtsProbeResult {
  ready: boolean;
  message: string;
  runtime: "rust";
  package?: string;
  packageVersion?: string | null;
  warnings?: string[];
  recommendedModelRepo?: string | null;
  recommendedBaseModelRepo?: string | null;
  provider?: string;
  device?: string;
  accelerated?: boolean;
  upstreamRevision?: string;
}

export interface LocalTtsWarmResult {
  warmed: boolean;
  message?: string;
  provider?: string;
  device?: string;
  accelerated?: boolean;
}

export interface LocalTtsGenerateResult {
  sampleRate: number;
  modelRepo: string;
  durationSec: number;
  elapsedSec: number;
  device?: string;
  warnings?: string[];
  speakerStatus?: string;
  speakers?: string[];
  audioTransport: "websocket-binary";
  audioChunkCount: number;
  phaseTimingsSec: Record<string, number>;
}

export interface LocalTtsCacheInfo {
  path: string;
  exists: boolean;
  sizeBytes: number;
}

export interface LocalTtsQwen3ProfileSetup {
  repo: string;
  revision: string;
  mode: "customVoice" | "voiceClone" | "voiceDesign";
  parameters: "0.6B" | "1.7B";
  provider: "mlx" | "libtorch";
  platforms: readonly ("darwin" | "win32")[];
  weightFormat: "mlx-6bit" | "safetensors";
  label: string;
  requiredFiles: readonly string[];
  modelDir: string;
  readiness: "missing" | "structural" | "verified";
  reason?: string;
}

export interface LocalTtsQwen3Setup {
  provider: "mlx" | "libtorch";
  profiles: LocalTtsQwen3ProfileSetup[];
  recommendedModelRepo: string;
  recommendedModelDir: string;
}

export interface LocalTtsQwen3DownloadProgress {
  modelRepo: string;
  revision: string;
  modelDir: string;
  fileName: string;
  fileIndex: number;
  totalFiles: number;
  downloadedBytes: number;
  totalBytes?: number;
}

export interface LocalTtsQwen3DownloadResult {
  modelRepo: string;
  revision: string;
  modelDir: string;
  downloadedFiles: number;
  skippedFiles: number;
  readiness: "missing" | "structural" | "verified";
}

export interface LocalTtsProgressEvent {
  requestId: string;
  model: LocalTtsModel;
  phase: string;
  message: string;
  elapsedSec?: number;
}

export interface LocalTtsAudioChunkEvent {
  /** Absent on chunks; a stream event carrying `kind: "gap"` is a LocalTtsAudioGapEvent. */
  kind?: undefined;
  requestId: string;
  model: LocalTtsModel;
  index: number;
  total: number;
  sampleRate: number;
  sampleCount: number;
  silenceAfterSamples: number;
  textUnitIndex?: number;
  textUnitTotal?: number;
  audio: ArrayBuffer;
}

/**
 * Silence the bridge puts after a finished text unit. It arrives on the audio
 * stream in order with the chunks: after the chunk numbered `afterChunkIndex`
 * and before the next one. It is not a chunk and never counts toward
 * `audioChunkCount`.
 */
export interface LocalTtsAudioGapEvent {
  kind: "gap";
  requestId: string;
  model: LocalTtsModel;
  afterChunkIndex: number;
  sampleRate: number;
  silenceSamples: number;
  textUnitIndex: number;
  textUnitTotal: number;
}

export type LocalTtsAudioStreamEvent = LocalTtsAudioChunkEvent | LocalTtsAudioGapEvent;

// A resident Rust worker went away, and the model it had loaded with it:
// evicted after idling, stopped on purpose (a cache clear, a respawn with new
// settings, shutdown) or failed. The next request loads the model again.
export interface LocalTtsModelEvictedEvent {
  model: LocalTtsModel;
  reason: "idle" | "stopped" | "failed";
}

export type DocumentImportResult =
  | { canceled: true }
  | { canceled: false; fileName: string; text: string; pageCount?: number; epubBytes?: Uint8Array };

export interface DocumentUrlImportResult {
  requestedUrl: string;
  finalUrl: string;
  contentType: string;
  html: string;
}

export interface DocumentsBridge {
  importDocument: () => Promise<DocumentImportResult>;
  importUrl: (url: string) => Promise<DocumentUrlImportResult>;
}

interface ReaderLibraryBridge {
  listDocuments: () => Promise<unknown[]>;
  getDocument: (id: string) => Promise<unknown | null>;
  saveDocument: (document: unknown) => Promise<void>;
  // Stores only the reading position. Optional so older preloads can omit it.
  saveProgress?: (documentId: string, progress: unknown) => Promise<void>;
  deleteDocument: (id: string) => Promise<void>;
  getActiveDocumentId: () => Promise<string | null>;
  setActiveDocumentId: (id: string) => Promise<void>;
  saveAudio: (audio: unknown) => Promise<void>;
  getAudio: (documentId: string, sectionId: string) => Promise<unknown | null>;
  // The signature of a section's complete cached audio, without its PCM.
  // Optional so older preloads can omit it.
  getAudioSignature?: (documentId: string, sectionId: string) => Promise<string | null>;
  deleteAudio: (documentId: string, sectionId?: string) => Promise<void>;
  // Quitting asks every window to write out its debounced Reader edits and
  // holds the shutdown until the listener's promise settles. Optional so test
  // fixtures and older preloads can omit it.
  subscribeFlushRequests?: (listener: () => Promise<void> | void) => () => void;
}

interface LocalTtsBridge {
  probe: (request: {
    model: LocalTtsModel;
    requestId: string;
    payload?: Record<string, unknown>;
  }) => Promise<LocalTtsProbeResult>;
  // Resolves once every audio chunk of the request has been delivered. With
  // `onAudioChunk`, the request's chunks go to that listener alone instead of
  // every `subscribeAudioChunk` listener. Cancelling the request stops its
  // delivery at once.
  generate: (request: {
    model: LocalTtsModel;
    requestId: string;
    payload?: Record<string, unknown>;
    continuation?: {
      jobId: string;
      sectionIndex: number;
      sectionCount: number;
    };
  }, options?: {
    onAudioChunk?: (event: LocalTtsAudioStreamEvent) => void;
  }) => Promise<LocalTtsGenerateResult>;
  warm?: (request: {
    model: LocalTtsModel;
    mode?: "customVoice" | "voiceClone" | "voiceDesign";
    modelPath?: string;
    modelRepo?: string;
  }) => Promise<LocalTtsWarmResult>;
  // Keeps the named Qwen3 model resident while the lease is held, instead of
  // evicting it after a minute of idling (main still frees it after 30 idle
  // minutes). Loads nothing itself: pair it with `warm`. Call the returned
  // function, once or more, to release the lease; a closing, crashing or
  // reloading window releases its leases on its own.
  keepWarm?: (request: {
    model: "qwen3";
    modelRepo: string;
    modelPath: string;
    mode?: "customVoice" | "voiceClone" | "voiceDesign";
  }) => () => void;
  cancel: (request: {
    model: LocalTtsModel;
    requestId: string;
  }) => Promise<{ cancelled: boolean }>;
  getCacheInfo: (request: { model: LocalTtsModel }) => Promise<LocalTtsCacheInfo>;
  clearCache: (request: { model: LocalTtsModel }) => Promise<{ path: string; cleared: boolean }>;
  getQwen3Setup: (request?: { modelRepo?: string }) => Promise<LocalTtsQwen3Setup>;
  downloadQwen3Model: (request: { modelRepo: string }) => Promise<LocalTtsQwen3DownloadResult>;
  chooseQwen3ModelDir: (request: { modelRepo: string }) => Promise<{
    path: string | null;
    readiness?: "missing" | "structural" | "verified";
    reason?: string;
  }>;
  subscribeQwen3DownloadProgress: (
    listener: (event: LocalTtsQwen3DownloadProgress) => void,
  ) => () => void;
  subscribeProgress: (listener: (event: LocalTtsProgressEvent) => void) => () => void;
  // Chunks of the requests started without their own `onAudioChunk`.
  subscribeAudioChunk: (listener: (event: LocalTtsAudioStreamEvent) => void) => () => void;
  subscribeModelEvicted?: (listener: (event: LocalTtsModelEvictedEvent) => void) => () => void;
}

export interface Audio8LoadResult {
  sampleRate: number;
}

export interface Audio8GenerateResult {
  sampleRate: number;
  elapsedSec: number;
  audio: ArrayBuffer;
}

export interface Audio8ProgressEvent {
  requestId: string;
  percent: number;
}

interface Audio8Bridge {
  load: (request: { requestId: string }) => Promise<Audio8LoadResult>;
  generate: (request: {
    requestId: string;
    text: string;
    voice: string;
    /** Unsigned 32-bit sampling seed; omitted for a fresh one. */
    seed?: number;
    /** Sampling temperature, 0.1 to 1; omitted for the model's own. */
    temperature?: number;
  }) => Promise<Audio8GenerateResult>;
  cancel: (request: { requestId: string }) => Promise<{ cancelled: boolean }>;
  getCacheInfo: () => Promise<LocalTtsCacheInfo>;
  clearCache: () => Promise<{ path: string; cleared: boolean }>;
  subscribeProgress: (listener: (event: Audio8ProgressEvent) => void) => () => void;
}

declare global {
  interface Window {
    electron?: {
      isElectron: boolean;
      platform?: string;
      arch?: string;
      readerLibrary?: ReaderLibraryBridge;
      documents?: DocumentsBridge;
      localTts?: LocalTtsBridge;
      audio8?: Audio8Bridge;
      appearance?: {
        /** Hands the app's colour theme to the native side (vibrancy, native controls). */
        setThemeSource: (source: "system" | "light" | "dark") => void;
      };
    };
  }
}
