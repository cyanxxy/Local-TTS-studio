import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState, type ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LocalRuntimePage } from "./LocalRuntimePage";
import type {
  LocalTtsAudioChunkEvent,
  LocalTtsCacheInfo,
  LocalTtsGenerateResult,
  LocalTtsModel,
  LocalTtsProgressEvent,
  LocalTtsProbeResult,
} from "../electron";

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const baseProbe: LocalTtsProbeResult = {
  ready: true,
  message: "Qwen3-TTS Rust runtime is ready.",
  runtime: "rust",
  package: "qwen_tts",
  packageVersion: "0.1.1",
  recommendedModelRepo: "Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice",
  recommendedDeviceMap: "cpu",
  recommendedDtype: "float32",
  recommendedAttention: "eager",
  warnings: ["Rust Qwen3 currently uses Candle CPU execution."],
};

const baseCacheInfo: LocalTtsCacheInfo = {
  path: "/cache/qwen3",
  exists: true,
  sizeBytes: 2048,
};

const baseGenerateResult: LocalTtsGenerateResult = {
  audioTransport: "websocket-binary",
  audioChunkCount: 1,
  sampleRate: 24_000,
  modelRepo: "Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice",
  durationSec: 1.25,
  elapsedSec: 0.42,
  phaseTimingsSec: {
    modelLoadSec: 0.01,
    inferenceSec: 0.39,
    outputEncodingSec: 0.02,
  },
};

class MockAudioBuffer {
  private readonly channelData: Float32Array;

  constructor(length: number) {
    this.channelData = new Float32Array(length);
  }

  getChannelData(): Float32Array {
    return this.channelData;
  }
}

class MockAudioBufferSourceNode {
  public buffer: MockAudioBuffer | null = null;
  public playbackRate = { value: 1 };
  public onended: (() => void) | null = null;

  connect(): void {}

  disconnect(): void {}

  start(): void {}

  stop(): void {}
}

class MockAudioContext {
  public currentTime = 0;
  public state: "running" | "suspended" | "closed" = "suspended";
  public readonly destination = {};
  public readonly resume = vi.fn(async () => {
    this.state = "running";
  });
  public readonly suspend = vi.fn(async () => {
    this.state = "suspended";
  });
  public readonly close = vi.fn(async () => {
    this.state = "closed";
  });

  createBuffer(_channels: number, length: number): MockAudioBuffer {
    return new MockAudioBuffer(length);
  }

  createBufferSource(): MockAudioBufferSourceNode {
    return new MockAudioBufferSourceNode();
  }
}

function getRuntimePageProps(model: LocalTtsModel): ComponentProps<typeof LocalRuntimePage> {
  if (model === "neutts") {
    return {
      model,
      name: "NeuTTS Nano",
      releaseDate: "2026-02-12",
      params: "~120M",
      highlights: ["Rust local bridge"],
      links: [{ label: "HF Model", href: "https://huggingface.co/neuphonic/neutts-nano" }],
    };
  }

  return {
    model,
    name: "Qwen3-TTS",
    releaseDate: "2026-01-29",
    params: "0.6B / 1.7B",
    highlights: ["Rust local bridge"],
    links: [{ label: "HF Model", href: "https://huggingface.co/Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice" }],
  };
}

function renderPage(overrides: Partial<ComponentProps<typeof LocalRuntimePage>> = {}) {
  return render(
    <LocalRuntimePage
      {...getRuntimePageProps("qwen3")}
      {...overrides}
    />,
  );
}

