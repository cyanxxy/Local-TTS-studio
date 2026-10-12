import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { addChatterboxClipFromWav, getChatterboxClips, removeChatterboxClip } from "../lib/chatterboxClips";
import { encodeWavPcm16 } from "../lib/wavCodec";
import { ChatterboxVoiceControls } from "./ChatterboxVoiceControls";

/** A picked WAV file; jsdom's File has no arrayBuffer(), so it is given the browser's. */
function wavFile(seconds: number, name = "Narrator.wav"): File {
  const rate = 24_000;
  const samples = new Float32Array(Math.round(seconds * rate));
  for (let i = 0; i < samples.length; i += 1) {
    samples[i] = 0.3 * (0.6 + (0.4 * Math.sin(i / 4000))) * Math.sin(i / 12);
  }
  const buffer = encodeWavPcm16(samples, rate).slice().buffer;
  const file = new File([buffer], name, { type: "audio/wav" });
  Object.defineProperty(file, "arrayBuffer", { value: async () => buffer.slice(0), configurable: true });
  return file;
}

afterEach(() => {
  for (const clip of getChatterboxClips()) removeChatterboxClip(clip.id);
});

describe("ChatterboxVoiceControls", () => {
  it("offers the built-in voice, marked as selected, and explains cloning", () => {
    const onVoiceChange = vi.fn();
    render(<ChatterboxVoiceControls voice="chatterbox-default" onVoiceChange={onVoiceChange} />);

    expect(screen.getByRole("button", { name: /Default voice/ })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText(/No transcript is needed, and the clip stays on this device/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Default voice/ }));
    expect(onVoiceChange).toHaveBeenCalledWith("chatterbox-default");
  });

  it("clones a voice from a chosen WAV file and selects it", async () => {
    const onVoiceChange = vi.fn();
    render(<ChatterboxVoiceControls voice="chatterbox-default" onVoiceChange={onVoiceChange} />);

    fireEvent.change(screen.getByLabelText("Reference voice WAV file"), { target: { files: [wavFile(5)] } });

    await waitFor(() => expect(onVoiceChange).toHaveBeenCalledOnce());
    const [clip] = getChatterboxClips();
    expect(onVoiceChange).toHaveBeenCalledWith(clip.id);
    expect(await screen.findByRole("button", { name: /Narrator/ })).toHaveTextContent(/of speech/);
  });

  it("lists loaded clips, selects the chosen one and lets the user pick another", async () => {
    const clip = await addChatterboxClipFromWav(await wavFile(5).arrayBuffer(), "Narrator.wav");
    const onVoiceChange = vi.fn();
    render(<ChatterboxVoiceControls voice={clip.id} onVoiceChange={onVoiceChange} />);

    expect(screen.getByRole("button", { name: /Narrator/ })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: /Default voice/ })).toHaveAttribute("aria-pressed", "false");
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Default voice/ }));
    expect(onVoiceChange).toHaveBeenCalledWith("chatterbox-default");
    fireEvent.click(screen.getByRole("button", { name: /Narrator/ }));
    expect(onVoiceChange).toHaveBeenCalledWith(clip.id);
  });

  it("says when the selected clone's file is not loaded in this session", () => {
    render(<ChatterboxVoiceControls voice="0123~Old narrator" onVoiceChange={vi.fn()} />);

    expect(screen.getByRole("status")).toHaveTextContent("“Old narrator” is selected but its file is not loaded");
  });

  it("explains a file it cannot use and leaves the voice alone", async () => {
    const onVoiceChange = vi.fn();
    render(<ChatterboxVoiceControls voice="chatterbox-default" onVoiceChange={onVoiceChange} />);

    fireEvent.change(screen.getByLabelText("Reference voice WAV file"), { target: { files: [wavFile(1, "short.wav")] } });

    expect(await screen.findByRole("alert")).toHaveTextContent(/at least 3 seconds/);
    expect(onVoiceChange).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: /Clone a voice/ })).toBeEnabled();
  });

  it("opens the file chooser from its button and ignores an empty choice", () => {
    render(<ChatterboxVoiceControls voice="chatterbox-default" onVoiceChange={vi.fn()} />);
    const input = screen.getByLabelText("Reference voice WAV file");
    const click = vi.spyOn(input, "click").mockImplementation(() => undefined);

    fireEvent.click(screen.getByRole("button", { name: /Clone a voice/ }));
    fireEvent.change(input, { target: { files: [] } });

    expect(click).toHaveBeenCalledOnce();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("falls back to a generic message for a failure it cannot describe", async () => {
    render(<ChatterboxVoiceControls voice="chatterbox-default" onVoiceChange={vi.fn()} />);
    const file = wavFile(5);
    Object.defineProperty(file, "arrayBuffer", { value: () => Promise.reject("boom") });

    fireEvent.change(screen.getByLabelText("Reference voice WAV file"), { target: { files: [file] } });

    expect(await screen.findByRole("alert")).toHaveTextContent("That file could not be read.");
  });
});
