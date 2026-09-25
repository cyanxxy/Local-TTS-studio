import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Qwen3RuntimeProvider, useQwen3Runtime } from "../contexts/Qwen3RuntimeContext";
import { Qwen3InlineSettings } from "./Qwen3InlineSettings";

const SMALL_CUSTOM_REPO = "mlx-community/Qwen3-TTS-12Hz-0.6B-CustomVoice-6bit";
const LARGE_CUSTOM_REPO = "mlx-community/Qwen3-TTS-12Hz-1.7B-CustomVoice-6bit";
const BASE_REPO = "mlx-community/Qwen3-TTS-12Hz-0.6B-Base-6bit";

function ProfileSwitcher() {
  const qwen = useQwen3Runtime();
  return (
    <>
      <button onClick={() => qwen.setProfileRepo(SMALL_CUSTOM_REPO)}>small</button>
      <button onClick={() => qwen.setProfileRepo(LARGE_CUSTOM_REPO)}>large</button>
      <button onClick={() => qwen.setProfileRepo(BASE_REPO)}>base</button>
      <button onClick={() => qwen.setReferenceAudio("short.wav", "AQID", "sig", 1.5)}>short clip</button>
      <button onClick={() => qwen.setReferenceAudio("long.wav", "AQID", "sig", 8)}>good clip</button>
    </>
  );
}

async function renderSettings() {
  await act(async () => {
    render(
      <Qwen3RuntimeProvider>
        <ProfileSwitcher />
        <Qwen3InlineSettings />
      </Qwen3RuntimeProvider>,
    );
  });
}

beforeEach(() => {
  window.electron = {
    isElectron: true,
    platform: "darwin",
    arch: "arm64",
    localTts: {
      getQwen3Setup: vi.fn().mockResolvedValue({
        provider: "mlx",
        profiles: [],
        recommendedModelRepo: SMALL_CUSTOM_REPO,
        recommendedModelDir: "/models/custom",
      }),
      subscribeQwen3DownloadProgress: vi.fn(() => () => undefined),
    },
  } as never;
});

afterEach(() => {
  delete window.electron;
});

describe("Qwen3InlineSettings", () => {
  it("hides the style instruction for 0.6B CustomVoice, which ignores it", async () => {
    await renderSettings();
    fireEvent.click(screen.getByText("small"));
    expect(screen.queryByLabelText("Qwen voice instruction")).not.toBeInTheDocument();
    fireEvent.click(screen.getByText("large"));
    await waitFor(() => expect(screen.getByLabelText("Qwen voice instruction")).toBeInTheDocument());
  });

  it("labels max tokens as the per-passage limit the bridge enforces", async () => {
    await renderSettings();
    const maxTokens = screen.getByLabelText("Qwen max tokens per passage");
    expect(maxTokens).toHaveAttribute("max", "384");
    expect(maxTokens).toHaveValue(384);
    expect(screen.getByText(/Each passage stops at 384 tokens/)).toBeInTheDocument();

    const seed = screen.getByLabelText("Qwen seed");
    expect(seed).toHaveValue(null);
    fireEvent.change(seed, { target: { value: "99" } });
    expect(seed).toHaveValue(99);
    fireEvent.change(seed, { target: { value: "" } });
    expect(seed).toHaveValue(null);
  });

  it("flags a voice-clone reference shorter than three seconds", async () => {
    await renderSettings();
    fireEvent.click(screen.getByText("base"));
    fireEvent.click(screen.getByText("short clip"));
    expect(await screen.findByText(/This clip is only 1\.5 s/)).toBeInTheDocument();
    fireEvent.click(screen.getByText("good clip"));
    expect(screen.queryByText(/This clip is only/)).not.toBeInTheDocument();
  });
});
