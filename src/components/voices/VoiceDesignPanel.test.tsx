import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PresetSynthesize } from "../../lib/presetSynthesis";
import type { NewVoice, VoiceRecord } from "../../lib/voiceLibrary/types";
import type { AuditionAudio } from "../../hooks/useAudition";
import { VoiceDesignPanel, type VoiceDesignPanelProps } from "./VoiceDesignPanel";

const RATE = 24_000;

function speech(seconds: number, seed: number): Float32Array {
  const out = new Float32Array(Math.round(seconds * RATE));
  for (let index = 0; index < out.length; index += 1) {
    out[index] = 0.18 * (0.6 + 0.4 * Math.sin((index / RATE) * 6)) * (Math.sin(index / (8 + (seed % 5))) + 0.5 * Math.sin(index / 4.1));
  }
  return out;
}

class FakeAudio implements AuditionAudio {
  onended: ((event: Event) => void) | null = null;
  onerror: ((event: Event | string) => void) | null = null;
  play = vi.fn(async () => undefined);
  pause = vi.fn();
}

describe("VoiceDesignPanel", () => {
  let createVoices: ReturnType<typeof vi.fn<(inputs: readonly NewVoice[]) => Promise<VoiceRecord[]>>>;
  let synthesize: ReturnType<typeof vi.fn<PresetSynthesize>>;
  let onUse: ReturnType<typeof vi.fn<NonNullable<VoiceDesignPanelProps["onUse"]>>>;
  let audios: FakeAudio[];

  beforeEach(() => {
    vi.stubGlobal("URL", Object.assign(Object.create(URL), { createObjectURL: () => "blob:x", revokeObjectURL: () => undefined }));
    audios = [];
    createVoices = vi.fn(async (inputs: readonly NewVoice[]) => inputs.map((input, index) => ({
      schemaVersion: 1,
      id: `saved-${index}`,
      name: input.name,
      description: "",
      tags: [],
      favorite: false,
      createdAt: 1,
      updatedAt: 1,
      kind: "designed",
      design: { description: "d", seed: 1, language: "English", previewText: "x" },
    }) as VoiceRecord));
    synthesize = vi.fn<PresetSynthesize>(async function* (_text, preset) {
      yield { audio: speech(6, preset.settings.seed ?? 0), samplingRate: RATE };
    });
    onUse = vi.fn(async () => ({ ok: true, message: "Using it." }));
  });
  afterEach(() => vi.unstubAllGlobals());

  function renderPanel(props: Partial<VoiceDesignPanelProps> = {}) {
    return render(
      <VoiceDesignPanel
        library={{ createVoices }}
        synthesize={synthesize}
        available
        onUse={onUse}
        createAudio={() => { const audio = new FakeAudio(); audios.push(audio); return audio; }}
        {...props}
      />,
    );
  }

  async function generate() {
    fireEvent.change(screen.getByLabelText("Voice description"), { target: { value: "A warm, low narrator" } });
    fireEvent.click(screen.getByRole("button", { name: "Generate 3 previews" }));
    await waitFor(() => expect(screen.getAllByText(/^Ready/)).toHaveLength(3));
  }

  it("renders three seeded previews of the description, one after another", async () => {
    renderPanel();
    await generate();
    expect(synthesize).toHaveBeenCalledTimes(3);
    const seeds = synthesize.mock.calls.map(([, preset]) => preset.settings.seed);
    expect(new Set(seeds).size).toBe(3);
    expect(synthesize.mock.calls[0][1]).toMatchObject({ engineId: "qwen3", mode: "voiceDesign", settings: { instruction: "A warm, low narrator", language: "English" } });
    expect(synthesize.mock.calls[0][0]).toMatch(/Hello there/);
  });

  it("auditions a preview and replaces it with a new seed", async () => {
    renderPanel();
    await generate();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Play preview 2" })); });
    expect(audios).toHaveLength(1);
    expect(audios[0].play).toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Stop preview 2" })).toBeInTheDocument();

    const before = screen.getAllByText(/^seed /).map((node) => node.textContent);
    fireEvent.click(screen.getByRole("button", { name: "New seed for preview 2" }));
    await waitFor(() => expect(synthesize).toHaveBeenCalledTimes(4));
    await waitFor(() => expect(screen.getAllByText(/^Ready/)).toHaveLength(3));
    const after = screen.getAllByText(/^seed /).map((node) => node.textContent);
    expect(after[0]).toBe(before[0]);
    expect(after[1]).not.toBe(before[1]);
  });

  it("saves the chosen preview as a designed voice", async () => {
    renderPanel();
    await generate();
    expect(screen.queryByLabelText("Designed voice name")).toBeNull();
    fireEvent.click(screen.getByLabelText("Choose preview 3"));
    fireEvent.change(await screen.findByLabelText("Designed voice name"), { target: { value: "Low narrator" } });
    fireEvent.click(screen.getByRole("button", { name: "Save voice" }));
    await screen.findByText(/Saved “Low narrator” to My Voices\./);
    expect(createVoices).toHaveBeenCalledTimes(1);
    const inputs = createVoices.mock.calls[0][0];
    expect(inputs).toHaveLength(1);
    expect(inputs[0]).toMatchObject({ kind: "designed", name: "Low narrator", design: { description: "A warm, low narrator", language: "English" } });
    fireEvent.click(screen.getByRole("button", { name: "Use in Reader" }));
    await screen.findByText("Using it.");
    expect(onUse).toHaveBeenCalledWith(expect.objectContaining({ name: "Low narrator" }), "reader");
  });

  it("saves a linked Qwen3 Base clone in the same call when asked", async () => {
    renderPanel();
    await generate();
    fireEvent.click(screen.getByLabelText("Choose preview 1"));
    fireEvent.change(await screen.findByLabelText("Designed voice name"), { target: { value: "Pair" } });
    fireEvent.click(screen.getByLabelText(/Also save as a Qwen3 Base clone/));
    fireEvent.click(screen.getByRole("button", { name: "Save voice" }));
    await screen.findByText(/with a Qwen3 Base clone/);
    const inputs = createVoices.mock.calls[0][0];
    expect(inputs.map((input) => input.kind)).toEqual(["designed", "cloned"]);
    expect(inputs[1]).toMatchObject({ kind: "cloned", source: "voiceDesign", targets: ["qwen3-base"], designedFromId: inputs[0].id });
  });

  it("keeps a failed preview from blocking the others", async () => {
    synthesize.mockImplementationOnce(async function* () {
      throw new Error("Model crashed");
      yield { audio: new Float32Array(1), samplingRate: RATE };
    });
    renderPanel();
    fireEvent.change(screen.getByLabelText("Voice description"), { target: { value: "Bright and quick" } });
    fireEvent.click(screen.getByRole("button", { name: "Generate 3 previews" }));
    await screen.findByText("Model crashed");
    await waitFor(() => expect(screen.getAllByText(/^Ready/)).toHaveLength(2));
    expect(screen.getByLabelText("Choose preview 1")).toBeDisabled();
  });

  it("explains a missing model and blocks generating", () => {
    renderPanel({ available: false, unavailableReason: "Install VoiceDesign first." });
    expect(screen.getByText("Install VoiceDesign first.")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Voice description"), { target: { value: "Anything" } });
    expect(screen.getByRole("button", { name: "Generate 3 previews" })).toBeDisabled();
  });

  it("shows planning errors, such as a preview sentence that is too long", async () => {
    renderPanel();
    fireEvent.change(screen.getByLabelText("Voice description"), { target: { value: "A voice" } });
    fireEvent.change(screen.getByLabelText("Preview sentence"), { target: { value: "This is a very long sentence. ".repeat(20) } });
    fireEvent.click(screen.getByRole("button", { name: "Generate 3 previews" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/one or two short sentences/);
    expect(synthesize).not.toHaveBeenCalled();
  });
});
