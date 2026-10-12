import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MAX_LOCAL_TTS_TEXT_LENGTH,
  countUnicodeScalars,
} from "../../electron/localTtsLimits";
import { useQwen3Runtime } from "../contexts/Qwen3RuntimeContext";
import type { UseAudioPlayerReturn } from "./useAudioPlayer";
import { useQwen3LocalRuntime } from "./useQwen3LocalRuntime";
import { PlaybackClock } from "../lib/playbackClock";
import { buildQwen3RequestPlan, buildQwen3TextUnits } from "../lib/qwenChunking";

vi.mock("../contexts/Qwen3RuntimeContext", () => ({
  useQwen3Runtime: vi.fn(),
}));

interface GenerateRequest {
  requestId: string;
  payload?: Record<string, unknown>;
  continuation?: { jobId: string; sectionIndex: number; sectionCount: number };
}

function runtimeSettings() {
  return {
    profile: {
      repo: "mlx-community/Qwen3-TTS-12Hz-0.6B-CustomVoice-6bit",
      revision: "a".repeat(40),
      mode: "customVoice",
      parameters: "0.6B",
      provider: "mlx",
      platforms: ["darwin"],
      weightFormat: "mlx-6bit",
      label: "Qwen3 CustomVoice",
      requiredFiles: ["config.json"],
    },
    modelPath: "/models/qwen3",
    readiness: "verified",
    speaker: "Ryan",
    language: "English",
    instruct: "",
    temperature: 0.9,
    topK: 50,
    maxNewTokens: 320,
    seed: null as number | null,
    referenceAudioName: "",
    referenceAudioDurationSec: null,
    referenceAudioBase64: null,
    referenceAudioSignature: "",
    referenceText: "",
    available: true,
    profiles: [],
    profileSetup: null,
    setup: null,
    setupBusy: false,
    downloadBusy: false,
    downloadProgress: null,
    error: null,
    setProfileRepo: vi.fn(),
    setModelPath: vi.fn(),
    setSpeaker: vi.fn(),
    setLanguage: vi.fn(),
    setInstruct: vi.fn(),
    setTemperature: vi.fn(),
    setTopK: vi.fn(),
    setMaxNewTokens: vi.fn(),
    setSeed: vi.fn(),
    setReferenceAudio: vi.fn(),
    setReferenceText: vi.fn(),
    refreshSetup: vi.fn().mockResolvedValue(undefined),
    downloadModel: vi.fn().mockResolvedValue(undefined),
    chooseModelPath: vi.fn().mockResolvedValue(undefined),
    clearError: vi.fn(),
  };
}

function audioPlayer() {
  let chunkCount = 0;
  // Like the real player, a reset or restored cache replaces the content.
  let contentEpoch = 0;
  const methods = {
    scheduleChunk: vi.fn(async (chunk: unknown) => {
      void chunk;
      chunkCount += 1;
    }),
    beginStream: vi.fn(),
    endStream: vi.fn(),
    getAudioChunkCount: vi.fn(() => chunkCount),
    getContentEpoch: vi.fn(() => contentEpoch),
    truncateAudioChunks: vi.fn((count: number) => { chunkCount = Math.max(0, count); }),
    reset: vi.fn(() => {
      chunkCount = 0;
      contentEpoch += 1;
    }),
    stopAll: vi.fn(),
  };
  return {
    player: {
      isPlaying: false,
      error: null,
      clock: new PlaybackClock(),
      getCurrentTime: () => 0,
      totalDuration: 0,
      playbackRate: 1,
      segments: [],
      activeSegmentId: null,
      ...methods,
    } as unknown as UseAudioPlayerReturn,
    methods,
  };
}

afterEach(() => {
  delete window.electron;
  vi.clearAllMocks();
});

