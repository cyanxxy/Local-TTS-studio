import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  LocalTtsAudioChunkEvent,
  LocalTtsGenerateResult,
  LocalTtsQwen3DownloadProgress,
  LocalTtsQwen3Setup,
} from "../electron";
import { Qwen3RuntimeProvider } from "../contexts/Qwen3RuntimeContext";
import { LocalRuntimePage } from "./LocalRuntimePage";

const CUSTOM_REPO = "mlx-community/Qwen3-TTS-12Hz-0.6B-CustomVoice-6bit";
const BASE_REPO = "mlx-community/Qwen3-TTS-12Hz-0.6B-Base-6bit";
const CUSTOM_PATH = "/cache/qwen3/mlx/custom";
const BASE_PATH = "/cache/qwen3/mlx/base";

const audio = vi.hoisted(() => ({
  beginStream: vi.fn(),
  endStream: vi.fn(),
  reset: vi.fn(),
  scheduleChunk: vi.fn().mockResolvedValue(undefined),
  stopAll: vi.fn(),
  togglePlay: vi.fn().mockResolvedValue(undefined),
  skip: vi.fn(),
  download: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../hooks/useAudioPlayer", () => ({
  useAudioPlayer: () => ({
    ...audio,
    activeSegmentId: null,
    currentTime: 0,
    isPlaying: false,
    segments: [],
    totalDuration: 0,
    seek: vi.fn(),
    playAll: vi.fn(),
    playSegment: vi.fn(),
    setPlaybackRate: vi.fn(),
    playbackRate: 1,
  }),
}));

const setup: LocalTtsQwen3Setup = {
  provider: "mlx",
  profiles: [
    {
      repo: CUSTOM_REPO,
      revision: "7dc92af14613355896fcab13b268c19ede233139",
      mode: "customVoice",
      parameters: "0.6B",
      provider: "mlx",
      platforms: ["darwin"],
      weightFormat: "mlx-6bit",
      label: "CustomVoice · 0.6B · MLX 6-bit",
      requiredFiles: ["config.json", "model.safetensors"],
      modelDir: CUSTOM_PATH,
      readiness: "verified",
    },
    {
      repo: BASE_REPO,
      revision: "4e44ed4bcee28a0f89a493e07bde16e6dccd43eb",
      mode: "voiceClone",
      parameters: "0.6B",
      provider: "mlx",
      platforms: ["darwin"],
      weightFormat: "mlx-6bit",
      label: "Voice clone · 0.6B · MLX 6-bit",
      requiredFiles: ["config.json", "model.safetensors"],
      modelDir: BASE_PATH,
      readiness: "verified",
    },
  ],
  recommendedModelRepo: CUSTOM_REPO,
  recommendedModelDir: CUSTOM_PATH,
};

const generated: LocalTtsGenerateResult = {
  audioTransport: "websocket-binary",
  audioChunkCount: 1,
  sampleRate: 24_000,
  modelRepo: CUSTOM_REPO,
  durationSec: 0.1,
  elapsedSec: 0.05,
  device: "mlx",
  phaseTimingsSec: { inferenceSec: 0.05 },
};

function props(model: "qwen3" | "neutts" = "qwen3") {
  return {
    model,
    name: model === "qwen3" ? "Qwen3-TTS" : "NeuTTS Nano",
    releaseDate: "2026",
    params: model === "qwen3" ? "0.6B / 1.7B" : "~120M",
    highlights: ["Rust local bridge"],
    links: [],
  };
}

function renderPage(model: "qwen3" | "neutts" = "qwen3") {
  return render(
    <Qwen3RuntimeProvider>
      <LocalRuntimePage {...props(model)} />
    </Qwen3RuntimeProvider>,
  );
}

