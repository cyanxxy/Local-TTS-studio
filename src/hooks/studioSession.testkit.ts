import { vi } from "vitest";
import type { AudioSegment } from "../lib/audioTimeline";
import type { SurfaceEngineId, SurfaceEngineSettings } from "../models/registry";
import type { SynthesisChunk, SynthesisRequest } from "../shared/engineRuntime";
import type { SynthesisSession } from "../shared/useSynthesisSessionState";

/**
 * A mutable stand-in for the parts of the shared synthesis session that the
 * Studio history, takes and dialogue hooks read. Change `state`, then
 * `rerender` the hook under test to see the new session.
 */

export const FAKE_SETTINGS = {
  kokoro: { voice: "af_heart" },
  supertonic: { voice: "F1", language: "en" },
  audio8: { voice: "narrator" },
  supertonic3: { voice: "M1", language: "en" },
  qwen3: {
    profile: { repo: "org/qwen", revision: "main", mode: "customVoice", parameters: "0.6B", provider: "metal" },
    modelPath: "/models/qwen",
    speaker: "Ryan",
    language: "English",
    instruct: "",
    temperature: 0.9,
    topK: 50,
    maxNewTokens: 300,
    seed: null,
    referenceAudioSignature: "",
    referenceText: "",
  },
} as unknown as SurfaceEngineSettings;

export function segment(index: number, text: string, startSec = index - 1): AudioSegment {
  return { id: `segment-${index}`, text, startSec, endSec: startSec + 1, index, total: 2, textStart: 0, textEnd: text.length };
}

export interface StudioHarnessState {
  text: string;
  engineId: SurfaceEngineId;
  isSynthesisComplete: boolean;
  totalDuration: number;
  segments: AudioSegment[];
  activeSegmentId: string | null;
  contentEpoch: number;
  cacheSnapshot: Array<{ audio: ArrayBuffer; samplingRate: number; text: string; index: number; total: number }>;
}

export type SynthesizeImpl = (request: SynthesisRequest) => AsyncIterable<SynthesisChunk>;

export function createStudioHarness(initial: Partial<StudioHarnessState> = {}) {
  const state: StudioHarnessState = {
    text: "Hello from the studio.",
    engineId: "kokoro",
    isSynthesisComplete: false,
    totalDuration: 0,
    segments: [],
    activeSegmentId: null,
    contentEpoch: 1,
    cacheSnapshot: [],
    ...initial,
  };
  const calls = {
    synthesize: [] as SynthesisRequest[],
    restoreAudioCache: vi.fn(),
    replaceSegment: vi.fn(),
    togglePlay: vi.fn(),
    setShow: vi.fn(),
    cancelActiveGeneration: vi.fn(),
    changeText: vi.fn(),
    changeModel: vi.fn(),
    changeVoice: vi.fn(),
    changeAudio8Voice: vi.fn(),
    changeSupertonic3Voice: vi.fn(),
    changeSupertonic3Language: vi.fn(),
    changeSupertonicLanguage: vi.fn(),
    changeQuality: vi.fn(),
    onSpeedChange: vi.fn(),
    selectDesktop: vi.fn(),
  };
  let synthesizeImpl: SynthesizeImpl = () => (async function* () {
    yield { audio: new Float32Array(100).fill(0.1), samplingRate: 100, text: "", index: 1, total: 1 };
  })();
  const harness = {
    state,
    calls,
    desktopEngines: [] as SurfaceEngineId[],
    setSynthesize(impl: SynthesizeImpl) {
      synthesizeImpl = impl;
    },
    session(): SynthesisSession {
      const runtime = {
        cancelActiveGeneration: calls.cancelActiveGeneration,
        synthesize: (request: SynthesisRequest) => {
          calls.synthesize.push(request);
          return synthesizeImpl(request);
        },
      };
      return {
        player: {
          show: false,
          setShow: calls.setShow,
          state: {
            isSynthesisComplete: state.isSynthesisComplete,
            totalDuration: state.totalDuration,
            segments: state.segments,
            activeSegmentId: state.activeSegmentId,
            getContentEpoch: () => state.contentEpoch,
            getAudioCacheSnapshot: () => state.cacheSnapshot,
            restoreAudioCache: (...args: unknown[]) => {
              state.contentEpoch += 1;
              calls.restoreAudioCache(...args);
            },
            replaceSegment: calls.replaceSegment,
            togglePlay: calls.togglePlay,
          },
        },
        studio: { text: state.text, engineId: state.engineId, changeText: calls.changeText, changeModel: calls.changeModel },
        engines: {
          surfaceEngineSettings: FAKE_SETTINGS,
          runtimes: new Proxy({}, { get: () => runtime }),
          desktopModelOptions: {
            studio: harness.desktopEngines.map((key) => ({ key, onSelect: () => calls.selectDesktop(key) })),
          },
          changeVoice: calls.changeVoice,
          changeAudio8Voice: calls.changeAudio8Voice,
          changeSupertonic3Voice: calls.changeSupertonic3Voice,
          changeSupertonic3Language: calls.changeSupertonic3Language,
          changeSupertonicLanguage: calls.changeSupertonicLanguage,
          changeQuality: calls.changeQuality,
        },
        creator: {
          generationSettings: { speed: 1, quality: 8 },
          exportOptions: { format: "wav-pcm16", sampleRate: "source", bitrateKbps: 192, mastering: { enabled: false } },
          onSpeedChange: calls.onSpeedChange,
        },
      } as unknown as SynthesisSession;
    },
  };
  return harness;
}

export function pcmChunk(samples: number, rate = 100) {
  return { audio: new Float32Array(samples).fill(0.2).buffer, samplingRate: rate, text: "Hello from the studio.", index: 1, total: 1 };
}