describe("useQwen3LocalRuntime long-text batching", () => {
  it("generates a long Studio or Reader job as sequential IPC-safe requests", async () => {
    vi.mocked(useQwen3Runtime).mockReturnValue(runtimeSettings() as never);
    let emitAudioChunk: ((event: Record<string, unknown>) => void) | undefined;
    const generate = vi.fn(async (request: GenerateRequest) => {
      const audio = new Float32Array([0.1, -0.1]);
      emitAudioChunk?.({
        requestId: request.requestId,
        model: "qwen3",
        index: 0,
        total: 1,
        sampleRate: 24_000,
        sampleCount: audio.length,
        silenceAfterSamples: 0,
        audio: audio.buffer,
      });
      return {
        sampleRate: 24_000,
        modelRepo: String(request.payload?.modelRepo),
        durationSec: audio.length / 24_000,
        elapsedSec: 0.1,
        audioTransport: "websocket-binary" as const,
        audioChunkCount: 1,
        phaseTimingsSec: { inferenceSec: 0.1 },
      };
    });
    window.electron = {
      isElectron: true,
      platform: "darwin",
      arch: "arm64",
      localTts: {
        probe: vi.fn().mockResolvedValue({ ready: true, message: "ready", runtime: "rust" }),
        warm: vi.fn().mockResolvedValue({ warmed: true }),
        generate,
        cancel: vi.fn().mockResolvedValue({ cancelled: true }),
        subscribeProgress: vi.fn(() => () => undefined),
        subscribeAudioChunk: vi.fn((listener) => {
          emitAudioChunk = listener as (event: Record<string, unknown>) => void;
          return () => undefined;
        }),
      },
    } as never;
    const { player, methods } = audioPlayer();
    const text = `${"Reader sentence with a natural stopping point. ".repeat(500)}`;
    const setShowPlayer = vi.fn();
    const { result } = renderHook(() => useQwen3LocalRuntime({
      enabled: true,
      text,
      allowLongText: true,
      player,
      setShowPlayer,
    }));

    await waitFor(() => expect(result.current.canGenerate).toBe(true));
    act(() => result.current.handleGenerate());
    await waitFor(() => expect(result.current.isGenerating).toBe(false));

    expect(generate.mock.calls.length).toBeGreaterThan(1);
    const payloadTexts = generate.mock.calls.map(([request]) => String(request.payload?.text));
    expect(payloadTexts.join("")).toBe(text.trim());
    expect(payloadTexts.every((section) => (
      countUnicodeScalars(section) <= MAX_LOCAL_TTS_TEXT_LENGTH
    ))).toBe(true);
    const continuations = generate.mock.calls.map(([request]) => request.continuation);
    expect(new Set(continuations.map((continuation) => continuation?.jobId)).size).toBe(1);
    expect(continuations.map((continuation) => continuation?.sectionIndex))
      .toEqual(continuations.map((_, index) => index));
    expect(continuations.every((continuation) => continuation?.sectionCount === continuations.length)).toBe(true);
    expect(methods.beginStream).toHaveBeenCalledTimes(1);
    expect(methods.endStream).toHaveBeenCalledTimes(1);
    expect(methods.endStream).toHaveBeenCalledWith({ completed: true });
    expect(methods.scheduleChunk).toHaveBeenCalledTimes((generate.mock.calls.length * 2) - 1);
    const boundaryPauses = methods.scheduleChunk.mock.calls
      .map(([chunk]) => chunk as { audio: Float32Array; pauseAfterSec?: number; pauseKind?: string })
      .filter((chunk) => chunk.pauseKind === "sentence" && chunk.audio.length === 4_800);
    expect(boundaryPauses).toHaveLength(generate.mock.calls.length - 1);
    expect(boundaryPauses.every((chunk) => (
      chunk.pauseAfterSec === 0.2 && chunk.audio.every((sample) => sample === 0)
    ))).toBe(true);
    expect(result.current.generationProgress).toBe(100);
    expect(result.current.error).toBeNull();
  });

  it("maps each request's streamed text units onto the bridge's own split", async () => {
    vi.mocked(useQwen3Runtime).mockReturnValue({
      ...runtimeSettings(),
      instruct: "Whisper dramatically.",
      seed: 1234,
    } as never);
    let emitAudioChunk: ((event: Record<string, unknown>) => void) | undefined;
    const generate = vi.fn(async (request: GenerateRequest) => {
      // Stand in for Rust: trim the request, split it, and stream one chunk per unit.
      const units = buildQwen3TextUnits(String(request.payload?.text));
      units.forEach((_, unitIndex) => {
        const audio = new Float32Array([0.1, -0.1]);
        emitAudioChunk?.({
          requestId: request.requestId,
          model: "qwen3",
          index: unitIndex,
          total: 0,
          sampleRate: 24_000,
          sampleCount: audio.length,
          silenceAfterSamples: 0,
          textUnitIndex: unitIndex,
          textUnitTotal: units.length,
          audio: audio.buffer,
        });
      });
      return {
        sampleRate: 24_000,
        modelRepo: String(request.payload?.modelRepo),
        durationSec: 0.1,
        elapsedSec: 0.1,
        audioTransport: "websocket-binary" as const,
        audioChunkCount: units.length,
        phaseTimingsSec: { inferenceSec: 0.1 },
      };
    });
    window.electron = {
      isElectron: true,
      platform: "darwin",
      arch: "arm64",
      localTts: {
        probe: vi.fn().mockResolvedValue({ ready: true, message: "ready", runtime: "rust" }),
        warm: vi.fn().mockResolvedValue({ warmed: true }),
        generate,
        cancel: vi.fn().mockResolvedValue({ cancelled: true }),
        subscribeProgress: vi.fn(() => () => undefined),
        subscribeAudioChunk: vi.fn((listener) => {
          emitAudioChunk = listener as (event: Record<string, unknown>) => void;
          return () => undefined;
        }),
      },
    } as never;
    const { player, methods } = audioPlayer();
    // The second request starts with a space that IPC trims, which moves the
    // bridge's first window (see qwenChunking.test.ts).
    const filler = `${"Filler sentence for the reader. ".repeat(6)}\n`;
    const head = filler.repeat(Math.floor(MAX_LOCAL_TTS_TEXT_LENGTH / filler.length));
    const text = `${head}Intro. ${"a".repeat(49)},${"b".repeat(149)}.${" More text here.".repeat(20)}`;
    const setShowPlayer = vi.fn();
    const { result } = renderHook(() => useQwen3LocalRuntime({
      enabled: true,
      text,
      allowLongText: true,
      player,
      setShowPlayer,
    }));

    await waitFor(() => expect(result.current.canGenerate).toBe(true));
    act(() => result.current.handleGenerate());
    await waitFor(() => expect(result.current.isGenerating).toBe(false));

    expect(generate).toHaveBeenCalledTimes(2);
    for (const [request] of generate.mock.calls) {
      // 0.6B CustomVoice ignores instructions, so none is sent; the seed is.
      expect(request.payload).toEqual(expect.objectContaining({ instruct: "", seed: 1234 }));
    }
    const { units } = buildQwen3RequestPlan(text);
    const spoken = methods.scheduleChunk.mock.calls
      .map(([chunk]) => chunk as { audio: Float32Array; text: string; textStart: number; textEnd: number })
      .filter((chunk) => chunk.audio.length === 2);
    expect(spoken.map((chunk) => chunk.text)).toEqual(units.map((unit) => unit.text));
    expect(spoken.every((chunk) => text.slice(chunk.textStart, chunk.textEnd) === chunk.text)).toBe(true);
    expect(result.current.error).toBeNull();
  });

  it("puts out-of-order streamed audio back in order before the request settles", async () => {
    vi.mocked(useQwen3Runtime).mockReturnValue(runtimeSettings() as never);
    let emitAudioChunk: ((event: Record<string, unknown>) => void) | undefined;
    const firstAudio = new Float32Array([0.1, -0.1]);
    const secondAudio = new Float32Array([0.2, -0.2]);
    // Like the preload, the result follows every chunk of the request.
    let finishRequest!: () => void;
    const generate = vi.fn((request: GenerateRequest) => new Promise((resolve) => {
      finishRequest = () => resolve({
        sampleRate: 24_000,
        modelRepo: String(request.payload?.modelRepo),
        durationSec: (firstAudio.length + secondAudio.length) / 24_000,
        elapsedSec: 0.1,
        audioTransport: "websocket-binary" as const,
        audioChunkCount: 2,
        phaseTimingsSec: { inferenceSec: 0.1 },
      });
    }));
    window.electron = {
      isElectron: true,
      platform: "darwin",
      arch: "arm64",
      localTts: {
        probe: vi.fn().mockResolvedValue({ ready: true, message: "ready", runtime: "rust" }),
        warm: vi.fn().mockResolvedValue({ warmed: true }),
        generate,
        cancel: vi.fn().mockResolvedValue({ cancelled: true }),
        subscribeProgress: vi.fn(() => () => undefined),
        subscribeAudioChunk: vi.fn((listener) => {
          emitAudioChunk = listener as (event: Record<string, unknown>) => void;
          return () => undefined;
        }),
      },
    } as never;
    const { player, methods } = audioPlayer();
    const setShowPlayer = vi.fn();
    const { result } = renderHook(() => useQwen3LocalRuntime({
      enabled: true,
      text: "A Reader sentence that is long enough to synthesize.",
      allowLongText: true,
      player,
      setShowPlayer,
    }));

    await waitFor(() => expect(result.current.canGenerate).toBe(true));
    act(() => result.current.handleGenerate());
    await waitFor(() => expect(generate).toHaveBeenCalledTimes(1));
    await act(async () => { await Promise.resolve(); });
    const request = generate.mock.calls[0][0];
    act(() => {
      emitAudioChunk?.({
        requestId: request.requestId,
        model: "qwen3",
        index: 1,
        total: 2,
        sampleRate: 24_000,
        sampleCount: secondAudio.length,
        silenceAfterSamples: 0,
        audio: secondAudio.buffer,
      });
    });
    expect(methods.scheduleChunk).not.toHaveBeenCalled();
    act(() => {
      emitAudioChunk?.({
        requestId: request.requestId,
        model: "qwen3",
        index: 0,
        total: 2,
        sampleRate: 24_000,
        sampleCount: firstAudio.length,
        silenceAfterSamples: 0,
        audio: firstAudio.buffer,
      });
    });
    await waitFor(() => expect(methods.scheduleChunk).toHaveBeenCalledTimes(2));
    act(() => finishRequest());
    await waitFor(() => expect(result.current.isGenerating).toBe(false));

    const scheduledAudio = methods.scheduleChunk.mock.calls
      .map(([chunk]) => (chunk as { audio: Float32Array }).audio.buffer);
    expect(scheduledAudio).toEqual([firstAudio.buffer, secondAudio.buffer]);
    expect(methods.endStream).toHaveBeenCalledTimes(1);
    expect(result.current.error).toBeNull();
  });

  it("fails at once when a settled request is missing streamed audio", async () => {
    vi.mocked(useQwen3Runtime).mockReturnValue(runtimeSettings() as never);
    const generate = vi.fn(async (request: GenerateRequest) => ({
      sampleRate: 24_000,
      modelRepo: String(request.payload?.modelRepo),
      durationSec: 0.1,
      elapsedSec: 0.1,
      audioTransport: "websocket-binary" as const,
      audioChunkCount: 2,
      phaseTimingsSec: { inferenceSec: 0.1 },
    }));
    window.electron = {
      isElectron: true,
      platform: "darwin",
      arch: "arm64",
      localTts: {
        probe: vi.fn().mockResolvedValue({ ready: true, message: "ready", runtime: "rust" }),
        warm: vi.fn().mockResolvedValue({ warmed: true }),
        generate,
        cancel: vi.fn().mockResolvedValue({ cancelled: true }),
        subscribeProgress: vi.fn(() => () => undefined),
        subscribeAudioChunk: vi.fn(() => () => undefined),
      },
    } as never;
    const { player } = audioPlayer();
    const { result } = renderHook(() => useQwen3LocalRuntime({
      enabled: true,
      text: "A Reader sentence that is long enough to synthesize.",
      player,
      setShowPlayer: vi.fn(),
    }));
    await waitFor(() => expect(result.current.canGenerate).toBe(true));

    act(() => result.current.handleGenerate());

    await waitFor(() => expect(result.current.error).toBe("Generation returned incomplete streamed audio."));
    expect(result.current.isGenerating).toBe(false);
  });

  it("keeps completed sections playable when a later request fails", async () => {
    vi.mocked(useQwen3Runtime).mockReturnValue(runtimeSettings() as never);
    let emitAudioChunk: ((event: Record<string, unknown>) => void) | undefined;
    const generate = vi.fn(async (request: GenerateRequest) => {
      const audio = new Float32Array([0.25, -0.25]);
      emitAudioChunk?.({
        requestId: request.requestId,
        model: "qwen3",
        index: 0,
        total: 1,
        sampleRate: 24_000,
        sampleCount: audio.length,
        silenceAfterSamples: 0,
        audio: audio.buffer,
      });
      if (generate.mock.calls.length === 2) throw new Error("temporary model failure");
      return {
        sampleRate: 24_000,
        modelRepo: String(request.payload?.modelRepo),
        durationSec: audio.length / 24_000,
        elapsedSec: 0.1,
        audioTransport: "websocket-binary" as const,
        audioChunkCount: 1,
        phaseTimingsSec: { inferenceSec: 0.1 },
      };
    });
    window.electron = {
      isElectron: true,
      platform: "darwin",
      arch: "arm64",
      localTts: {
        probe: vi.fn().mockResolvedValue({ ready: true, message: "ready", runtime: "rust" }),
        warm: vi.fn().mockResolvedValue({ warmed: true }),
        generate,
        cancel: vi.fn().mockResolvedValue({ cancelled: true }),
        subscribeProgress: vi.fn(() => () => undefined),
        subscribeAudioChunk: vi.fn((listener) => {
          emitAudioChunk = listener as (event: Record<string, unknown>) => void;
          return () => undefined;
        }),
      },
    } as never;
    const { player, methods } = audioPlayer();
    const setShowPlayer = vi.fn();
    const { result } = renderHook(() => useQwen3LocalRuntime({
      enabled: true,
      text: "Reader section with natural punctuation. ".repeat(500),
      allowLongText: true,
      player,
      setShowPlayer,
    }));

    await waitFor(() => expect(result.current.canGenerate).toBe(true));
    act(() => result.current.handleGenerate());
    const resetCountAfterStart = methods.reset.mock.calls.length;
    await waitFor(() => expect(result.current.isGenerating).toBe(false));

    expect(generate).toHaveBeenCalledTimes(2);
    expect(methods.scheduleChunk).toHaveBeenCalledTimes(3);
    expect(methods.truncateAudioChunks).toHaveBeenCalledWith(2);
    expect(methods.getAudioChunkCount()).toBe(2);
    expect(methods.reset).toHaveBeenCalledTimes(resetCountAfterStart);
    expect(methods.endStream).toHaveBeenCalledTimes(1);
    expect(setShowPlayer).toHaveBeenCalledWith(true);
    expect(result.current.error).toMatch(/stopped at section 2 of .*temporary model failure/i);
    expect(result.current.stats.totalDuration).toBeGreaterThan(0);
  });

  it("uploads a voice-clone reference once per worker session and restores a lost cache", async () => {
    const settings = runtimeSettings();
    vi.mocked(useQwen3Runtime).mockReturnValue({
      ...settings,
      profile: {
        ...settings.profile,
        repo: "mlx-community/Qwen3-TTS-12Hz-0.6B-Base-6bit",
        mode: "voiceClone",
        label: "Qwen3 Voice Clone",
      },
      referenceAudioName: "reference.wav",
      referenceAudioBase64: "UklGRg==",
      referenceAudioSignature: "sha256-reference",
      referenceText: "These are the exact reference words.",
    } as never);
    let emitAudioChunk: ((event: Record<string, unknown>) => void) | undefined;
    const generate = vi.fn(async (request: GenerateRequest) => {
      if (generate.mock.calls.length === 2) {
        throw new Error("Qwen3 reference cache entry was not found; resend the reference WAV.");
      }
      const audio = new Float32Array([0.1, -0.1]);
      emitAudioChunk?.({
        requestId: request.requestId,
        model: "qwen3",
        index: 0,
        total: 1,
        sampleRate: 24_000,
        sampleCount: audio.length,
        silenceAfterSamples: 0,
        audio: audio.buffer,
      });
      return {
        sampleRate: 24_000,
        modelRepo: String(request.payload?.modelRepo),
        durationSec: audio.length / 24_000,
        elapsedSec: 0.1,
        audioTransport: "websocket-binary" as const,
        audioChunkCount: 1,
        phaseTimingsSec: { inferenceSec: 0.1 },
      };
    });
    window.electron = {
      isElectron: true,
      platform: "darwin",
      arch: "arm64",
      localTts: {
        probe: vi.fn().mockResolvedValue({ ready: true, message: "ready", runtime: "rust" }),
        warm: vi.fn().mockResolvedValue({ warmed: true }),
        generate,
        cancel: vi.fn().mockResolvedValue({ cancelled: true }),
        subscribeProgress: vi.fn(() => () => undefined),
        subscribeAudioChunk: vi.fn((listener) => {
          emitAudioChunk = listener as (event: Record<string, unknown>) => void;
          return () => undefined;
        }),
      },
    } as never;
    const { player, methods } = audioPlayer();
    const setShowPlayer = vi.fn();
    const { result } = renderHook(() => useQwen3LocalRuntime({
      enabled: true,
      text: "A voice-cloned Reader section with punctuation. ".repeat(500),
      allowLongText: true,
      player,
      setShowPlayer,
    }));

    await waitFor(() => expect(result.current.canGenerate).toBe(true));
    act(() => result.current.handleGenerate());
    await waitFor(() => expect(
      generate.mock.calls.length > 1 || result.current.error !== null,
    ).toBe(true));
    expect(result.current.error).toBeNull();
    await waitFor(() => expect(result.current.isGenerating).toBe(false));
    expect(generate.mock.calls.length).toBeGreaterThan(1);

    const firstPayload = generate.mock.calls[0][0].payload ?? {};
    const cacheKey = firstPayload.referenceCacheKey;
    expect(firstPayload).toMatchObject({
      referenceAudioBase64: "UklGRg==",
      referenceText: "These are the exact reference words.",
      referenceCacheKey: expect.any(String),
    });
    expect(generate.mock.calls[1][0].payload).toMatchObject({ referenceCacheKey: cacheKey });
    expect(generate.mock.calls[1][0].payload).not.toHaveProperty("referenceAudioBase64");
    expect(generate.mock.calls[2][0].payload).toMatchObject({
      referenceAudioBase64: "UklGRg==",
      referenceText: "These are the exact reference words.",
      referenceCacheKey: cacheKey,
    });
    expect(generate.mock.calls[2][0].continuation).toEqual(generate.mock.calls[1][0].continuation);
    for (const [request] of generate.mock.calls.slice(3)) {
      expect(request.payload).toMatchObject({ referenceCacheKey: cacheKey });
      expect(request.payload).not.toHaveProperty("referenceAudioBase64");
      expect(request.payload).not.toHaveProperty("referenceText");
    }
    expect(methods.truncateAudioChunks).toHaveBeenCalled();
  });

  it("keeps the single-request limit for callers that opt out of batching", async () => {
    vi.mocked(useQwen3Runtime).mockReturnValue(runtimeSettings() as never);
    window.electron = {
      isElectron: true,
      platform: "darwin",
      arch: "arm64",
      localTts: {
        probe: vi.fn().mockResolvedValue({ ready: true, message: "ready", runtime: "rust" }),
        warm: vi.fn().mockResolvedValue({ warmed: true }),
        cancel: vi.fn().mockResolvedValue({ cancelled: true }),
        subscribeProgress: vi.fn(() => () => undefined),
        subscribeAudioChunk: vi.fn(() => () => undefined),
      },
    } as never;
    const { player } = audioPlayer();
    const setShowPlayer = vi.fn();
    const { result } = renderHook(() => useQwen3LocalRuntime({
      enabled: true,
      text: "x".repeat(MAX_LOCAL_TTS_TEXT_LENGTH + 1),
      player,
      setShowPlayer,
    }));

    await waitFor(() => expect(result.current.error).toContain("at most 6,000 characters"));
    expect(result.current.canGenerate).toBe(false);
  });

  it("applies the 6,000-character ceiling as Unicode scalars", async () => {
    vi.mocked(useQwen3Runtime).mockReturnValue(runtimeSettings() as never);
    window.electron = {
      isElectron: true,
      platform: "darwin",
      arch: "arm64",
      localTts: {
        probe: vi.fn().mockResolvedValue({ ready: true, message: "ready", runtime: "rust" }),
        warm: vi.fn().mockResolvedValue({ warmed: true }),
        cancel: vi.fn().mockResolvedValue({ cancelled: true }),
        subscribeProgress: vi.fn(() => () => undefined),
        subscribeAudioChunk: vi.fn(() => () => undefined),
      },
    } as never;
    const { player } = audioPlayer();
    const setShowPlayer = vi.fn();
    const { result, rerender } = renderHook(({ text }) => useQwen3LocalRuntime({
      enabled: true,
      text,
      player,
      setShowPlayer,
    }), { initialProps: { text: "🙂".repeat(MAX_LOCAL_TTS_TEXT_LENGTH) } });

    await waitFor(() => expect(result.current.canGenerate).toBe(true));
    rerender({ text: "🙂".repeat(MAX_LOCAL_TTS_TEXT_LENGTH + 1) });
    await waitFor(() => expect(result.current.canGenerate).toBe(false));
    expect(result.current.error).toContain("at most 6,000 characters");
  });

  it("requires a non-empty VoiceDesign description before generating", async () => {
    let settings = {
      ...runtimeSettings(),
      profile: {
        ...runtimeSettings().profile,
        repo: "mlx-community/Qwen3-TTS-12Hz-1.7B-VoiceDesign-6bit",
        mode: "voiceDesign",
        label: "Qwen3 VoiceDesign",
      },
      instruct: "   ",
    };
    vi.mocked(useQwen3Runtime).mockImplementation(() => settings as never);
    window.electron = {
      isElectron: true,
      platform: "darwin",
      arch: "arm64",
      localTts: {
        probe: vi.fn().mockResolvedValue({ ready: true, message: "ready", runtime: "rust" }),
        warm: vi.fn().mockResolvedValue({ warmed: true }),
        cancel: vi.fn().mockResolvedValue({ cancelled: true }),
        subscribeProgress: vi.fn(() => () => undefined),
        subscribeAudioChunk: vi.fn(() => () => undefined),
      },
    } as never;
    const { player } = audioPlayer();
    const { result, rerender } = renderHook(() => useQwen3LocalRuntime({
      enabled: true,
      text: "A sentence long enough to synthesize.",
      player,
      setShowPlayer: vi.fn(),
    }));

    await waitFor(() => expect(result.current.error).toBe("Describe the VoiceDesign voice before generating."));
    expect(result.current.canGenerate).toBe(false);

    settings = { ...settings, instruct: "A calm documentary narrator." };
    rerender();
    await waitFor(() => expect(result.current.canGenerate).toBe(true));
  });

  it("stops finished playback without clearing generated Qwen audio", async () => {
    vi.mocked(useQwen3Runtime).mockReturnValue(runtimeSettings() as never);
    let emitAudioChunk: ((event: Record<string, unknown>) => void) | undefined;
    let resolveGenerate: ((value: {
      sampleRate: number;
      modelRepo: string;
      durationSec: number;
      elapsedSec: number;
      audioTransport: "websocket-binary";
      audioChunkCount: number;
      phaseTimingsSec: { inferenceSec: number };
    }) => void) | undefined;
    const cancel = vi.fn().mockResolvedValue({ cancelled: true });
    const generate = vi.fn((request: GenerateRequest) => {
      void request;
      return new Promise<{
        sampleRate: number;
        modelRepo: string;
        durationSec: number;
        elapsedSec: number;
        audioTransport: "websocket-binary";
        audioChunkCount: number;
        phaseTimingsSec: { inferenceSec: number };
      }>((resolve) => {
        resolveGenerate = resolve;
      });
    });
    const audio = new Float32Array([0.1, -0.1]);
    const generated = {
        sampleRate: 24_000,
        modelRepo: runtimeSettings().profile.repo,
        durationSec: audio.length / 24_000,
        elapsedSec: 0.1,
        audioTransport: "websocket-binary" as const,
        audioChunkCount: 1,
        phaseTimingsSec: { inferenceSec: 0.1 },
    };
    window.electron = {
      isElectron: true,
      platform: "darwin",
      arch: "arm64",
      localTts: {
        probe: vi.fn().mockResolvedValue({ ready: true, message: "ready", runtime: "rust" }),
        warm: vi.fn().mockResolvedValue({ warmed: true }),
        generate,
        cancel,
        subscribeProgress: vi.fn(() => () => undefined),
        subscribeAudioChunk: vi.fn((listener) => {
          emitAudioChunk = listener as (event: Record<string, unknown>) => void;
          return () => undefined;
        }),
      },
    } as never;
    const { player, methods } = audioPlayer();
    const setShowPlayer = vi.fn();
    const { result } = renderHook(() => useQwen3LocalRuntime({
      enabled: true,
      text: "A completed Qwen sentence remains playable after Stop.",
      player,
      setShowPlayer,
    }));

    await waitFor(() => expect(result.current.canGenerate).toBe(true));
    act(() => result.current.handleGenerate());
    await waitFor(() => expect(generate).toHaveBeenCalledTimes(1));
    await act(async () => { await Promise.resolve(); });
    const request = generate.mock.calls[0][0];
    act(() => {
      emitAudioChunk!({
        requestId: request.requestId,
        model: "qwen3",
        index: 0,
        total: 1,
        sampleRate: 24_000,
        sampleCount: audio.length,
        silenceAfterSamples: 0,
        audio: audio.buffer,
      });
    });
    expect(methods.scheduleChunk).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(methods.getAudioChunkCount()).toBe(1));
    await act(async () => {
      resolveGenerate?.(generated);
    });
    await waitFor(() => expect(result.current.isGenerating).toBe(false));
    expect(methods.getAudioChunkCount()).toBe(1);
    const resetCount = methods.reset.mock.calls.length;
    const endStreamCount = methods.endStream.mock.calls.length;

    act(() => result.current.handleStop());

    expect(methods.stopAll).toHaveBeenCalledTimes(1);
    expect(methods.reset).toHaveBeenCalledTimes(resetCount);
    expect(methods.endStream).toHaveBeenCalledTimes(endStreamCount);
    expect(methods.getAudioChunkCount()).toBe(1);
    expect(cancel).not.toHaveBeenCalled();
  });

  it("soft-cancels Qwen generation while retaining delivered audio chunks", async () => {
    vi.mocked(useQwen3Runtime).mockReturnValue(runtimeSettings() as never);
    let emitAudioChunk: ((event: Record<string, unknown>) => void) | undefined;
    let rejectGenerate: ((error: Error) => void) | undefined;
    const generate = vi.fn((request: GenerateRequest) => {
      void request;
      return new Promise<never>((_resolve, reject) => {
        rejectGenerate = reject;
      });
    });
    const cancel = vi.fn(async () => {
      rejectGenerate?.(new Error("Generation cancelled."));
      return { cancelled: true };
    });
    window.electron = {
      isElectron: true,
      platform: "darwin",
      arch: "arm64",
      localTts: {
        probe: vi.fn().mockResolvedValue({ ready: true, message: "ready", runtime: "rust" }),
        warm: vi.fn().mockResolvedValue({ warmed: true }),
        generate,
        cancel,
        subscribeProgress: vi.fn(() => () => undefined),
        subscribeAudioChunk: vi.fn((listener) => {
          emitAudioChunk = listener as (event: Record<string, unknown>) => void;
          return () => undefined;
        }),
      },
    } as never;
    const { player, methods } = audioPlayer();
    const setShowPlayer = vi.fn();
    const { result } = renderHook(() => useQwen3LocalRuntime({
      enabled: true,
      text: "A Qwen generation with an early playable audio chunk.",
      player,
      setShowPlayer,
    }));

    await waitFor(() => expect(result.current.canGenerate).toBe(true));
    act(() => result.current.handleGenerate());
    await waitFor(() => expect(generate).toHaveBeenCalledTimes(1));
    await act(async () => { await Promise.resolve(); });
    const request = generate.mock.calls[0][0];
    const audio = new Float32Array([0.2, -0.2]);
    act(() => {
      emitAudioChunk!({
        requestId: request.requestId,
        model: "qwen3",
        index: 0,
        total: 2,
        sampleRate: 24_000,
        sampleCount: audio.length,
        silenceAfterSamples: 0,
        audio: audio.buffer,
      });
    });
    expect(methods.scheduleChunk).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(methods.getAudioChunkCount()).toBe(1));
    const resetCount = methods.reset.mock.calls.length;

    act(() => result.current.handleStop());
    await waitFor(() => expect(cancel).toHaveBeenCalledTimes(1));

    expect(result.current.isGenerating).toBe(false);
    expect(methods.endStream).toHaveBeenCalledTimes(1);
    expect(methods.reset).toHaveBeenCalledTimes(resetCount);
    expect(methods.getAudioChunkCount()).toBe(1);
    expect(result.current.error).toBeNull();
  });

});

