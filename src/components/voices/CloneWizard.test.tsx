import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MicRecorderError, type MicRecorder, type MicRecorderOptions, type MicRecording } from "../../lib/micRecorder";
import type { NewVoice, VoiceRecord } from "../../lib/voiceLibrary/types";
import { encodeWavPcm16 } from "../../lib/wavCodec";
import type { AuditionAudio } from "../../hooks/useAudition";
import { CloneWizard, type CloneWizardProps } from "./CloneWizard";

const RATE = 24_000;

function speech(seconds: number): Float32Array {
  const out = new Float32Array(Math.round(seconds * RATE));
  for (let index = 0; index < out.length; index += 1) {
    out[index] = 0.18 * (0.6 + 0.4 * Math.sin((index / RATE) * 6)) * (Math.sin(index / 9) + 0.5 * Math.sin(index / 4.1));
  }
  return out;
}

function wavFile(samples: Float32Array, name = "narrator.wav"): File {
  return new File([encodeWavPcm16(samples, RATE) as BlobPart], name, { type: "audio/wav" });
}

class FakeAudio implements AuditionAudio {
  onended: ((event: Event) => void) | null = null;
  onerror: ((event: Event | string) => void) | null = null;
  play = vi.fn(async () => undefined);
  pause = vi.fn();
}

function fakeRecorder(recording: MicRecording | MicRecorderError) {
  let options!: MicRecorderOptions;
  const createRecorder = (given: MicRecorderOptions): MicRecorder => {
    options = given;
    return {
      getState: () => "idle",
      getMode: () => null,
      start: async () => {
        if (recording instanceof MicRecorderError) throw recording;
        options.onStateChange?.("recording");
        options.onLevel?.({ peak: 0.4, rms: 0.2, dbfs: -14, elapsedSec: 2.5 });
      },
      stop: async () => {
        options.onStateChange?.("idle");
        if (recording instanceof MicRecorderError) throw recording;
        return recording;
      },
      cancel: () => options.onStateChange?.("idle"),
    };
  };
  return createRecorder;
}

const TRANSCRIPT = "the quick brown fox jumps over the lazy dog and keeps on running far away from here today";

