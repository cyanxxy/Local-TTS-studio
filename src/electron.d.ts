export type LocalTtsModel = "neutts" | "qwen3";

export interface LocalTtsProbeResult {
  ready: boolean;
  message: string;
  runtime: "rust";
  package?: string;
  packageVersion?: string | null;
  warnings?: string[];
  recommendedModelRepo?: string | null;
  recommendedDeviceMap?: string | null;
  recommendedDtype?: string | null;
  recommendedAttention?: string | null;
}

export interface LocalTtsGenerateResult {
  sampleRate: number;
  modelRepo: string;
  durationSec: number;
  elapsedSec: number;
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
  cancel: (request: {
    model: LocalTtsModel;
    requestId: string;
  }) => Promise<{ cancelled: boolean }>;
  getCacheInfo: (request: { model: LocalTtsModel }) => Promise<LocalTtsCacheInfo>;
  clearCache: (request: { model: LocalTtsModel }) => Promise<{ path: string; cleared: boolean }>;
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