describe("useQwen3LocalRuntime identity", () => {
  it("keeps its identity across renders until its state changes", () => {
    let settings = runtimeSettings();
    vi.mocked(useQwen3Runtime).mockImplementation(() => settings as never);
    const { player } = audioPlayer();
    const setShowPlayer = vi.fn();
    const { result, rerender } = renderHook(() => useQwen3LocalRuntime({
      enabled: false,
      text: "A local sentence with enough text.",
      player,
      setShowPlayer,
    }));
    const initial = result.current;

    rerender();
    expect(result.current).toBe(initial);

    settings = { ...settings, error: "Qwen3 setup failed." as never };
    rerender();
    expect(result.current).not.toBe(initial);
    expect(result.current.error).toBe("Qwen3 setup failed.");
    expect(result.current.handleStop).toBe(initial.handleStop);
    expect(result.current.resetGeneratedAudio).toBe(initial.resetGeneratedAudio);
  });
});

describe("useQwen3LocalRuntime settings changes", () => {
  /** A bridge whose generate call streams one chunk and then resolves. */
  function installCompletingBridge() {
    let emitAudioChunk: ((event: Record<string, unknown>) => void) | undefined;
    const generate = vi.fn(async (request: GenerateRequest) => {
      const audio = new Float32Array([0.1, -0.1]);
      emitAudioChunk?.({
        requestId: request.requestId,
        model: "qwen3",
        index: 0,
        total: 1,
        sampleRate: 24_000,
        sampleCount: audio.length,
        silenceAfterSamples: 0,
        audio: audio.buffer,
      });
      return {
        sampleRate: 24_000,
        modelRepo: String(request.payload?.modelRepo),
        durationSec: audio.length / 24_000,
        elapsedSec: 0.1,
        audioTransport: "websocket-binary" as const,
        audioChunkCount: 1,
        phaseTimingsSec: {},
      };
    });
    window.electron = {
      isElectron: true,
      platform: "darwin",
      arch: "arm64",
      localTts: {
        probe: vi.fn().mockResolvedValue({ ready: true, message: "ready", runtime: "rust" }),
        warm: vi.fn().mockResolvedValue({ warmed: true }),
        generate,
        cancel: vi.fn().mockResolvedValue({ cancelled: true }),
        subscribeProgress: vi.fn(() => () => undefined),
        subscribeAudioChunk: vi.fn((listener) => {
          emitAudioChunk = listener as (event: Record<string, unknown>) => void;
          return () => undefined;
        }),
      },
    } as never;
    return { generate };
  }

  it("leaves another engine's audio in the shared player when Qwen3 is not in use", () => {
    let settings = runtimeSettings();
    vi.mocked(useQwen3Runtime).mockImplementation(() => settings as never);
    const { player, methods } = audioPlayer();
    const setShowPlayer = vi.fn();
    const { rerender } = renderHook(() => useQwen3LocalRuntime({
      enabled: false,
      text: "A local sentence with enough text.",
      player,
      setShowPlayer,
    }));
    methods.reset.mockClear();
    setShowPlayer.mockClear();

    // Edited from the Qwen3 setup page while Studio plays Kokoro audio.
    settings = { ...settings, speaker: "Vivian" };
    rerender();

    expect(methods.reset).not.toHaveBeenCalled();
    expect(setShowPlayer).not.toHaveBeenCalled();
  });

  it("clears the player when an audible setting changes while Qwen3 drives the surface", () => {
    let settings = runtimeSettings();
    vi.mocked(useQwen3Runtime).mockImplementation(() => settings as never);
    const { player, methods } = audioPlayer();
    const setShowPlayer = vi.fn();
    const { rerender } = renderHook(() => useQwen3LocalRuntime({
      enabled: true,
      text: "A local sentence with enough text.",
      player,
      setShowPlayer,
    }));
    methods.reset.mockClear();
    setShowPlayer.mockClear();

    // Restored Reader audio is not generated here, but it is still Qwen3's.
    rerender();
    expect(methods.reset).not.toHaveBeenCalled();
    settings = { ...settings, temperature: 0.4 };
    rerender();

    expect(methods.reset).toHaveBeenCalledTimes(1);
    expect(setShowPlayer).toHaveBeenCalledWith(false);
  });

  it("clears audio it generated after its surface moved off Qwen3", async () => {
    let settings = runtimeSettings();
    vi.mocked(useQwen3Runtime).mockImplementation(() => settings as never);
    const { generate } = installCompletingBridge();
    const { player, methods } = audioPlayer();
    const setShowPlayer = vi.fn();
    let enabled = true;
    const { result, rerender } = renderHook(() => useQwen3LocalRuntime({
      enabled,
      text: "A Qwen generation that finishes before the settings change.",
      player,
      setShowPlayer,
    }));

    await waitFor(() => expect(result.current.canGenerate).toBe(true));
    act(() => result.current.handleGenerate());
    await waitFor(() => expect(generate).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(result.current.isGenerating).toBe(false));
    expect(methods.getAudioChunkCount()).toBe(1);

    // Opening the Qwen3 setup page leaves Studio's Qwen3 audio in the player.
    enabled = false;
    rerender();
    methods.reset.mockClear();
    setShowPlayer.mockClear();
    settings = { ...settings, seed: 7 };
    rerender();

    expect(methods.reset).toHaveBeenCalledTimes(1);
    expect(methods.getAudioChunkCount()).toBe(0);
    expect(setShowPlayer).toHaveBeenCalledWith(false);
  });

  it("stops claiming its audio once another engine replaced it", async () => {
    let settings = runtimeSettings();
    vi.mocked(useQwen3Runtime).mockImplementation(() => settings as never);
    const { generate } = installCompletingBridge();
    const { player, methods } = audioPlayer();
    const setShowPlayer = vi.fn();
    let enabled = true;
    const { result, rerender } = renderHook(() => useQwen3LocalRuntime({
      enabled,
      text: "A Qwen generation that another engine later replaces.",
      player,
      setShowPlayer,
    }));

    await waitFor(() => expect(result.current.canGenerate).toBe(true));
    act(() => result.current.handleGenerate());
    await waitFor(() => expect(generate).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(result.current.isGenerating).toBe(false));

    enabled = false;
    rerender();
    // Kokoro takes over the shared player and starts its own audio.
    act(() => player.reset());
    void player.scheduleChunk({ audio: new Float32Array(2), samplingRate: 24_000 });
    methods.reset.mockClear();
    setShowPlayer.mockClear();
    settings = { ...settings, speaker: "Serena" };
    rerender();

    expect(methods.reset).not.toHaveBeenCalled();
    expect(methods.getAudioChunkCount()).toBe(1);
    expect(setShowPlayer).not.toHaveBeenCalled();
  });

  it("retires a running generation's busy state and error with the settings it used", async () => {
    let settings = runtimeSettings();
    vi.mocked(useQwen3Runtime).mockImplementation(() => settings as never);
    const generate = vi.fn(() => new Promise<never>(() => undefined));
    const cancel = vi.fn().mockResolvedValue({ cancelled: true });
    window.electron = {
      isElectron: true,
      platform: "darwin",
      arch: "arm64",
      localTts: {
        probe: vi.fn().mockResolvedValue({ ready: true, message: "ready", runtime: "rust" }),
        warm: vi.fn().mockResolvedValue({ warmed: true }),
        generate,
        cancel,
        subscribeProgress: vi.fn(() => () => undefined),
        subscribeAudioChunk: vi.fn(() => () => undefined),
      },
    } as never;
    const { player } = audioPlayer();
    const { result, rerender } = renderHook(() => useQwen3LocalRuntime({
      enabled: true,
      text: "A Qwen generation that is still running when the voice changes.",
      player,
      setShowPlayer: vi.fn(),
    }));

    await waitFor(() => expect(result.current.canGenerate).toBe(true));
    act(() => result.current.handleGenerate());
    await waitFor(() => expect(generate).toHaveBeenCalledTimes(1));
    expect(result.current.isGenerating).toBe(true);

    settings = { ...settings, language: "German" };
    rerender();

    expect(result.current.isGenerating).toBe(false);
    expect(result.current.error).toBeNull();
    expect(cancel).toHaveBeenCalledTimes(1);
  });
});

