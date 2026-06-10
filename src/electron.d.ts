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
  recommendedDeviceMap?: string | null;
  recommendedDtype?: string | null;
  recommendedAttention?: string | null;
  mlxEngines?: {
    apiServer: boolean;
    tts: boolean;
    worker: boolean;
  };
}

export interface LocalTtsWarmResult {
  warmed: boolean;
  message?: string;
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

export interface LocalTtsQwen3MlxSetup {
  workerAvailable: boolean;
  workerPath?: string;
  ttsAvailable: boolean;
  ttsPath?: string;
  apiServerAvailable: boolean;
  apiServerPath?: string;
  recommendedModelRepo: string;
  recommendedModelDir: string;
  modelDirExists: boolean;
  modelDirLooksReady: boolean;
  workerBuildCommand: string;
  modelDownloadCommand: string;
}

export interface LocalTtsQwen3MlxDownloadProgress {
  modelRepo: string;
  modelDir: string;
  fileName: string;
  fileIndex: number;
  totalFiles: number;
  downloadedBytes: number;
  totalBytes?: number;
}

export interface LocalTtsQwen3MlxDownloadResult {
  modelRepo: string;
  modelDir: string;
  downloadedFiles: number;
  skippedFiles: number;
  modelDirLooksReady: boolean;
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
  audio: ArrayBuffer;
}

interface LocalTtsBridge {
  probe: (request: {
    model: LocalTtsModel;
    requestId?: string;
    payload?: Record<string, unknown>;
  }) => Promise<LocalTtsProbeResult>;
  generate: (request: {
    model: LocalTtsModel;
    requestId: string;
    payload?: Record<string, unknown>;
  }) => Promise<LocalTtsGenerateResult>;
  warm?: (request: {
    model: LocalTtsModel;
    baseModelPath?: string;
  }) => Promise<LocalTtsWarmResult>;
  cancel: (request: {
    model: LocalTtsModel;
    requestId: string;
  }) => Promise<{ cancelled: boolean }>;
  getCacheInfo: (request: { model: LocalTtsModel }) => Promise<LocalTtsCacheInfo>;
  clearCache: (request: { model: LocalTtsModel }) => Promise<{ path: string; cleared: boolean }>;
  getQwen3MlxSetup: () => Promise<LocalTtsQwen3MlxSetup>;
  downloadQwen3MlxModel: (request: { modelRepo: string }) => Promise<LocalTtsQwen3MlxDownloadResult>;
  chooseQwen3MlxModelDir: () => Promise<{ path: string | null }>;
  subscribeQwen3MlxDownloadProgress: (
    listener: (event: LocalTtsQwen3MlxDownloadProgress) => void,
  ) => () => void;
  subscribeProgress: (listener: (event: LocalTtsProgressEvent) => void) => () => void;
  subscribeAudioChunk: (listener: (event: LocalTtsAudioChunkEvent) => void) => () => void;
}

declare global {
  interface Window {
    electron?: {
      isElectron: boolean;
      platform?: string;
      localTts?: LocalTtsBridge;
    };
  }
}
