import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LocalRuntimePage } from "./LocalRuntimePage";
import type {
  LocalTtsCacheInfo,
  LocalTtsGenerateResult,
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
  message: "Kani runtime is ready.",
  pythonVersion: "3.12.0",
  pythonBinary: "/venv/bin/python",
  resolvedFrom: "TTS_PYTHON_BIN",
  package: "kani-tts-2",
  packageVersion: "0.1.0",
  warnings: [],
};

const baseCacheInfo: LocalTtsCacheInfo = {
  path: "/cache/kani",
  exists: true,
  sizeBytes: 2048,
};

const baseGenerateResult: LocalTtsGenerateResult = {
  wavBase64: "UklGRldBVkU=",
  sampleRate: 22_050,
  modelRepo: "nineninesix/kani-tts-2-en",
  durationSec: 1.25,
  elapsedSec: 0.42,
};

const validWavBytes = new Uint8Array([
  0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00,
  0x57, 0x41, 0x56, 0x45, 0x66, 0x6d, 0x74, 0x20,
  0x10, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00,
  0x22, 0x56, 0x00, 0x00, 0x44, 0xac, 0x00, 0x00,
  0x02, 0x00, 0x10, 0x00, 0x64, 0x61, 0x74, 0x61,
  0x00, 0x00, 0x00, 0x00,
]);

function renderPage(overrides: Partial<ComponentProps<typeof LocalRuntimePage>> = {}) {
  return render(
    <LocalRuntimePage
      model="kani"
      name="Kani-TTS-2"
      releaseDate="2026-02-15"
      params="~400M"
      highlights={["Local Python bridge"]}
      links={[{ label: "HF Model", href: "https://huggingface.co/nineninesix/kani-tts-2-en" }]}
      {...overrides}
    />,
  );
}

async function emitProgress(listener: ((event: LocalTtsProgressEvent) => void) | null, event: LocalTtsProgressEvent) {
  await act(async () => {
    listener?.(event);
    await Promise.resolve();
  });
}