describe("useQwen3LocalRuntime runtime probe", () => {
  function install(probe: ReturnType<typeof vi.fn>) {
    const settings = runtimeSettings();
    vi.mocked(useQwen3Runtime).mockReturnValue(settings as never);
    window.electron = {
      isElectron: true,
      platform: "darwin",
      arch: "arm64",
      localTts: {
        probe,
        warm: vi.fn().mockResolvedValue({ warmed: true }),
        generate: vi.fn(),
        cancel: vi.fn().mockResolvedValue({ cancelled: true }),
        subscribeProgress: vi.fn(() => () => undefined),
        subscribeAudioChunk: vi.fn(() => () => undefined),
      },
    } as never;
    return settings;
  }

  function render(enabled: boolean) {
    const { player } = audioPlayer();
    return renderHook((props: { enabled: boolean }) => useQwen3LocalRuntime({
      enabled: props.enabled,
      text: "Probe me.",
      player,
      setShowPlayer: vi.fn(),
    }), { initialProps: { enabled } });
  }

  it("probes once when enabled, loading until the probe settles, and leaves the model inventory to the provider", async () => {
    let finishProbe!: (value: unknown) => void;
    const probe = vi.fn(() => new Promise((resolve) => { finishProbe = resolve; }));
    const settings = install(probe);

    const { result } = render(true);
    expect(result.current.modelState.loading).toBe(true);
    expect(probe).toHaveBeenCalledTimes(1);

    await act(async () => finishProbe({ ready: true, message: "ready", runtime: "rust" }));
    await waitFor(() => expect(result.current.modelState.loading).toBe(false));
    expect(result.current.modelState.ready).toBe(true);
    expect(probe).toHaveBeenCalledTimes(1);
    expect(settings.refreshSetup).not.toHaveBeenCalled();
  });

  it("probes nothing and loads nothing while disabled", () => {
    const probe = vi.fn().mockResolvedValue({ ready: true, message: "ready", runtime: "rust" });
    install(probe);
    const { result } = render(false);
    expect(probe).not.toHaveBeenCalled();
    expect(result.current.modelState.loading).toBe(false);
  });

  it("surfaces a probe that reports an unready runtime or fails, and retries both reads on request", async () => {
    const probe = vi.fn()
      .mockResolvedValueOnce({ ready: false, message: "No GPU", runtime: "rust" })
      .mockRejectedValueOnce(new Error("bridge down"));
    const settings = install(probe);

    const { result } = render(true);
    await waitFor(() => expect(result.current.modelState.error).toBe("No GPU"));

    act(() => result.current.retryLoad());
    expect(result.current.modelState.loading).toBe(true);
    await waitFor(() => expect(result.current.modelState.error).toBe("bridge down"));
    expect(result.current.modelState.loading).toBe(false);
    expect(probe).toHaveBeenCalledTimes(2);
    expect(settings.refreshSetup).toHaveBeenCalledTimes(1);
  });

  it("drops an in-flight probe when disabled and probes again when re-enabled", async () => {
    const probe = vi.fn().mockResolvedValue({ ready: true, message: "ready", runtime: "rust" });
    install(probe);
    const { result, rerender } = render(true);
    await waitFor(() => expect(result.current.modelState.ready).toBe(true));

    rerender({ enabled: false });
    expect(result.current.modelState.loading).toBe(false);
    rerender({ enabled: true });
    expect(result.current.modelState.loading).toBe(true);
    await waitFor(() => expect(result.current.modelState.loading).toBe(false));
    expect(probe).toHaveBeenCalledTimes(2);
  });
});

