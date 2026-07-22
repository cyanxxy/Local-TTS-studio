export type LocalTtsModel = "neutts" | "qwen3";

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

export type DocumentImportResult =
  | { canceled: true }
  | { canceled: false; fileName: string; text: string; pageCount?: number; epubBytes?: Uint8Array };

export interface DocumentUrlImportResult {
  requestedUrl: string;
  finalUrl: string;
  contentType: string;
  html: string;
}

interface DocumentsBridge {
  importDocument: () => Promise<DocumentImportResult>;
  importUrl: (url: string) => Promise<DocumentUrlImportResult>;
}

interface LocalTtsBridge {
  probe: (request: {
    model: LocalTtsModel;
    requestId: string;
    payload?: Record<string, unknown>;
  }) => Promise<LocalTtsProbeResult>;
  generate: (request: {
    model: LocalTtsModel;
    requestId: string;
    payload?: Record<string, unknown>;
    continuation?: {
      jobId: string;
      sectionIndex: number;
      sectionCount: number;
    };
  }) => Promise<LocalTtsGenerateResult>;
  warm?: (request: {
    model: LocalTtsModel;
    mode?: "customVoice" | "voiceClone" | "voiceDesign";
    modelPath?: string;
    modelRepo?: string;
  }) => Promise<LocalTtsWarmResult>;
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
  subscribeAudioChunk: (listener: (event: LocalTtsAudioChunkEvent) => void) => () => void;
}

declare global {
  interface Window {
    electron?: {
      isElectron: boolean;
      platform?: string;
      arch?: string;
      documents?: DocumentsBridge;
      localTts?: LocalTtsBridge;
    };
  }
}