describe("LocalRuntimePage", () => {
  const probe = vi.fn();
  const generate = vi.fn();
  const cancel = vi.fn();
  const getQwen3Setup = vi.fn();
  const downloadQwen3Model = vi.fn();
  const chooseQwen3ModelDir = vi.fn();
  let audioListener: ((event: LocalTtsAudioChunkEvent) => void) | null = null;
  let downloadProgressListener: ((event: LocalTtsQwen3DownloadProgress) => void) | null = null;

  beforeEach(() => {
    vi.clearAllMocks();
    audioListener = null;
    downloadProgressListener = null;
    getQwen3Setup.mockResolvedValue(setup);
    chooseQwen3ModelDir.mockResolvedValue({ path: "/chosen/model" });
    downloadQwen3Model.mockResolvedValue({
      modelRepo: CUSTOM_REPO,
      revision: setup.profiles[0].revision,
      modelDir: CUSTOM_PATH,
      downloadedFiles: 2,
      skippedFiles: 0,
      readiness: "verified",
    });
    probe.mockResolvedValue({
      ready: true,
      message: "Native Qwen3-TTS runtime is ready.",
      runtime: "rust",
      package: "qwen3-tts-rs",
      packageVersion: "0.2.2",
      provider: "mlx",
      upstreamRevision: "288a716ce38a91c826dd67968c75d1dd4b0f07bc",
      recommendedModelRepo: CUSTOM_REPO,
      recommendedBaseModelRepo: BASE_REPO,
      warnings: [],
    });
    generate.mockImplementation(({ requestId, model }: { requestId: string; model: "qwen3" | "neutts" }) => {
      const samples = new Float32Array([0.1, -0.2]);
      audioListener?.({
        requestId,
        model,
        index: 0,
        total: 1,
        sampleRate: 24_000,
        sampleCount: samples.length,
        silenceAfterSamples: 0,
        audio: samples.buffer,
      });
      return Promise.resolve({ ...generated, modelRepo: model === "qwen3" ? CUSTOM_REPO : "neuphonic/neutts-nano-q4-gguf" });
    });
    window.electron = {
      isElectron: true,
      platform: "darwin",
      localTts: {
        probe,
        generate,
        warm: vi.fn().mockResolvedValue({ warmed: true }),
        cancel,
        getCacheInfo: vi.fn().mockResolvedValue({ path: "/cache", exists: true, sizeBytes: 1 }),
        clearCache: vi.fn().mockResolvedValue({ path: "/cache", cleared: true }),
        getQwen3Setup,
        downloadQwen3Model,
        chooseQwen3ModelDir,
        subscribeQwen3DownloadProgress: vi.fn((listener) => {
          downloadProgressListener = listener;
          return () => { downloadProgressListener = null; };
        }),
        subscribeProgress: vi.fn(() => () => undefined),
        subscribeAudioChunk: vi.fn((listener) => {
          audioListener = listener;
          return () => { audioListener = null; };
        }),
      },
    };
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: vi.fn(() => "blob:audio") });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() });
  });

  afterEach(() => {
    delete window.electron;
    vi.restoreAllMocks();
  });

  it("shows the native provider and immutable runtime revision", async () => {
    renderPage();
    expect(await screen.findByText("Provider: mlx")).toBeInTheDocument();
    expect(screen.getByText(/Runtime revision: 288a716/)).toBeInTheDocument();
    expect(screen.getByText(/Revision 7dc92af14613/)).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Qwen model ready" })).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Re-download model" })).toHaveLength(1);
    expect(screen.queryByText(/device map|dtype|attention|top-p|api_server|Candle/i)).not.toBeInTheDocument();
  });

  it("generates from the cross-platform primary-modifier shortcut", async () => {
    renderPage();
    await screen.findByRole("heading", { name: "Qwen model ready" });
    await waitFor(() => expect(screen.getByRole("button", { name: "Generate" })).toBeEnabled());

    fireEvent.keyDown(document, { key: "Enter", ctrlKey: true });

    await waitFor(() => expect(generate).toHaveBeenCalledTimes(1));
  });

  it("shows clear model download progress and file details", async () => {
    getQwen3Setup.mockResolvedValue({
      ...setup,
      profiles: setup.profiles.map((profile, index) => (
        index === 0 ? { ...profile, readiness: "missing" as const } : profile
      )),
    });
    let finishDownload: ((value: Awaited<ReturnType<typeof downloadQwen3Model>>) => void) | undefined;
    downloadQwen3Model.mockReturnValue(new Promise((resolve) => { finishDownload = resolve; }));

    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Download Qwen model" }));
    act(() => {
      downloadProgressListener?.({
        modelRepo: CUSTOM_REPO,
        revision: setup.profiles[0].revision,
        modelDir: CUSTOM_PATH,
        fileName: "model.safetensors",
        fileIndex: 2,
        totalFiles: 6,
        downloadedBytes: 50 * 1024 * 1024,
        totalBytes: 100 * 1024 * 1024,
      });
    });

    expect(screen.getByText("Downloading file 2 of 6")).toBeInTheDocument();
    expect(screen.getByText("model.safetensors")).toBeInTheDocument();
    expect(screen.getByText("50.0 of 100.0 MB")).toBeInTheDocument();
    expect(screen.getByRole("progressbar", { name: "Qwen model download" })).toHaveAttribute("aria-valuenow", "25");

    await act(async () => {
      finishDownload?.({
        modelRepo: CUSTOM_REPO,
        revision: setup.profiles[0].revision,
        modelDir: CUSTOM_PATH,
        downloadedFiles: 2,
        skippedFiles: 0,
        readiness: "verified",
      });
    });
  });

  it("shows a useful recovery message when model download fails", async () => {
    getQwen3Setup.mockResolvedValue({
      ...setup,
      profiles: setup.profiles.map((profile, index) => (
        index === 0 ? { ...profile, readiness: "missing" as const } : profile
      )),
    });
    downloadQwen3Model.mockRejectedValue(new Error("Network connection was interrupted."));

    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Download Qwen model" }));

    expect(await screen.findByText("Model setup failed")).toBeInTheDocument();
    expect(screen.getByText("Network connection was interrupted.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Download Qwen model" })).toBeEnabled();
  });

  it("generates CustomVoice with only the new native request fields", async () => {
    renderPage();
    await waitFor(() => expect(screen.getByRole("button", { name: /^generate$/i })).toBeEnabled());
    fireEvent.change(screen.getByLabelText("Speaker"), { target: { value: "Ryan" } });
    fireEvent.change(screen.getByLabelText("Language"), { target: { value: "Italian" } });
    fireEvent.change(screen.getByLabelText(/Instruction/), { target: { value: "Speak warmly" } });
    fireEvent.click(screen.getByRole("button", { name: /^generate$/i }));
    await waitFor(() => expect(generate).toHaveBeenCalledOnce());
    expect(generate.mock.calls[0][0].payload).toEqual(expect.objectContaining({
      mode: "customVoice",
      modelRepo: CUSTOM_REPO,
      modelPath: CUSTOM_PATH,
      speaker: "Ryan",
      language: "Italian",
      instruct: "Speak warmly",
      temperature: 0.9,
      topK: 50,
      maxNewTokens: 1_536,
    }));
    for (const removed of ["baseModelPath", "deviceMap", "dtype", "attnImplementation", "topP"]) {
      expect(generate.mock.calls[0][0].payload).not.toHaveProperty(removed);
    }
  });

  it("generates Base voice cloning with exact transcript and WAV only", async () => {
    renderPage();
    await screen.findByRole("heading", { name: "Qwen model ready" });
    fireEvent.change(screen.getByLabelText("Model size and voice mode"), { target: { value: BASE_REPO } });
    await waitFor(() => expect(screen.getByLabelText("Model size and voice mode")).toHaveValue(BASE_REPO));
    const wav = new File([new Uint8Array([1, 2, 3])], "voice.wav", { type: "audio/wav" });
    const referenceInput = await screen.findByLabelText(/^Reference WAV/i);
    await act(async () => {
      fireEvent.change(referenceInput, { target: { files: [wav] } });
    });
    fireEvent.change(screen.getByLabelText("Exact reference transcript"), { target: { value: "Exact words" } });
    await waitFor(() => expect(screen.getByRole("button", { name: /^generate$/i })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: /^generate$/i }));
    await waitFor(() => expect(generate).toHaveBeenCalledOnce());
    expect(generate.mock.calls[0][0].payload).toEqual(expect.objectContaining({
      mode: "voiceClone",
      modelRepo: BASE_REPO,
      modelPath: BASE_PATH,
      referenceAudioBase64: "AQID",
      referenceText: "Exact words",
    }));
    expect(generate.mock.calls[0][0].payload).not.toHaveProperty("referenceAudioName");
  });

  it("uses generic choose and revision-verified download APIs", async () => {
    renderPage();
    await screen.findByRole("heading", { name: "Qwen model ready" });
    fireEvent.click(screen.getByText("Use an existing model folder"));
    fireEvent.click(screen.getByRole("button", { name: "Choose folder…" }));
    await waitFor(() => expect(chooseQwen3ModelDir).toHaveBeenCalledOnce());
    expect(screen.getByLabelText("Model directory")).toHaveValue("/chosen/model");
    fireEvent.click(screen.getByRole("button", { name: "Repair model download" }));
    await waitFor(() => expect(downloadQwen3Model).toHaveBeenCalledWith({ modelRepo: CUSTOM_REPO }));
    expect(screen.getByLabelText("Model directory")).toHaveValue(CUSTOM_PATH);
  });

  it("preserves the NeuTTS generation contract", async () => {
    probe.mockResolvedValue({ ready: true, message: "NeuTTS ready", runtime: "rust", package: "neutts" });
    renderPage("neutts");
    const codes = new File([new Uint8Array([1, 2, 3])], "voice.npy");
    const referenceInput = await screen.findByLabelText(/^Reference audio or codes/i);
    await act(async () => {
      fireEvent.change(referenceInput, { target: { files: [codes] } });
    });
    fireEvent.change(screen.getByLabelText("Reference transcript"), { target: { value: "Exact words" } });
    await waitFor(() => expect(screen.getByRole("button", { name: /^generate$/i })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: /^generate$/i }));
    await waitFor(() => expect(generate).toHaveBeenCalledOnce());
    expect(generate.mock.calls[0][0].payload).toEqual(expect.objectContaining({
      referenceCodesBase64: "AQID",
      referenceText: "Exact words",
    }));
  });
});
