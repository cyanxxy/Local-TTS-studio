import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Qwen3RuntimeProvider, useQwen3Runtime } from "./Qwen3RuntimeContext";

const CUSTOM_REPO = "mlx-community/Qwen3-TTS-12Hz-0.6B-CustomVoice-6bit";
const BASE_REPO = "mlx-community/Qwen3-TTS-12Hz-0.6B-Base-6bit";
const DESIGN_REPO = "mlx-community/Qwen3-TTS-12Hz-1.7B-VoiceDesign-6bit";

function setupResult() {
  const profile = (repo: string, mode: "customVoice" | "voiceClone", modelDir: string) => ({
    repo,
    revision: "a".repeat(40),
    mode,
    parameters: "0.6B" as const,
    provider: "mlx" as const,
    platforms: ["darwin" as const],
    weightFormat: "mlx-6bit" as const,
    label: repo,
    requiredFiles: ["config.json"],
    modelDir,
    readiness: "verified" as const,
  });
  return {
    provider: "mlx" as const,
    profiles: [
      profile(CUSTOM_REPO, "customVoice", "/models/custom"),
      profile(BASE_REPO, "voiceClone", "/models/base"),
    ],
    recommendedModelRepo: CUSTOM_REPO,
    recommendedModelDir: "/models/custom",
  };
}

function Consumer({ name }: { name: string }) {
  const state = useQwen3Runtime();
  return (
    <section aria-label={name}>
      <output>{`${state.profile.repo}|${state.speaker}|${state.language}|${state.maxNewTokens}|${state.modelPath}`}</output>
      <button onClick={() => state.setSpeaker("Ryan")}>Ryan</button>
      <button onClick={() => state.setLanguage("Italian")}>Italian</button>
      <button onClick={() => state.setProfileRepo(BASE_REPO)}>Base</button>
    </section>
  );
}

afterEach(() => {
  delete window.electron;
});

