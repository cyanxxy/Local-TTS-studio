import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState, type ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LocalRuntimePage } from "./LocalRuntimePage";
import type {
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

function getRuntimePageProps(model: LocalTtsModel): ComponentProps<typeof LocalRuntimePage> {
  if (model === "neutts") {
    return {
      model,
      name: "NeuTTS Nano",
      releaseDate: "2026-02-12",
      params: "~120M",
      highlights: ["Local Python bridge"],
      links: [{ label: "HF Model", href: "https://huggingface.co/neuphonic/neutts-nano" }],
    };
  }

  if (model === "qwen3") {
    return {
      model,
      name: "Qwen3-TTS",
      releaseDate: "2026-01-29",
      params: "~1.9B",
      highlights: ["Local Python bridge"],
      links: [{ label: "HF Model", href: "https://huggingface.co/Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice" }],
    };
  }

  return {
    model,
    name: "Kani-TTS-2",
    releaseDate: "2026-02-15",
    params: "~400M",
    highlights: ["Local Python bridge"],
    links: [{ label: "HF Model", href: "https://huggingface.co/nineninesix/kani-tts-2-en" }],
  };
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
        <button type="button" onClick={() => switchTab("kani")}>Kani</button>
        <button type="button" onClick={() => switchTab("qwen3")}>Qwen3</button>
      </nav>
      {activeTab === "studio" && <div>Studio tab content</div>}
      {(["neutts", "kani", "qwen3"] as const)
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
      expect(probe).toHaveBeenCalledWith(expect.objectContaining({
        model: "neutts",
        pythonBinary: undefined,
      }));
    });

    fireEvent.change(screen.getByPlaceholderText("/absolute/path/to/python"), {
      target: { value: "/custom/venv/bin/python" },
    });

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(probe).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: /generate locally/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /re-download model/i })).toBeDisabled();

    const recheckButton = await screen.findByRole("button", { name: /re-check runtime/i });
    fireEvent.click(recheckButton);

    await waitFor(() => {
      expect(probe).toHaveBeenLastCalledWith(expect.objectContaining({
        model: "neutts",
        pythonBinary: "/custom/venv/bin/python",
      }));
    });

    const runtimeSettingsSection = screen.getByPlaceholderText("/absolute/path/to/python").closest("section");
    expect(runtimeSettingsSection).not.toBeNull();
    const runtimeSettings = within(runtimeSettingsSection!);

    expect(await runtimeSettings.findByText("Interpreter: /custom/venv/bin/python")).toBeInTheDocument();
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

  it("does not re-probe or stay busy when the Python override changes during an in-flight probe", async () => {
    const pendingProbe = createDeferred<LocalTtsProbeResult>();
    probe.mockReturnValue(pendingProbe.promise);

    renderPage();

    expect(await screen.findByRole("button", { name: /checking/i })).toBeDisabled();

    fireEvent.change(screen.getByPlaceholderText("/absolute/path/to/python"), {
      target: { value: "/custom/bin/python" },
    });

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(probe).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: /re-check runtime/i })).toBeEnabled();

    await act(async () => {
      pendingProbe.resolve(baseProbe);
      await pendingProbe.promise;
    });

    expect(screen.queryByText(baseProbe.message)).not.toBeInTheDocument();
  });

  it("renders progress for first-run runtime setup during probe", async () => {
    const pendingProbe = createDeferred<LocalTtsProbeResult>();
    probe.mockReturnValue(pendingProbe.promise);

    renderPage({
      model: "qwen3",
      name: "Qwen3-TTS",
      links: [{ label: "HF Model", href: "https://huggingface.co/Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice" }],
    });

    await waitFor(() => {
      expect(probe).toHaveBeenCalledTimes(1);
    });

    const request = probe.mock.calls[0][0] as { requestId: string };
    expect(request.requestId).toMatch(/^qwen3-probe-/);

    await emitProgress(progressListener, {
      requestId: request.requestId,
      model: "qwen3",
      phase: "runtime_setup",
      message: "Installing PyTorch with Apple MPS support...",
      elapsedSec: 1.2,
    });

    expect(await screen.findByText("Installing PyTorch with Apple MPS support... (1.2s)")).toBeInTheDocument();

    await emitProgress(progressListener, {
      requestId: "stale-probe",
      model: "qwen3",
      phase: "runtime_setup",
      message: "Stale setup progress",
      elapsedSec: 2.4,
    });

    expect(screen.queryByText(/Stale setup progress/)).not.toBeInTheDocument();

    await act(async () => {
      pendingProbe.resolve({
        ...baseProbe,
        message: "Qwen3-TTS runtime is ready.",
        package: "qwen-tts",
      });
      await pendingProbe.promise;
    });

    expect(await screen.findByText("Qwen3-TTS runtime is ready.")).toBeInTheDocument();
  });

  it("clears runtime busy after probe setup fails and ignores late setup progress", async () => {
    const pendingProbe = createDeferred<LocalTtsProbeResult>();
    probe.mockReturnValue(pendingProbe.promise);

    renderPage();

    await waitFor(() => {
      expect(probe).toHaveBeenCalledTimes(1);
    });

    const request = probe.mock.calls[0][0] as { requestId: string };

    await emitProgress(progressListener, {
      requestId: request.requestId,
      model: "kani",
      phase: "runtime_setup",
      message: "Installing Kani runtime...",
      elapsedSec: 3.1,
    });

    expect(await screen.findByText("Installing Kani runtime... (3.1s)")).toBeInTheDocument();

    await act(async () => {
      pendingProbe.reject(new Error("Kani setup failed."));
      await pendingProbe.promise.catch(() => undefined);
    });

    expect(await screen.findByText("Kani setup failed.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /re-check runtime/i })).toBeEnabled();
    expect(screen.queryByText("Checking local runtime...")).not.toBeInTheDocument();

    await emitProgress(progressListener, {
      requestId: request.requestId,
      model: "kani",
      phase: "runtime_setup",
      message: "Late setup progress must stay hidden.",
      elapsedSec: 5.7,
    });

    expect(screen.queryByText(/Late setup progress/)).not.toBeInTheDocument();
    expect(screen.getByText("Kani setup failed.")).toBeInTheDocument();
  });

  it("ties setup progress to the newest explicit probe after Python override edits", async () => {
    const initialProbe = createDeferred<LocalTtsProbeResult>();
    const explicitProbe = createDeferred<LocalTtsProbeResult>();
    probe
      .mockReturnValueOnce(initialProbe.promise)
      .mockReturnValueOnce(explicitProbe.promise);

    renderPage();

    expect(await screen.findByRole("button", { name: /checking/i })).toBeDisabled();
    const initialRequest = probe.mock.calls[0][0] as { requestId: string };

    fireEvent.change(screen.getByPlaceholderText("/absolute/path/to/python"), {
      target: { value: "/custom/bin/python" },
    });

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /re-check runtime/i })).toBeEnabled();
    });

    fireEvent.click(screen.getByRole("button", { name: /re-check runtime/i }));

    await waitFor(() => {
      expect(probe).toHaveBeenCalledTimes(2);
    });

    const explicitRequest = probe.mock.calls[1][0] as {
      requestId: string;
      pythonBinary?: string;
    };
    expect(explicitRequest.pythonBinary).toBe("/custom/bin/python");

    await emitProgress(progressListener, {
      requestId: initialRequest.requestId,
      model: "kani",
      phase: "runtime_setup",
      message: "Old setup progress must stay hidden.",
      elapsedSec: 2.2,
    });

    expect(screen.queryByText(/Old setup progress/)).not.toBeInTheDocument();

    await emitProgress(progressListener, {
      requestId: explicitRequest.requestId,
      model: "kani",
      phase: "runtime_setup",
      message: "Installing explicit runtime...",
      elapsedSec: 0.8,
    });

    expect(await screen.findByText("Installing explicit runtime... (0.8s)")).toBeInTheDocument();

    await act(async () => {
      initialProbe.resolve({
        ...baseProbe,
        message: "Initial probe should stay hidden.",
      });
      await initialProbe.promise;
    });

    expect(screen.queryByText("Initial probe should stay hidden.")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /checking/i })).toBeDisabled();

    await act(async () => {
      explicitProbe.resolve({
        ...baseProbe,
        message: "Explicit runtime is ready.",
      });
      await explicitProbe.promise;
    });

    expect(await screen.findByText("Explicit runtime is ready.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /re-check runtime/i })).toBeEnabled();
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

    fireEvent.change(screen.getByPlaceholderText("Type or paste text to synthesize…"), {
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

  it("preserves Kani runtime and input state when switching away from the tab and back", async () => {
    const returningProbe = createDeferred<LocalTtsProbeResult>();
    probe.mockReset();
    probe
      .mockResolvedValueOnce(baseProbe)
      .mockReturnValue(returningProbe.promise);

    render(<LocalRuntimeTabsHarness initialModel="kani" />);

    expect(await screen.findByText("Kani runtime is ready.")).toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText("Type or paste text to synthesize…"), {
      target: { value: "Kani tab text should still be here after tab navigation." },
    });
    fireEvent.change(screen.getByPlaceholderText("/absolute/path/to/python"), {
      target: { value: "/runtimes/kani/bin/python" },
    });
    fireEvent.change(screen.getByLabelText(/accent \/ voice tag/i), {
      target: { value: "en_scou" },
    });
    fireEvent.change(screen.getByLabelText(/^temperature$/i), {
      target: { value: "0.85" },
    });
    fireEvent.change(screen.getByLabelText(/^top-p$/i), {
      target: { value: "0.9" },
    });
    fireEvent.change(screen.getByLabelText(/^repetition penalty$/i), {
      target: { value: "1.3" },
    });
    fireEvent.change(screen.getByLabelText(/^max tokens$/i), {
      target: { value: "3584" },
    });

    fireEvent.click(screen.getByRole("button", { name: /^Studio$/i }));
    expect(screen.getByText("Studio tab content")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /^Kani$/i }));

    expect(await screen.findByText("Runtime settings changed. Re-check the Python runtime before generating again.")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("Type or paste text to synthesize…")).toHaveValue(
      "Kani tab text should still be here after tab navigation.",
    );
    expect(screen.getByPlaceholderText("/absolute/path/to/python")).toHaveValue("/runtimes/kani/bin/python");
    expect(screen.getByLabelText(/accent \/ voice tag/i)).toHaveValue("en_scou");
    expect(screen.getByLabelText(/^temperature$/i)).toHaveValue(0.85);
    expect(screen.getByLabelText(/^top-p$/i)).toHaveValue(0.9);
    expect(screen.getByLabelText(/^repetition penalty$/i)).toHaveValue(1.3);
    expect(screen.getByLabelText(/^max tokens$/i)).toHaveValue(3584);

    await act(async () => {
      returningProbe.resolve(baseProbe);
      await returningProbe.promise;
    });
  });

  it("preserves NeuTTS reference inputs when switching away from the tab and back", async () => {
    probe.mockResolvedValue({
      ...baseProbe,
      message: "NeuTTS runtime is ready.",
      package: "neutts",
    });

    render(<LocalRuntimeTabsHarness initialModel="neutts" />);

    expect(await screen.findByText("NeuTTS runtime is ready.")).toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText("Type or paste text to synthesize…"), {
      target: { value: "NeuTTS tab text should still be here after tab navigation." },
    });
    fireEvent.change(screen.getByPlaceholderText("/absolute/path/to/python"), {
      target: { value: "/runtimes/neutts/bin/python" },
    });
    fireEvent.change(screen.getByLabelText(/^model variant$/i), {
      target: { value: "neuphonic/neutts-nano-spanish" },
    });
    fireEvent.change(screen.getByPlaceholderText(/paste the exact spoken transcript/i), {
      target: { value: "This is the exact reference transcript." },
    });

    const referenceInput = screen.getAllByLabelText(/reference audio/i)[0];
    const wavFile = new File([validWavBytes], "reference.wav", { type: "audio/wav" });
    await act(async () => {
      fireEvent.change(referenceInput, { target: { files: [wavFile] } });
    });

    expect(await screen.findByText(/loaded reference audio: reference\.wav/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /^Studio$/i }));
    expect(screen.getByText("Studio tab content")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /^NeuTTS$/i }));

    expect(await screen.findByText(/loaded reference audio: reference\.wav/i)).toBeInTheDocument();
    expect(screen.getByPlaceholderText("Type or paste text to synthesize…")).toHaveValue(
      "NeuTTS tab text should still be here after tab navigation.",
    );
    expect(screen.getByPlaceholderText("/absolute/path/to/python")).toHaveValue("/runtimes/neutts/bin/python");
    expect(screen.getByLabelText(/^model variant$/i)).toHaveValue("neuphonic/neutts-nano-spanish");
    expect(screen.getByPlaceholderText(/paste the exact spoken transcript/i)).toHaveValue(
      "This is the exact reference transcript.",
    );
    expect(screen.getByText("reference.wav")).toBeInTheDocument();
  });

  it("preserves Qwen3 speaker and runtime options when switching away from the tab and back", async () => {
    probe.mockResolvedValue({
      ...baseProbe,
      message: "Qwen3-TTS runtime is ready.",
      package: "qwen-tts",
    });

    render(<LocalRuntimeTabsHarness initialModel="qwen3" />);

    expect(await screen.findByText("Qwen3-TTS runtime is ready.")).toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText("Type or paste text to synthesize…"), {
      target: { value: "Qwen3 tab text should still be here after tab navigation." },
    });
    fireEvent.change(screen.getByPlaceholderText("/absolute/path/to/python"), {
      target: { value: "/runtimes/qwen3/bin/python" },
    });
    fireEvent.change(screen.getByLabelText(/^speaker$/i), {
      target: { value: "Aiden" },
    });
    fireEvent.change(screen.getByLabelText(/^language$/i), {
      target: { value: "English" },
    });
    fireEvent.change(screen.getByLabelText(/^device map$/i), {
      target: { value: "cpu" },
    });
    fireEvent.change(screen.getByLabelText(/^dtype$/i), {
      target: { value: "float32" },
    });
    fireEvent.change(screen.getByLabelText(/^attention$/i), {
      target: { value: "eager" },
    });
    fireEvent.change(screen.getByLabelText(/instruction/i), {
      target: { value: "Speak warmly with a calm documentary narration style." },
    });
    fireEvent.change(screen.getByLabelText(/^temperature$/i), {
      target: { value: "0.75" },
    });
    fireEvent.change(screen.getByLabelText(/^top-p$/i), {
      target: { value: "0.88" },
    });
    fireEvent.change(screen.getByLabelText(/^max tokens$/i), {
      target: { value: "2304" },
    });

    fireEvent.click(screen.getByRole("button", { name: /^Studio$/i }));
    expect(screen.getByText("Studio tab content")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /^Qwen3$/i }));

    expect(await screen.findByText("Runtime settings changed. Re-check the Python runtime before generating again.")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("Type or paste text to synthesize…")).toHaveValue(
      "Qwen3 tab text should still be here after tab navigation.",
    );
    expect(screen.getByPlaceholderText("/absolute/path/to/python")).toHaveValue("/runtimes/qwen3/bin/python");
    expect(screen.getByLabelText(/^speaker$/i)).toHaveValue("Aiden");
    expect(screen.getByLabelText(/^language$/i)).toHaveValue("English");
    expect(screen.getByLabelText(/^device map$/i)).toHaveValue("cpu");
    expect(screen.getByLabelText(/^dtype$/i)).toHaveValue("float32");
    expect(screen.getByLabelText(/^attention$/i)).toHaveValue("eager");
    expect(screen.getByLabelText(/instruction/i)).toHaveValue(
      "Speak warmly with a calm documentary narration style.",
    );
    expect(screen.getByLabelText(/^temperature$/i)).toHaveValue(0.75);
    expect(screen.getByLabelText(/^top-p$/i)).toHaveValue(0.88);
    expect(screen.getByLabelText(/^max tokens$/i)).toHaveValue(2304);
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

    fireEvent.change(screen.getByLabelText(/accent \/ voice tag/i), {
      target: { value: "en_bost" },
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
        languageTag: "en_bost",
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

  it("generates Qwen3 audio with speaker, language, and runtime options", async () => {
    probe.mockResolvedValue({
      ready: true,
      message: "Qwen3-TTS runtime is ready.",
      pythonVersion: "3.12.4",
      pythonBinary: "/qwen/bin/python",
      resolvedFrom: "appPath:.venv-qwen3",
      package: "qwen-tts",
      packageVersion: "1.0.0",
      torchVersion: "2.12.0",
      recommendedModelRepo: "Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice",
      recommendedDeviceMap: "mps",
      recommendedDtype: "bfloat16",
      recommendedAttention: "sdpa",
      warnings: ["Apple MPS was detected. Auto mode will use the faster 0.6B CustomVoice model with bfloat16 MPS acceleration."],
    } satisfies LocalTtsProbeResult);
    getCacheInfo.mockResolvedValue({
      path: "/cache/qwen3",
      exists: true,
      sizeBytes: 4096,
    } satisfies LocalTtsCacheInfo);
    generate.mockResolvedValue({
      ...baseGenerateResult,
      modelRepo: "Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice",
      speakerStatus: "Aiden · English",
      speakers: ["Ryan", "Aiden"],
    } satisfies LocalTtsGenerateResult);

    renderPage({
      model: "qwen3",
      name: "Qwen3-TTS",
      links: [{ label: "HF Model", href: "https://huggingface.co/Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice" }],
    });

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /generate locally/i })).toBeEnabled();
    });

    expect(screen.getByPlaceholderText("/absolute/path/to/python")).toBeInTheDocument();
    expect(screen.getByText("Qwen3-TTS runtime is ready.")).toBeInTheDocument();
    expect(screen.getAllByText("Apple MPS was detected. Auto mode will use the faster 0.6B CustomVoice model with bfloat16 MPS acceleration.")).toHaveLength(2);
    expect(screen.getByText("Recommended device: mps")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText(/^speaker$/i), {
      target: { value: "Aiden" },
    });
    fireEvent.change(screen.getByLabelText(/^language$/i), {
      target: { value: "English" },
    });
    fireEvent.change(screen.getByLabelText(/^device map$/i), {
      target: { value: "cpu" },
    });
    fireEvent.change(screen.getByLabelText(/^dtype$/i), {
      target: { value: "float32" },
    });
    fireEvent.change(screen.getByLabelText(/^attention$/i), {
      target: { value: "eager" },
    });
    fireEvent.change(screen.getByLabelText(/instruction/i), {
      target: { value: "Speak warmly with a calm documentary narration style." },
    });
    fireEvent.change(screen.getByLabelText(/^temperature$/i), {
      target: { value: "0.75" },
    });
    fireEvent.change(screen.getByLabelText(/^top-p$/i), {
      target: { value: "0.88" },
    });
    fireEvent.change(screen.getByLabelText(/^max tokens$/i), {
      target: { value: "2304" },
    });

    fireEvent.click(screen.getByRole("button", { name: /generate locally/i }));

    await waitFor(() => {
      expect(generate).toHaveBeenCalledTimes(1);
      expect(screen.getByText("Output Audio")).toBeInTheDocument();
    });

    expect(generate.mock.calls[0][0]).toMatchObject({
      model: "qwen3",
      pythonBinary: undefined,
      payload: {
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
      },
    });
    expect(screen.getByText(/Qwen\/Qwen3-TTS-12Hz-1\.7B-CustomVoice/)).toBeInTheDocument();
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
