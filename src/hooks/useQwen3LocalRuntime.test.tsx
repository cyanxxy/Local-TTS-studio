import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MAX_LOCAL_TTS_TEXT_LENGTH,
  countUnicodeScalars,
} from "../../electron/localTtsLimits";
import { useQwen3Runtime } from "../contexts/Qwen3RuntimeContext";
import type { UseAudioPlayerReturn } from "./useAudioPlayer";
import { useQwen3LocalRuntime } from "./useQwen3LocalRuntime";

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
    maxNewTokens: 1_536,
    referenceAudioName: "",
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
  const methods = {
    scheduleChunk: vi.fn(async (chunk: unknown) => {
      void chunk;
      chunkCount += 1;
    }),
    beginStream: vi.fn(),
    endStream: vi.fn(),
    getAudioChunkCount: vi.fn(() => chunkCount),
    truncateAudioChunks: vi.fn((count: number) => { chunkCount = Math.max(0, count); }),
    reset: vi.fn(() => { chunkCount = 0; }),
    stopAll: vi.fn(),
  };
  return {
    player: {
      isPlaying: false,
      error: null,
      currentTime: 0,
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

  it("clears generated playback when an audible Qwen setting changes", () => {
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

    settings = { ...settings, speaker: "Vivian" };
    rerender();

    expect(methods.reset).toHaveBeenCalledTimes(1);
    expect(setShowPlayer).toHaveBeenCalledWith(false);
  });
});