describe("CloneWizard", () => {
  let createVoice: ReturnType<typeof vi.fn<(input: NewVoice) => Promise<VoiceRecord>>>;
  let onUse: ReturnType<typeof vi.fn<NonNullable<CloneWizardProps["onUse"]>>>;

  beforeEach(() => {
    vi.stubGlobal("URL", Object.assign(Object.create(URL), { createObjectURL: () => "blob:x", revokeObjectURL: () => undefined }));
    createVoice = vi.fn(async (input: NewVoice) => ({
      schemaVersion: 1,
      id: "saved-1",
      name: input.name,
      description: "",
      tags: [],
      favorite: false,
      createdAt: 1,
      updatedAt: 1,
      kind: "cloned",
      transcript: input.kind === "cloned" ? input.transcript : "",
      language: "English",
      targets: ["qwen3-base"],
      source: "upload",
      reference: { sampleRate: 24000, durationSec: 6, byteLength: 10, sha256: "a".repeat(64) },
    }) as VoiceRecord);
    onUse = vi.fn(async () => ({ ok: true, message: "Using it in Studio." }));
  });
  afterEach(() => vi.unstubAllGlobals());

  function renderWizard(props: Partial<CloneWizardProps> = {}) {
    return render(<CloneWizard library={{ createVoice }} onUse={onUse} createAudio={() => new FakeAudio()} {...props} />);
  }

  async function chooseFile(file: File) {
    const input = screen.getByLabelText("WAV file");
    await act(async () => { fireEvent.change(input, { target: { files: [file] } }); });
  }

  it("takes a WAV through trim, checks, transcript and save, then opens it in Studio", async () => {
    renderWizard();
    expect(screen.getByRole("button", { name: /^next/i })).toBeDisabled();
    await chooseFile(wavFile(speech(7)));
    expect(await screen.findByText(/Ready: narrator, 7\.0 s/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^next/i }));

    expect(screen.getByRole("img", { name: /Waveform of the 7\.\d+ s clip/ })).toBeInTheDocument();
    expect(screen.getByLabelText("Trim start")).toBeInTheDocument();
    const checks = screen.getByRole("list", { name: "Recording quality checks" });
    expect(within(checks).getAllByRole("listitem").length).toBeGreaterThan(3);
    fireEvent.click(screen.getByRole("button", { name: /^next/i }));

    expect(screen.getByRole("button", { name: /^next/i })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Transcript"), { target: { value: TRANSCRIPT } });
    fireEvent.click(screen.getByRole("button", { name: /^next/i }));

    expect(screen.getByLabelText("Voice name")).toHaveValue("narrator");
    fireEvent.change(screen.getByLabelText("Voice name"), { target: { value: "Narrator" } });
    fireEvent.click(screen.getByRole("button", { name: "Save to My Voices" }));
    await screen.findByText(/Saved “Narrator” to My Voices/);

    expect(createVoice).toHaveBeenCalledTimes(1);
    expect(createVoice.mock.calls[0][0]).toMatchObject({
      kind: "cloned",
      name: "Narrator",
      transcript: TRANSCRIPT,
      targets: ["qwen3-base"],
      source: "upload",
      language: "English",
    });
    fireEvent.click(screen.getByRole("button", { name: "Use in Studio" }));
    await screen.findByText("Using it in Studio.");
    expect(onUse).toHaveBeenCalledWith(expect.objectContaining({ id: "saved-1" }), "studio");
  });

  it("keeps keyboard focus inside the wizard as steps replace the pressed button", async () => {
    renderWizard();
    await chooseFile(wavFile(speech(7)));
    await screen.findByText(/Ready: narrator, 7\.0 s/);
    fireEvent.click(screen.getByRole("button", { name: /^next/i }));
    fireEvent.click(screen.getByRole("button", { name: /^next/i }));
    fireEvent.change(screen.getByLabelText("Transcript"), { target: { value: TRANSCRIPT } });

    // Next disappears on the last step; focus lands on its first field.
    const next = screen.getByRole("button", { name: /^next/i });
    next.focus();
    fireEvent.click(next);
    expect(screen.getByLabelText("Voice name")).toHaveFocus();

    // Save is replaced by the saved message and its actions.
    const save = screen.getByRole("button", { name: "Save to My Voices" });
    save.focus();
    await act(async () => { fireEvent.click(save); });
    await screen.findByText(/Saved “narrator” to My Voices/);
    expect(document.activeElement).not.toBe(document.body);
    expect(screen.getByRole("region", { name: "Instant voice cloning" }).contains(document.activeElement)).toBe(true);
  });

  it("blocks a clip that fails a target's hard limit until it is fixed", async () => {
    renderWizard();
    await chooseFile(wavFile(speech(14)));
    fireEvent.click(await screen.findByRole("button", { name: /^next/i }));
    fireEvent.click(screen.getByLabelText(/Chatterbox Turbo/));
    expect(screen.getByText(/Chatterbox Turbo rejects references longer than 10 s/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^next/i })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Trim end"), { target: { value: "9" } });
    await waitFor(() => expect(screen.getByRole("button", { name: /^next/i })).toBeEnabled());
  });

  it("does not ask for a transcript when Chatterbox is the only target", async () => {
    renderWizard();
    await chooseFile(wavFile(speech(7)));
    fireEvent.click(await screen.findByRole("button", { name: /^next/i }));
    fireEvent.click(screen.getByLabelText(/Chatterbox Turbo/));
    fireEvent.click(screen.getByLabelText(/Qwen3 Base/));
    fireEvent.click(screen.getByRole("button", { name: /^next/i }));
    expect(screen.getByText(/transcript is optional/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^next/i })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: /^next/i }));
    fireEvent.click(screen.getByRole("button", { name: "Save to My Voices" }));
    await screen.findByText(/Saved/);
    expect(createVoice.mock.calls[0][0]).toMatchObject({ targets: ["chatterbox"], transcript: "" });
  });

  it("records from the microphone, shows the level, and uses the recording", async () => {
    const samples = speech(6);
    const recording: MicRecording = {
      samples,
      sampleRate: RATE,
      durationSec: 6,
      wav: encodeWavPcm16(samples, RATE),
      mode: "worklet",
      stoppedBy: "user",
    };
    renderWizard({ createRecorder: fakeRecorder(recording) });
    fireEvent.click(screen.getByRole("button", { name: /start recording/i }));
    expect(await screen.findByRole("progressbar", { name: "Input level" })).toHaveAttribute("aria-valuenow", "40");
    expect(screen.getByText("2.5 s")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /stop recording/i }));
    fireEvent.click(await screen.findByRole("button", { name: "Use this recording" }));
    expect(await screen.findByText(/Ready: My recording, 6\.0 s/)).toBeInTheDocument();
  });

  it("stops recording when the wizard is hidden and keeps the take", async () => {
    const samples = speech(4);
    const recording: MicRecording = { samples, sampleRate: RATE, durationSec: 4, wav: encodeWavPcm16(samples, RATE), mode: "worklet", stoppedBy: "user" };
    const createRecorder = fakeRecorder(recording);
    const createAudio = () => new FakeAudio();
    const view = renderWizard({ createRecorder, createAudio });
    fireEvent.click(screen.getByRole("button", { name: /start recording/i }));
    await screen.findByRole("button", { name: /stop recording/i });
    view.rerender(<CloneWizard library={{ createVoice }} onUse={onUse} createAudio={createAudio} createRecorder={createRecorder} active={false} />);
    await waitFor(() => expect(screen.queryByRole("button", { name: /stop recording/i })).toBeNull());
    expect(await screen.findByRole("button", { name: "Use this recording" })).toBeInTheDocument();
  });

  it("abandons a transcription still running when the wizard unmounts", async () => {
    let seen: AbortSignal | undefined;
    const transcribe = vi.fn((_clip: unknown, signal: AbortSignal) => { seen = signal; return new Promise<string>(() => undefined); });
    const view = renderWizard({ transcribe });
    await chooseFile(wavFile(speech(7)));
    fireEvent.click(await screen.findByRole("button", { name: /^next/i }));
    fireEvent.click(screen.getByRole("button", { name: /^next/i }));
    fireEvent.click(screen.getByRole("button", { name: "Transcribe automatically" }));
    await waitFor(() => expect(seen).toBeDefined());
    expect(seen?.aborted).toBe(false);
    view.unmount();
    expect(seen?.aborted).toBe(true);
  });

  it("explains a denied microphone", async () => {
    renderWizard({ createRecorder: fakeRecorder(new MicRecorderError("permission-denied", "Microphone access was denied.")) });
    fireEvent.click(screen.getByRole("button", { name: /start recording/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Microphone access was denied.");
  });

  it("rejects files that are not WAV audio", async () => {
    renderWizard();
    await chooseFile(new File(["not audio"], "notes.wav", { type: "audio/wav" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/RIFF\/WAVE/);
    expect(screen.getByRole("button", { name: /^next/i })).toBeDisabled();
  });

  it("offers automatic transcription only when a transcriber is provided", async () => {
    const transcribe = vi.fn(async () => "  what the clip says  ");
    const first = renderWizard();
    await chooseFile(wavFile(speech(7)));
    fireEvent.click(await screen.findByRole("button", { name: /^next/i }));
    fireEvent.click(screen.getByRole("button", { name: /^next/i }));
    expect(screen.queryByRole("button", { name: /transcribe/i })).toBeNull();
    first.unmount();

    renderWizard({ transcribe });
    await chooseFile(wavFile(speech(7)));
    fireEvent.click(await screen.findByRole("button", { name: /^next/i }));
    fireEvent.click(screen.getByRole("button", { name: /^next/i }));
    fireEvent.click(screen.getByRole("button", { name: "Transcribe automatically" }));
    await waitFor(() => expect(screen.getByLabelText("Transcript")).toHaveValue("what the clip says"));
    expect(transcribe).toHaveBeenCalledWith(expect.objectContaining({ sampleRate: RATE, language: "English" }), expect.any(AbortSignal));
  });

  it("shows the library's reason when saving fails", async () => {
    createVoice.mockRejectedValueOnce(new Error("The voice library is full."));
    renderWizard();
    await chooseFile(wavFile(speech(7)));
    fireEvent.click(await screen.findByRole("button", { name: /^next/i }));
    fireEvent.click(screen.getByRole("button", { name: /^next/i }));
    fireEvent.change(screen.getByLabelText("Transcript"), { target: { value: TRANSCRIPT } });
    fireEvent.click(screen.getByRole("button", { name: /^next/i }));
    fireEvent.click(screen.getByRole("button", { name: "Save to My Voices" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("The voice library is full.");
  });
});