describe("Qwen3RuntimeProvider", () => {
  it("shares settings across Studio, Reader, and the Qwen page", async () => {
    window.electron = {
      isElectron: true,
      platform: "darwin",
      arch: "arm64",
      localTts: {
        getQwen3Setup: vi.fn().mockResolvedValue(setupResult()),
        subscribeQwen3DownloadProgress: vi.fn(() => () => undefined),
      },
    } as never;
    render(
      <Qwen3RuntimeProvider>
        <Consumer name="studio" />
        <Consumer name="settings" />
      </Qwen3RuntimeProvider>,
    );
    await waitFor(() => expect(screen.getByLabelText("studio")).toHaveTextContent("/models/custom"));
    expect(screen.getByLabelText("studio")).toHaveTextContent("Aiden|English|384");
    fireEvent.click(screen.getByLabelText("settings").querySelectorAll("button")[0]);
    fireEvent.click(screen.getByLabelText("settings").querySelectorAll("button")[1]);
    expect(screen.getByLabelText("studio")).toHaveTextContent("Ryan|Italian");
  });

  it("switches to the selected profile path and clears incompatible reference state", async () => {
    window.electron = {
      isElectron: true,
      platform: "darwin",
      arch: "arm64",
      localTts: {
        getQwen3Setup: vi.fn().mockResolvedValue(setupResult()),
        subscribeQwen3DownloadProgress: vi.fn(() => () => undefined),
      },
    } as never;
    function ProfileConsumer() {
      const state = useQwen3Runtime();
      return (
        <>
          <output>{`${state.profile.mode}|${state.modelPath}|${state.readiness}`}</output>
          <button onClick={() => state.setReferenceAudio("old.wav", "AQID")}>reference</button>
          <button onClick={() => state.setProfileRepo(BASE_REPO)}>base</button>
          <span>{state.referenceAudioName || "empty"}</span>
        </>
      );
    }
    render(<Qwen3RuntimeProvider><ProfileConsumer /></Qwen3RuntimeProvider>);
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("/models/custom"));
    await act(async () => {
      fireEvent.click(screen.getByText("reference"));
      fireEvent.click(screen.getByText("base"));
    });
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("voiceClone|/models/base|verified"));
    expect(screen.getByText("empty")).toBeInTheDocument();
  });

  it("keeps VoiceDesign and CustomVoice instructions separate across profile switches", async () => {
    window.electron = {
      isElectron: true,
      platform: "darwin",
      arch: "arm64",
      localTts: {
        getQwen3Setup: vi.fn().mockResolvedValue(setupResult()),
        subscribeQwen3DownloadProgress: vi.fn(() => () => undefined),
      },
    } as never;
    function InstructConsumer() {
      const state = useQwen3Runtime();
      return (
        <>
          <output>{`${state.profile.mode}|${state.instruct || "empty"}`}</output>
          <button onClick={() => state.setInstruct("Calm and slow.")}>style</button>
          <button onClick={() => state.setInstruct("A deep, gravelly narrator.")}>describe</button>
          <button onClick={() => state.setProfileRepo(CUSTOM_REPO)}>custom</button>
          <button onClick={() => state.setProfileRepo(DESIGN_REPO)}>design</button>
          <button onClick={() => state.setProfileRepo(BASE_REPO)}>base</button>
        </>
      );
    }
    render(<Qwen3RuntimeProvider><InstructConsumer /></Qwen3RuntimeProvider>);
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("customVoice|empty"));

    fireEvent.click(screen.getByText("style"));
    expect(screen.getByRole("status")).toHaveTextContent("customVoice|Calm and slow.");
    fireEvent.click(screen.getByText("design"));
    expect(screen.getByRole("status")).toHaveTextContent("voiceDesign|empty");
    fireEvent.click(screen.getByText("describe"));
    expect(screen.getByRole("status")).toHaveTextContent("voiceDesign|A deep, gravelly narrator.");

    fireEvent.click(screen.getByText("base"));
    expect(screen.getByRole("status")).toHaveTextContent("voiceClone|empty");
    fireEvent.click(screen.getByText("style"));
    expect(screen.getByRole("status")).toHaveTextContent("voiceClone|empty");

    fireEvent.click(screen.getByText("custom"));
    expect(screen.getByRole("status")).toHaveTextContent("customVoice|Calm and slow.");
    fireEvent.click(screen.getByText("design"));
    expect(screen.getByRole("status")).toHaveTextContent("voiceDesign|A deep, gravelly narrator.");
  });

  it("bounds max tokens to the per-passage cap and validates the seed", async () => {
    function LimitsConsumer() {
      const state = useQwen3Runtime();
      return (
        <>
          <output>{`${state.maxNewTokens}|${state.seed ?? "random"}`}</output>
          <button onClick={() => state.setMaxNewTokens(4_096)}>max</button>
          <button onClick={() => state.setMaxNewTokens(1)}>min</button>
          <button onClick={() => state.setSeed(41.6)}>seed</button>
          <button onClick={() => state.setSeed(Number.NaN)}>nan</button>
          <button onClick={() => state.setSeed(null)}>clear</button>
        </>
      );
    }
    await act(async () => {
      render(<Qwen3RuntimeProvider><LimitsConsumer /></Qwen3RuntimeProvider>);
    });
    expect(screen.getByRole("status")).toHaveTextContent("384|random");
    fireEvent.click(screen.getByText("max"));
    expect(screen.getByRole("status")).toHaveTextContent("384|");
    fireEvent.click(screen.getByText("min"));
    expect(screen.getByRole("status")).toHaveTextContent("64|");
    fireEvent.click(screen.getByText("seed"));
    expect(screen.getByRole("status")).toHaveTextContent("64|42");
    fireEvent.click(screen.getByText("nan"));
    expect(screen.getByRole("status")).toHaveTextContent("64|42");
    fireEvent.click(screen.getByText("clear"));
    expect(screen.getByRole("status")).toHaveTextContent("64|random");
  });

  it("stays inert when the Electron bridge is absent", async () => {
    function Availability() {
      return <output>{String(useQwen3Runtime().available)}</output>;
    }
    await act(async () => {
      render(<Qwen3RuntimeProvider><Availability /></Qwen3RuntimeProvider>);
    });
    expect(screen.getByRole("status")).toHaveTextContent("false");
  });

  it("preserves an external model selection through inventory refreshes and profile switches", async () => {
    const getQwen3Setup = vi.fn().mockResolvedValue(setupResult());
    window.electron = {
      isElectron: true, platform: "darwin", arch: "arm64",
      localTts: {
        getQwen3Setup,
        chooseQwen3ModelDir: vi.fn().mockResolvedValue({ path: "/external/custom", readiness: "structural" }),
      },
    } as never;
    function ModelConsumer() {
      const state = useQwen3Runtime();
      return <>
        <output>{`${state.modelPath}|${state.readiness}|${state.setupBusy}`}</output>
        <button onClick={() => void state.chooseModelPath()}>choose</button>
        <button onClick={() => void state.refreshSetup()}>refresh</button>
        <button onClick={() => state.setProfileRepo(BASE_REPO)}>base</button>
        <button onClick={() => state.setProfileRepo(CUSTOM_REPO)}>custom</button>
      </>;
    }
    render(<Qwen3RuntimeProvider><ModelConsumer /></Qwen3RuntimeProvider>);
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("/models/custom|verified|false"));
    fireEvent.click(screen.getByText("choose"));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("/external/custom|structural|false"));

    // The managed copy may be missing; that says nothing about the selected external copy.
    const missingManaged = setupResult();
    getQwen3Setup.mockResolvedValue({ ...missingManaged, profiles: missingManaged.profiles.map((p) => ({ ...p, readiness: "missing" })) });
    await act(async () => { fireEvent.click(screen.getByText("refresh")); });
    expect(screen.getByRole("status")).toHaveTextContent("/external/custom|structural|false");
    await act(async () => { fireEvent.click(screen.getByText("base")); });
    expect(screen.getByRole("status")).toHaveTextContent("/models/base|missing|false");
    await act(async () => { fireEvent.click(screen.getByText("custom")); });
    expect(screen.getByRole("status")).toHaveTextContent("/external/custom|structural|false");
  });

  it("keeps a path edit authoritative over an in-flight inventory refresh", async () => {
    let finishRefresh!: (setup: ReturnType<typeof setupResult>) => void;
    const getQwen3Setup = vi.fn().mockResolvedValueOnce(setupResult()).mockImplementation(() => new Promise((resolve) => {
      finishRefresh = resolve;
    }));
    window.electron = {
      isElectron: true, platform: "darwin", arch: "arm64", localTts: { getQwen3Setup },
    } as never;
    function ModelConsumer() {
      const state = useQwen3Runtime();
      return <>
        <output>{`${state.modelPath}|${state.readiness}|${state.setupBusy}`}</output>
        <button onClick={() => void state.refreshSetup()}>refresh</button>
        <button onClick={() => state.setModelPath("/typed/custom")}>edit</button>
        <button onClick={() => state.setModelPath("")}>empty</button>
      </>;
    }
    render(<Qwen3RuntimeProvider><ModelConsumer /></Qwen3RuntimeProvider>);
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("/models/custom|verified|false"));
    fireEvent.click(screen.getByText("refresh"));
    expect(screen.getByRole("status")).toHaveTextContent("|true");
    fireEvent.click(screen.getByText("edit"));
    await act(async () => { finishRefresh(setupResult()); });
    expect(screen.getByRole("status")).toHaveTextContent("/typed/custom|structural|false");
    fireEvent.click(screen.getByText("empty"));
    expect(screen.getByRole("status")).toHaveTextContent("|missing|false");
  });

  it("selects the managed model after an explicit successful download", async () => {
    window.electron = {
      isElectron: true, platform: "darwin", arch: "arm64",
      localTts: {
        getQwen3Setup: vi.fn().mockResolvedValue(setupResult()),
        downloadQwen3Model: vi.fn().mockResolvedValue({ modelDir: "/models/custom", readiness: "verified" }),
      },
    } as never;
    function ModelConsumer() {
      const state = useQwen3Runtime();
      return <>
        <output>{`${state.modelPath}|${state.readiness}|${state.downloadBusy}`}</output>
        <button onClick={() => state.setModelPath("/external/custom")}>edit</button>
        <button onClick={() => void state.downloadModel()}>download</button>
        <button onClick={() => void state.refreshSetup()}>refresh</button>
      </>;
    }
    render(<Qwen3RuntimeProvider><ModelConsumer /></Qwen3RuntimeProvider>);
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("/models/custom|verified|false"));
    fireEvent.click(screen.getByText("edit"));
    expect(screen.getByRole("status")).toHaveTextContent("/external/custom|structural|false");
    await act(async () => { fireEvent.click(screen.getByText("download")); });
    await act(async () => { fireEvent.click(screen.getByText("refresh")); });
    expect(screen.getByRole("status")).toHaveTextContent("/models/custom|verified|false");
  });

  it("does not apply an old profile download after the selected profile changes", async () => {
    let finishDownload!: (value: {
      modelRepo: string;
      revision: string;
      modelDir: string;
      downloadedFiles: number;
      skippedFiles: number;
      readiness: "verified";
    }) => void;
    const download = new Promise<Parameters<typeof finishDownload>[0]>((resolve) => {
      finishDownload = resolve;
    });
    window.electron = {
      isElectron: true,
      platform: "darwin",
      arch: "arm64",
      localTts: {
        getQwen3Setup: vi.fn().mockResolvedValue(setupResult()),
        downloadQwen3Model: vi.fn(() => download),
        subscribeQwen3DownloadProgress: vi.fn(() => () => undefined),
      },
    } as never;
    function RaceConsumer() {
      const state = useQwen3Runtime();
      return (
        <>
          <output>{`${state.profile.repo}|${state.modelPath}`}</output>
          <button onClick={() => void state.downloadModel()}>download</button>
          <button onClick={() => state.setProfileRepo(BASE_REPO)}>base</button>
        </>
      );
    }
    render(<Qwen3RuntimeProvider><RaceConsumer /></Qwen3RuntimeProvider>);
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("/models/custom"));
    fireEvent.click(screen.getByText("download"));
    fireEvent.click(screen.getByText("base"));

    await act(async () => {
      finishDownload({
        modelRepo: CUSTOM_REPO,
        revision: "a".repeat(40),
        modelDir: "/downloaded/old-custom",
        downloadedFiles: 1,
        skippedFiles: 0,
        readiness: "verified",
      });
      await download;
    });

    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent(`${BASE_REPO}|/models/base`));
    expect(screen.getByRole("status")).not.toHaveTextContent("/downloaded/old-custom");
  });
});