describe("useQwen3LocalRuntime keep-warm lease", () => {
  function install(settingsOverrides: Record<string, unknown> = {}) {
    const release = vi.fn();
    const keepWarm = vi.fn(() => release);
    vi.mocked(useQwen3Runtime).mockReturnValue({ ...runtimeSettings(), ...settingsOverrides } as never);
    window.electron = {
      isElectron: true,
      platform: "darwin",
      arch: "arm64",
      localTts: {
        probe: vi.fn().mockResolvedValue({ ready: true, message: "ready", runtime: "rust" }),
        warm: vi.fn().mockResolvedValue({ warmed: true }),
        keepWarm,
        generate: vi.fn(),
        cancel: vi.fn().mockResolvedValue({ cancelled: true }),
        subscribeProgress: vi.fn(() => () => undefined),
        subscribeAudioChunk: vi.fn(() => () => undefined),
      },
    } as never;
    return { keepWarm, release };
  }

  function render(options: { enabled: boolean; retain?: boolean }) {
    const { player } = audioPlayer();
    return renderHook((props: { enabled: boolean; retain?: boolean }) => useQwen3LocalRuntime({
      ...props,
      text: "Keep me warm.",
      player,
      setShowPlayer: vi.fn(),
    }), { initialProps: options });
  }

  it("holds a lease on the selected model and releases it when the model is deselected", () => {
    const { keepWarm, release } = install();
    const { rerender, unmount } = render({ enabled: true });

    expect(keepWarm).toHaveBeenCalledExactlyOnceWith({
      model: "qwen3",
      modelRepo: "mlx-community/Qwen3-TTS-12Hz-0.6B-CustomVoice-6bit",
      modelPath: "/models/qwen3",
      mode: "customVoice",
    });
    // Re-rendering with the same selection keeps the one lease.
    rerender({ enabled: true });
    expect(keepWarm).toHaveBeenCalledTimes(1);
    expect(release).not.toHaveBeenCalled();

    rerender({ enabled: false });
    expect(release).toHaveBeenCalledTimes(1);
    unmount();
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("keeps the lease while another surface still selects the model", () => {
    const { keepWarm, release } = install();
    const { rerender } = render({ enabled: true, retain: true });

    rerender({ enabled: false, retain: true });
    expect(keepWarm).toHaveBeenCalledTimes(1);
    expect(release).not.toHaveBeenCalled();

    rerender({ enabled: false, retain: false });
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("holds no lease on a model that is not on disk", () => {
    const { keepWarm } = install({ readiness: "missing" });
    render({ enabled: true });
    expect(keepWarm).not.toHaveBeenCalled();

    const blank = install({ modelPath: "  " });
    render({ enabled: true });
    expect(blank.keepWarm).not.toHaveBeenCalled();
  });

  it("moves the lease when the model folder changes", () => {
    const { keepWarm, release } = install();
    const { rerender } = render({ enabled: true });
    vi.mocked(useQwen3Runtime).mockReturnValue({ ...runtimeSettings(), modelPath: "/models/other" } as never);

    rerender({ enabled: true });

    expect(release).toHaveBeenCalledTimes(1);
    expect(keepWarm).toHaveBeenLastCalledWith(expect.objectContaining({ modelPath: "/models/other" }));
  });

  it("runs without leases where the bridge has none", () => {
    install();
    delete (window.electron!.localTts as { keepWarm?: unknown }).keepWarm;
    expect(() => render({ enabled: true })).not.toThrow();
  });
});
