import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Qwen3RuntimeProvider, useQwen3Runtime } from "./Qwen3RuntimeContext";

const CUSTOM_REPO = "mlx-community/Qwen3-TTS-12Hz-0.6B-CustomVoice-6bit";
const BASE_REPO = "mlx-community/Qwen3-TTS-12Hz-0.6B-Base-6bit";

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
      <output>{`${state.profile.repo}|${state.speaker}|${state.language}|${state.modelPath}`}</output>
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

  it("stays inert when the Electron bridge is absent", async () => {
    function Availability() {
      return <output>{String(useQwen3Runtime().available)}</output>;
    }
    await act(async () => {
      render(<Qwen3RuntimeProvider><Availability /></Qwen3RuntimeProvider>);
    });
    expect(screen.getByRole("status")).toHaveTextContent("false");
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
