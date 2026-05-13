export type LocalTtsModel = "neutts" | "kani";

export interface LocalTtsProbeResult {
  ready: boolean;
  message: string;
  pythonVersion: string;
  pythonBinary: string;
  resolvedFrom: string;
  package?: string;
  packageVersion?: string | null;
  requiresPython?: string;
  compatibilityMode?: "legacy_0_1_x" | "current_1_2_x_or_newer" | null;
  warnings?: string[];
  espeakVersion?: string | null;
}

export interface LocalTtsGenerateResult {
  wavBase64: string;
  sampleRate: number;
  modelRepo: string;
  durationSec: number;
  elapsedSec: number;
  speakerStatus?: string;
  speakers?: string[];
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

interface LocalTtsBridge {
  probe: (request: {
    model: LocalTtsModel;
    requestId?: string;
    pythonBinary?: string;
    payload?: Record<string, unknown>;
  }) => Promise<LocalTtsProbeResult>;
  generate: (request: {
    model: LocalTtsModel;
    requestId: string;
    pythonBinary?: string;
    payload?: Record<string, unknown>;
  }) => Promise<LocalTtsGenerateResult>;
  cancel: (request: {
    model: LocalTtsModel;
    requestId: string;
  }) => Promise<{ cancelled: boolean }>;
  getCacheInfo: (request: { model: LocalTtsModel }) => Promise<LocalTtsCacheInfo>;
  clearCache: (request: { model: LocalTtsModel }) => Promise<{ path: string; cleared: boolean }>;
  subscribeProgress: (listener: (event: LocalTtsProgressEvent) => void) => () => void;
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