function LocalRuntimeTabsHarness({ initialModel }: { initialModel: LocalTtsModel }) {
  const [activeTab, setActiveTab] = useState<LocalTtsModel | "studio">(initialModel);
  const [visitedTabs, setVisitedTabs] = useState<Set<LocalTtsModel>>(() => new Set([initialModel]));
  const switchTab = (tab: LocalTtsModel | "studio") => {
    if (tab !== "studio") {
      setVisitedTabs((prev) => {
        if (prev.has(tab)) return prev;
        const next = new Set(prev);
        next.add(tab);
        return next;
      });
    }
    setActiveTab(tab);
  };

  return (
    <div>
      <nav aria-label="Test tabs">
        <button type="button" onClick={() => switchTab("studio")}>Studio</button>
        <button type="button" onClick={() => switchTab("neutts")}>NeuTTS</button>
        <button type="button" onClick={() => switchTab("qwen3")}>Qwen3</button>
      </nav>
      {activeTab === "studio" && <div>Studio tab content</div>}
      {(["neutts", "qwen3"] as const)
        .filter((model) => visitedTabs.has(model))
        .map((model) => (
          <section key={model} hidden={activeTab !== model} aria-hidden={activeTab !== model}>
            <LocalRuntimePage {...getRuntimePageProps(model)} />
          </section>
        ))}
    </div>
  );
}

async function emitProgress(listener: ((event: LocalTtsProgressEvent) => void) | null, event: LocalTtsProgressEvent) {
  await act(async () => {
    listener?.(event);
    await Promise.resolve();
  });
}

async function emitAudioChunk(
  listener: ((event: LocalTtsAudioChunkEvent) => void) | null,
  event: LocalTtsAudioChunkEvent,
) {
  await act(async () => {
    listener?.(event);
    await Promise.resolve();
  });
}

async function emitGeneratedAudioChunk(
  listener: ((event: LocalTtsAudioChunkEvent) => void) | null,
  requestId: string,
  model: LocalTtsModel,
  sampleRate = 24_000,
) {
  const audioBuffer = new ArrayBuffer(2 * Float32Array.BYTES_PER_ELEMENT);
  new Float32Array(audioBuffer).set([0.25, -0.25]);
  await emitAudioChunk(listener, {
    requestId,
    model,
    index: 0,
    total: 1,
    sampleRate,
    sampleCount: 2,
    silenceAfterSamples: 0,
    audio: audioBuffer,
  });
}