describe("LocalRuntimePage", () => {
  const probe = vi.fn();
  const generate = vi.fn();
  const cancel = vi.fn();
  const getCacheInfo = vi.fn();
  const clearCache = vi.fn();
  const subscribeProgress = vi.fn();
  let progressListener: ((event: LocalTtsProgressEvent) => void) | null = null;

  beforeEach(() => {
    probe.mockReset();
    generate.mockReset();
    cancel.mockReset();
    getCacheInfo.mockReset();
    clearCache.mockReset();
    subscribeProgress.mockReset();
    progressListener = null;

    probe.mockResolvedValue(baseProbe);
    generate.mockResolvedValue(baseGenerateResult);
    cancel.mockResolvedValue({ cancelled: true });
    getCacheInfo.mockResolvedValue(baseCacheInfo);
    clearCache.mockResolvedValue({ path: baseCacheInfo.path, cleared: true });
    subscribeProgress.mockImplementation((listener: (event: LocalTtsProgressEvent) => void) => {
      progressListener = listener;
      return () => {
        if (progressListener === listener) {
          progressListener = null;
        }
      };
    });

    class MockAudioContext {
      decodeAudioData = vi.fn(async () => ({
        numberOfChannels: 1,
        sampleRate: 22_050,
        duration: 4,
      }));

      close = vi.fn(async () => undefined);
    }

    Object.defineProperty(globalThis, "AudioContext", {
      configurable: true,
      writable: true,
      value: MockAudioContext,
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
      },
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete window.electron;
  });

  it("forwards the NeuTTS python override into probe and generate and renders runtime metadata", async () => {
    probe.mockResolvedValue({
      ready: true,
      message: "NeuTTS runtime is ready.",
      pythonVersion: "3.13.2",
      pythonBinary: "/custom/venv/bin/python",
      resolvedFrom: "request",
      package: "neutts",
      packageVersion: "1.2.0",
      compatibilityMode: "current_1_2_x_or_newer",
      warnings: ["Using explicit Python override."],
      espeakVersion: "eSpeak NG text-to-speech: 1.52.0",
    } satisfies LocalTtsProbeResult);

    renderPage({
      model: "neutts",
      name: "NeuTTS Nano",
      links: [{ label: "HF Model", href: "https://huggingface.co/neuphonic/neutts-nano" }],
    });

    await waitFor(() => {
      expect(probe).toHaveBeenCalledWith({ model: "neutts", pythonBinary: undefined });
    });

    fireEvent.change(screen.getByPlaceholderText("/absolute/path/to/python"), {
      target: { value: "/custom/venv/bin/python" },
    });

    expect(screen.getByRole("button", { name: /generate locally/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /re-download model/i })).toBeDisabled();

    const recheckButton = await screen.findByRole("button", { name: /re-check runtime/i });
    fireEvent.click(recheckButton);

    await waitFor(() => {
      expect(probe).toHaveBeenLastCalledWith({
        model: "neutts",
        pythonBinary: "/custom/venv/bin/python",
      });
    });

    const runtimeSettingsSection = screen.getByPlaceholderText("/absolute/path/to/python").closest("section");
    expect(runtimeSettingsSection).not.toBeNull();
    const runtimeSettings = within(runtimeSettingsSection!);

    expect(await runtimeSettings.findByText("Resolved interpreter: /custom/venv/bin/python")).toBeInTheDocument();
    expect(runtimeSettings.getByText("Resolved from: request")).toBeInTheDocument();
    expect(runtimeSettings.getByText("Package version: 1.2.0")).toBeInTheDocument();
    expect(runtimeSettings.getByText("Compatibility mode: Current 1.2.x+")).toBeInTheDocument();
    expect(runtimeSettings.getByText("espeak-ng: eSpeak NG text-to-speech: 1.52.0")).toBeInTheDocument();
    expect(runtimeSettings.getByText("Using explicit Python override.")).toBeInTheDocument();

    const referenceInput = screen.getAllByLabelText(/reference audio/i)[0];
    const wavFile = new File([validWavBytes], "reference.wav", { type: "audio/wav" });
    await act(async () => {
      fireEvent.change(referenceInput, { target: { files: [wavFile] } });
    });

    await screen.findByText(/loaded reference audio: reference\.wav/i);

    fireEvent.change(screen.getByPlaceholderText(/paste the exact spoken transcript/i), {
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
      pythonBinary?: string;
      payload: Record<string, unknown>;
    };

    expect(request.model).toBe("neutts");
    expect(request.pythonBinary).toBe("/custom/venv/bin/python");
    expect(request.requestId).toMatch(/^neutts-/);
  });

  it("cancels an in-flight local generation request", async () => {
    const deferred = createDeferred<LocalTtsGenerateResult>();
    generate.mockReturnValue(deferred.promise);

    renderPage();

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /generate locally/i })).toBeEnabled();
    });

    fireEvent.change(screen.getByLabelText(/max tokens/i), {
      target: { value: "3584" },
    });

    fireEvent.click(screen.getByRole("button", { name: /generate locally/i }));

    await waitFor(() => {
      expect(generate).toHaveBeenCalledTimes(1);
      expect(screen.getByRole("button", { name: /cancel/i })).toBeInTheDocument();
    });

    const request = generate.mock.calls[0][0] as {
      requestId: string;
      payload: Record<string, unknown>;
    };
    expect(request.payload.maxNewTokens).toBe(3584);

    fireEvent.click(screen.getByRole("button", { name: /cancel/i }));

    await waitFor(() => {
      expect(cancel).toHaveBeenCalledWith({ model: "kani", requestId: request.requestId });
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
      model: "kani",
      phase: "model_load",
      message: "Loading local model...",
      elapsedSec: 2.4,
    });

    expect(await screen.findByText("Loading local model...")).toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText("Enter text to synthesize"), {
      target: { value: "Updated script for the next take." },
    });

    expect(await screen.findByText("Inputs changed. The current generation is now outdated.")).toBeInTheDocument();

    await emitProgress(progressListener, {
      requestId: request.requestId,
      model: "kani",
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

    probe.mockImplementation(({ model }: { model: "neutts" | "kani" }) => (
      model === "neutts"
        ? neuttsProbe.promise
        : Promise.resolve({
          ...baseProbe,
          message: "Kani runtime is ready.",
          pythonVersion: "3.12.0",
        })
    ));

    getCacheInfo.mockImplementation(({ model }: { model: "neutts" | "kani" }) => (
      model === "neutts"
        ? neuttsCache.promise
        : Promise.resolve({
          ...baseCacheInfo,
          path: "/cache/kani",
        })
    ));

    const { rerender } = renderPage({
      model: "neutts",
      name: "NeuTTS Nano",
      links: [{ label: "HF Model", href: "https://huggingface.co/neuphonic/neutts-nano" }],
    });

    rerender(
      <LocalRuntimePage
        model="kani"
        name="Kani-TTS-2"
        releaseDate="2026-02-15"
        params="~400M"
        highlights={["Local Python bridge"]}
        links={[{ label: "HF Model", href: "https://huggingface.co/nineninesix/kani-tts-2-en" }]}
      />,
    );

    expect(await screen.findByText("Kani runtime is ready.")).toBeInTheDocument();
    expect(screen.getByText("Python: 3.12.0")).toBeInTheDocument();
    expect(screen.getByText("Path: /cache/kani")).toBeInTheDocument();

    await act(async () => {
      neuttsProbe.resolve({
        ready: true,
        message: "NeuTTS runtime is ready.",
        pythonVersion: "3.10.14",
        pythonBinary: "/venv-neutts/bin/python",
        resolvedFrom: "appPath:.venv-neutts",
        package: "neutts",
        packageVersion: "1.0.0",
      });
      neuttsCache.resolve({
        path: "/cache/neutts",
        exists: true,
        sizeBytes: 1024,
      });
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(screen.queryByText("NeuTTS runtime is ready.")).not.toBeInTheDocument();
      expect(screen.queryByText("Python: 3.10.14")).not.toBeInTheDocument();
      expect(screen.queryByText("Path: /cache/neutts")).not.toBeInTheDocument();
    });
  });

  it("renders the Electron-only fallback when the desktop bridge is unavailable", () => {
    delete window.electron;

    renderPage();

    expect(screen.getByText(/runs only in the Electron desktop app/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /generate locally/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /clear local cache/i })).toBeDisabled();
  });

  it("generates Kani audio, refreshes cache, and clears or re-downloads the cache", async () => {
    renderPage();

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /generate locally/i })).toBeEnabled();
    });

    fireEvent.change(screen.getByPlaceholderText("Example: en_US"), {
      target: { value: "en_US" },
    });
    fireEvent.change(screen.getByLabelText(/temperature/i), {
      target: { value: "0.85" },
    });
    fireEvent.change(screen.getByLabelText(/top-p/i), {
      target: { value: "0.9" },
    });
    fireEvent.change(screen.getByLabelText(/repetition penalty/i), {
      target: { value: "1.25" },
    });

    fireEvent.click(screen.getByRole("button", { name: /generate locally/i }));

    await waitFor(() => {
      expect(generate).toHaveBeenCalledTimes(1);
      expect(screen.getByText("Output Audio")).toBeInTheDocument();
    });

    expect(generate.mock.calls[0][0]).toMatchObject({
      model: "kani",
      pythonBinary: undefined,
      payload: {
        languageTag: "en_US",
        temperature: 0.85,
        topP: 0.9,
        repetitionPenalty: 1.25,
      },
    });
    expect(screen.getByText(/nineninesix\/kani-tts-2-en/)).toBeInTheDocument();
    expect(getCacheInfo).toHaveBeenCalledTimes(2);

    fireEvent.click(screen.getByRole("button", { name: /clear local cache/i }));
    await waitFor(() => {
      expect(clearCache).toHaveBeenCalledWith({ model: "kani" });
      expect(screen.getByText("Local model cache cleared.")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: /re-download model/i }));
    await waitFor(() => {
      expect(clearCache).toHaveBeenCalledTimes(2);
      expect(generate).toHaveBeenCalledTimes(2);
    });
  });

  it("handles runtime startup errors", async () => {
    probe.mockRejectedValueOnce(new Error("runtime missing"));
    getCacheInfo.mockRejectedValueOnce(new Error("cache unavailable"));

    renderPage();

    expect(await screen.findByText("runtime missing")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /generate locally/i })).toBeDisabled();
  });

  it("handles generation and cancellation errors", async () => {
    generate.mockRejectedValueOnce(new Error("synthesis failed"));
    cancel.mockRejectedValueOnce(new Error("cancel failed"));

    renderPage();

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /generate locally/i })).toBeEnabled();
    });

    fireEvent.click(screen.getByRole("button", { name: /generate locally/i }));
    expect(await screen.findByText("synthesis failed")).toBeInTheDocument();

    const deferred = createDeferred<LocalTtsGenerateResult>();
    generate.mockReturnValueOnce(deferred.promise);
    fireEvent.click(screen.getByRole("button", { name: /generate locally/i }));
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /cancel/i })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: /cancel/i }));
    expect(await screen.findByText("cancel failed")).toBeInTheDocument();

    await act(async () => {
      deferred.resolve(baseGenerateResult);
      await deferred.promise;
    });
  });

  it("validates NeuTTS reference audio and handles cache clear failures", async () => {
    clearCache.mockRejectedValueOnce(new Error("clear failed"));

    renderPage({
      model: "neutts",
      name: "NeuTTS Nano",
      links: [{ label: "HF Model", href: "https://huggingface.co/neuphonic/neutts-nano" }],
    });

    await screen.findByRole("button", { name: /re-check runtime/i });

    const referenceInput = screen.getAllByLabelText(/reference audio/i)[0];
    await act(async () => {
      fireEvent.change(referenceInput, {
        target: { files: [new File([new Uint8Array([1, 2, 3])], "bad.mp3", { type: "audio/mpeg" })] },
      });
    });
    expect(await screen.findByText(/real \.wav files/i)).toBeInTheDocument();

    await act(async () => {
      fireEvent.change(referenceInput, { target: { files: [] } });
    });
    expect(screen.getByText(/upload a clean 3-15s wav reference clip/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /clear local cache/i }));
    expect(await screen.findByText("clear failed")).toBeInTheDocument();
  });
});