describe("LocalRuntimePage", () => {
  const probe = vi.fn();
  const generate = vi.fn();
  const cancel = vi.fn();
  const getCacheInfo = vi.fn();
  const clearCache = vi.fn();
  const subscribeProgress = vi.fn();
  const subscribeAudioChunk = vi.fn();
  let progressListener: ((event: LocalTtsProgressEvent) => void) | null = null;
  let audioChunkListener: ((event: LocalTtsAudioChunkEvent) => void) | null = null;

  beforeEach(() => {
    probe.mockReset();
    generate.mockReset();
    cancel.mockReset();
    getCacheInfo.mockReset();
    clearCache.mockReset();
    subscribeProgress.mockReset();
    subscribeAudioChunk.mockReset();
    progressListener = null;
    audioChunkListener = null;

    probe.mockResolvedValue(baseProbe);
    generate.mockResolvedValue(baseGenerateResult);
    cancel.mockResolvedValue({ cancelled: true });
    getCacheInfo.mockResolvedValue(baseCacheInfo);
    clearCache.mockResolvedValue({ path: baseCacheInfo.path, cleared: true });
    subscribeProgress.mockImplementation((listener: (event: LocalTtsProgressEvent) => void) => {
      progressListener = listener;
      return () => {
        if (progressListener === listener) progressListener = null;
      };
    });
    subscribeAudioChunk.mockImplementation((listener: (event: LocalTtsAudioChunkEvent) => void) => {
      audioChunkListener = listener;
      return () => {
        if (audioChunkListener === listener) audioChunkListener = null;
      };
    });

    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      writable: true,
      value: vi.fn(() => "blob:mock-url"),
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      writable: true,
      value: vi.fn(),
    });
    vi.stubGlobal("AudioContext", MockAudioContext as unknown as typeof AudioContext);
    vi.stubGlobal("requestAnimationFrame", vi.fn(() => 1));
    vi.stubGlobal("cancelAnimationFrame", vi.fn());

    window.electron = {
      isElectron: true,
      platform: "darwin",
      localTts: {
        probe,
        generate,
        cancel,
        getCacheInfo,
        clearCache,
        subscribeProgress,
        subscribeAudioChunk,
      },
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    delete window.electron;
  });

  it("probes the Rust runtime and renders runtime metadata", async () => {
    renderPage();

    await waitFor(() => {
      expect(probe).toHaveBeenCalledWith(expect.objectContaining({
        model: "qwen3",
        requestId: expect.stringMatching(/^qwen3-probe-/),
      }));
    });

    expect(probe.mock.calls[0][0]).not.toHaveProperty("allowRuntimeSetup");
    expect(await screen.findAllByText("Runtime: rust")).toHaveLength(2);
    expect(screen.getByText("Package: qwen_tts")).toBeInTheDocument();
    expect(screen.getByText("Recommended device: cpu")).toBeInTheDocument();
    expect(screen.getAllByText("Rust Qwen3 currently uses Candle CPU execution.")).toHaveLength(2);
  });

  it("loads NeuTTS .npy reference codes and generates with referenceCodesBase64", async () => {
    probe.mockResolvedValue({
      ready: true,
      message: "NeuTTS Rust runtime is ready.",
      runtime: "rust",
      package: "neutts",
      packageVersion: "0.1.1",
      warnings: ["NeuTTS Rust expects pre-encoded .npy reference codes."],
    } satisfies LocalTtsProbeResult);
    const generateDeferred = createDeferred<LocalTtsGenerateResult>();
    generate.mockReturnValue(generateDeferred.promise);

    renderPage(getRuntimePageProps("neutts"));

    await screen.findByText("NeuTTS Rust runtime is ready.");
    const referenceInput = screen.getByLabelText(/reference codes/i);
    const referenceFile = new File([new Uint8Array([1, 2, 3])], "reference.npy", {
      type: "application/octet-stream",
    });
    await act(async () => {
      fireEvent.change(referenceInput, { target: { files: [referenceFile] } });
    });
    expect(await screen.findByText(/loaded reference codes: reference\.npy/i)).toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText(/transcript that matches/i), {
      target: { value: "This is the exact transcript." },
    });

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /generate locally/i })).toBeEnabled();
    });
    fireEvent.click(screen.getByRole("button", { name: /generate locally/i }));

    await waitFor(() => {
      expect(generate).toHaveBeenCalledTimes(1);
    });

    const request = generate.mock.calls[0][0] as {
      model: "neutts";
      requestId: string;
      payload: Record<string, unknown>;
    };
    expect(request.payload).toMatchObject({
      modelRepo: "neuphonic/neutts-nano-q4-gguf",
      referenceText: "This is the exact transcript.",
      referenceCodesBase64: "AQID",
    });
    expect(request.payload).not.toHaveProperty("referenceAudioBase64");

    await emitGeneratedAudioChunk(audioChunkListener, request.requestId, "neutts");
    await act(async () => {
      generateDeferred.resolve({
        ...baseGenerateResult,
        modelRepo: "neuphonic/neutts-nano-q4-gguf",
      });
      await generateDeferred.promise;
    });

    expect(await screen.findByText(/neuphonic\/neutts-nano-q4-gguf/)).toBeInTheDocument();
    expect(screen.getByText("Output Audio")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /download audio/i })).toBeEnabled();
    expect(URL.createObjectURL).toHaveBeenCalled();
  });

  it("rejects WAV NeuTTS references because the Rust path requires .npy codes", async () => {
    renderPage(getRuntimePageProps("neutts"));

    await screen.findByRole("button", { name: /re-check runtime/i });
    const referenceInput = screen.getByLabelText(/reference codes/i);
    const wavFile = new File([new Uint8Array([1, 2, 3])], "reference.wav", { type: "audio/wav" });
    await act(async () => {
      fireEvent.change(referenceInput, { target: { files: [wavFile] } });
    });

    expect(await screen.findByText("NeuTTS Rust references must be pre-encoded .npy code files."))
      .toBeInTheDocument();
    expect(screen.getByRole("button", { name: /generate locally/i })).toBeDisabled();
  });

  it("generates Qwen3 audio with Rust-supported speaker, language, and runtime options", async () => {
    const generateDeferred = createDeferred<LocalTtsGenerateResult>();
    generate.mockReturnValue(generateDeferred.promise);
    renderPage();

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /generate locally/i })).toBeEnabled();
    });

    fireEvent.change(screen.getByLabelText(/^speaker$/i), { target: { value: "Aiden" } });
    fireEvent.change(screen.getByLabelText(/^language$/i), { target: { value: "English" } });
    fireEvent.change(screen.getByLabelText(/^device map$/i), { target: { value: "cpu" } });
    fireEvent.change(screen.getByLabelText(/^dtype$/i), { target: { value: "float32" } });
    fireEvent.change(screen.getByLabelText(/^attention$/i), { target: { value: "eager" } });
    fireEvent.change(screen.getByLabelText(/instruction/i), {
      target: { value: "Speak warmly with a calm documentary narration style." },
    });
    fireEvent.change(screen.getByLabelText(/^temperature$/i), { target: { value: "0.75" } });
    fireEvent.change(screen.getByLabelText(/^top-p$/i), { target: { value: "0.88" } });
    fireEvent.change(screen.getByLabelText(/^max tokens$/i), { target: { value: "2304" } });

    fireEvent.click(screen.getByRole("button", { name: /generate locally/i }));
    await waitFor(() => {
      expect(generate).toHaveBeenCalledTimes(1);
    });

    const request = generate.mock.calls[0][0] as {
      requestId: string;
      payload: Record<string, unknown>;
    };
    expect(request.payload).toMatchObject({
      modelRepo: "auto",
      speaker: "Aiden",
      language: "English",
      instruct: "Speak warmly with a calm documentary narration style.",
      deviceMap: "cpu",
      dtype: "float32",
      attnImplementation: "eager",
      temperature: 0.75,
      topP: 0.88,
      maxNewTokens: 2304,
    });

    await emitGeneratedAudioChunk(audioChunkListener, request.requestId, "qwen3");
    await act(async () => {
      generateDeferred.resolve(baseGenerateResult);
      await generateDeferred.promise;
    });

    await waitFor(() => {
      expect(screen.getAllByText(/Qwen\/Qwen3-TTS-12Hz-0\.6B-CustomVoice/).length).toBeGreaterThanOrEqual(2);
    });
  });

  it("cancels an in-flight local generation request", async () => {
    const deferred = createDeferred<LocalTtsGenerateResult>();
    generate.mockReturnValue(deferred.promise);
    renderPage();

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /generate locally/i })).toBeEnabled();
    });
    fireEvent.click(screen.getByRole("button", { name: /generate locally/i }));

    await waitFor(() => {
      expect(generate).toHaveBeenCalledTimes(1);
      expect(screen.getByRole("button", { name: /cancel/i })).toBeInTheDocument();
    });
    const request = generate.mock.calls[0][0] as { requestId: string };
    fireEvent.click(screen.getByRole("button", { name: /cancel/i }));

    await waitFor(() => {
      expect(cancel).toHaveBeenCalledWith({ model: "qwen3", requestId: request.requestId });
    });
    await act(async () => {
      deferred.reject(new Error("Generation cancelled."));
      await deferred.promise.catch(() => undefined);
    });

    expect(await screen.findByText("Generation cancelled.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /cancel/i })).not.toBeInTheDocument();
  });

  it("suppresses stale progress and results after inputs change mid-generation", async () => {
    const deferred = createDeferred<LocalTtsGenerateResult>();
    generate.mockReturnValue(deferred.promise);
    renderPage();

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /generate locally/i })).toBeEnabled();
    });
    fireEvent.click(screen.getByRole("button", { name: /generate locally/i }));
    const request = generate.mock.calls[0][0] as { requestId: string };

    await emitProgress(progressListener, {
      requestId: request.requestId,
      model: "qwen3",
      phase: "model_load",
      message: "Loading local model...",
      elapsedSec: 2.4,
    });
    expect(await screen.findByText("Loading local model...")).toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText("Type or paste text to synthesize…"), {
      target: { value: "Updated script for the next take." },
    });
    expect(await screen.findByText("Inputs changed. The current generation is now outdated.")).toBeInTheDocument();

    await emitProgress(progressListener, {
      requestId: request.requestId,
      model: "qwen3",
      phase: "inference",
      message: "Old request should stay hidden.",
      elapsedSec: 5.1,
    });
    expect(screen.queryByText("Old request should stay hidden.")).not.toBeInTheDocument();

    await act(async () => {
      deferred.resolve(baseGenerateResult);
      await deferred.promise;
    });
    await waitFor(() => {
      expect(screen.queryByText("Output Audio")).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: /generate locally/i })).toBeEnabled();
    });
  });

  it("ignores stale probe and cache responses after switching models", async () => {
    const neuttsProbe = createDeferred<LocalTtsProbeResult>();
    const neuttsCache = createDeferred<LocalTtsCacheInfo>();

    probe.mockImplementation(({ model }: { model: LocalTtsModel }) => (
      model === "neutts"
        ? neuttsProbe.promise
        : Promise.resolve(baseProbe)
    ));
    getCacheInfo.mockImplementation(({ model }: { model: LocalTtsModel }) => (
      model === "neutts"
        ? neuttsCache.promise
        : Promise.resolve(baseCacheInfo)
    ));

    const { rerender } = renderPage(getRuntimePageProps("neutts"));
    rerender(<LocalRuntimePage {...getRuntimePageProps("qwen3")} />);

    expect(await screen.findByText("Qwen3-TTS Rust runtime is ready.")).toBeInTheDocument();
    expect(screen.getByText("Path: /cache/qwen3")).toBeInTheDocument();

    await act(async () => {
      neuttsProbe.resolve({
        ready: true,
        message: "NeuTTS Rust runtime is ready.",
        runtime: "rust",
        package: "neutts",
        packageVersion: "0.1.1",
      });
      neuttsCache.resolve({
        path: "/cache/neutts",
        exists: true,
        sizeBytes: 1024,
      });
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(screen.queryByText("NeuTTS Rust runtime is ready.")).not.toBeInTheDocument();
      expect(screen.queryByText("Path: /cache/neutts")).not.toBeInTheDocument();
    });
  });

  it("preserves Qwen3 input state when switching away from the tab and back", async () => {
    render(<LocalRuntimeTabsHarness initialModel="qwen3" />);

    expect(await screen.findByText("Qwen3-TTS Rust runtime is ready.")).toBeInTheDocument();
    fireEvent.change(screen.getByPlaceholderText("Type or paste text to synthesize…"), {
      target: { value: "Qwen3 tab text should still be here after tab navigation." },
    });
    fireEvent.change(screen.getByLabelText(/^speaker$/i), { target: { value: "Aiden" } });
    fireEvent.change(screen.getByLabelText(/^language$/i), { target: { value: "English" } });
    fireEvent.change(screen.getByLabelText(/^device map$/i), { target: { value: "cpu" } });
    fireEvent.change(screen.getByLabelText(/^dtype$/i), { target: { value: "float32" } });
    fireEvent.change(screen.getByLabelText(/^attention$/i), { target: { value: "eager" } });

    fireEvent.click(screen.getByRole("button", { name: /^Studio$/i }));
    expect(screen.getByText("Studio tab content")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^Qwen3$/i }));

    expect(screen.getByPlaceholderText("Type or paste text to synthesize…")).toHaveValue(
      "Qwen3 tab text should still be here after tab navigation.",
    );
    expect(screen.getByLabelText(/^speaker$/i)).toHaveValue("Aiden");
    expect(screen.getByLabelText(/^language$/i)).toHaveValue("English");
    expect(screen.getByLabelText(/^device map$/i)).toHaveValue("cpu");
    expect(screen.getByLabelText(/^dtype$/i)).toHaveValue("float32");
    expect(screen.getByLabelText(/^attention$/i)).toHaveValue("eager");
  });

  it("clears local cache and renders the Electron-only fallback", async () => {
    const { unmount } = renderPage();

    await screen.findByText("Qwen3-TTS Rust runtime is ready.");
    fireEvent.click(screen.getByRole("button", { name: /clear local cache/i }));
    await waitFor(() => {
      expect(clearCache).toHaveBeenCalledWith({ model: "qwen3" });
      expect(screen.getByText("Local model cache cleared.")).toBeInTheDocument();
    });

    unmount();
    delete window.electron;
    renderPage();
    expect(screen.getByText(/runs only in the Electron desktop app/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /generate locally/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /clear local cache/i })).toBeDisabled();
  });
});
