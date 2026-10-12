import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PIPER_CACHE_NAME, PIPER_VOICES } from "../lib/piperVoices";
import type { ModelState } from "../types";
import { PiperVoiceBrowser } from "./PiperVoiceBrowser";

const READY: ModelState = { ready: true, loading: false, downloadProgress: 100, error: null, backend: "wasm" };
const DOWNLOADING: ModelState = { ready: true, loading: true, downloadProgress: 37, error: null, backend: "wasm" };

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubCache(urls: string[]) {
  vi.stubGlobal("caches", {
    has: vi.fn(async (name: string) => name === PIPER_CACHE_NAME),
    open: vi.fn(async () => ({ keys: vi.fn(async () => urls.map((url) => new Request(url))) })),
  });
}

describe("PiperVoiceBrowser", () => {
  it("describes the selected voice with its quality, first-use download size, licence and attribution", () => {
    render(<PiperVoiceBrowser voice="en_US-kristin-medium" onVoiceChange={vi.fn()} modelState={READY} />);

    expect(screen.getByText("Kristin")).toBeInTheDocument();
    expect(screen.getByText(/American · Medium quality/)).toBeInTheDocument();
    expect(screen.getByText(/MB download the first time it speaks/)).toBeInTheDocument();
    expect(screen.getByText(/Licence:/).parentElement).toHaveTextContent("public-domain");
    expect(screen.getByText(/Piper voice \(rhasspy\/piper-voices, MIT\) trained on the dataset at https:\/\/librivox\.org/)).toBeInTheDocument();
  });

  it("shows the CC BY 4.0 licence link and attribution for the LibriTTS voice", () => {
    render(<PiperVoiceBrowser voice="en_US-libritts-high#4" onVoiceChange={vi.fn()} modelState={READY} />);

    const licence = screen.getByRole("link", { name: /CC-BY-4\.0/ });
    expect(licence).toHaveAttribute("href", "https://creativecommons.org/licenses/by/4.0/");
    expect(screen.getByText(/LibriTTS: Piper voice .* licensed CC BY 4\.0/)).toBeInTheDocument();
  });

  it("groups the catalog by accent, lists quality, size and licence, and picks a voice", () => {
    const onVoiceChange = vi.fn();
    render(<PiperVoiceBrowser voice="en_US-kristin-medium" onVoiceChange={onVoiceChange} modelState={READY} />);
    expect(screen.queryByRole("region", { name: "British English" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: `Browse ${PIPER_VOICES.length} voices` }));

    const british = screen.getByRole("region", { name: "British English" });
    expect(screen.getByRole("region", { name: "American English" })).toBeInTheDocument();
    const cori = within(british).getAllByRole("button");
    // Best quality first within an accent.
    expect(cori.map((button) => button.textContent)).toEqual([
      expect.stringContaining("CoriHigh"),
      expect.stringContaining("CoriMedium"),
    ]);
    expect(cori[0]).toHaveTextContent(/MB/);
    expect(cori[0]).toHaveTextContent("public-domain");

    fireEvent.click(cori[0]);
    expect(onVoiceChange).toHaveBeenCalledWith("en_GB-cori-high");
  });

  it("filters the list by quality", () => {
    render(<PiperVoiceBrowser voice="en_US-kristin-medium" onVoiceChange={vi.fn()} modelState={READY} />);
    fireEvent.click(screen.getByRole("button", { name: /Browse/ }));
    const filter = screen.getByRole("group", { name: "Filter by quality" });

    fireEvent.click(within(filter).getByRole("button", { name: "High" }));

    const highCount = PIPER_VOICES.filter((voice) => voice.quality === "high").length;
    const list = screen.getAllByRole("region");
    expect(list.flatMap((region) => within(region).getAllByRole("button"))).toHaveLength(highCount);
    expect(within(filter).getByRole("button", { name: "High" })).toHaveAttribute("aria-pressed", "true");

    fireEvent.click(within(filter).getByRole("button", { name: "All" }));
    expect(screen.getAllByRole("region").flatMap((region) => within(region).getAllByRole("button")))
      .toHaveLength(PIPER_VOICES.length);
  });

  it("chooses a speaker for the multi-speaker voice and keeps it when browsing back", () => {
    const onVoiceChange = vi.fn();
    render(<PiperVoiceBrowser voice="en_US-libritts-high#4" onVoiceChange={onVoiceChange} modelState={READY} />);

    const speaker = screen.getByLabelText(/Speaker \(1 to 904\)/);
    expect(speaker).toHaveValue(5);
    fireEvent.change(speaker, { target: { value: "13" } });
    expect(onVoiceChange).toHaveBeenLastCalledWith("en_US-libritts-high#12");
    fireEvent.change(speaker, { target: { value: "9999" } });
    expect(onVoiceChange).toHaveBeenLastCalledWith("en_US-libritts-high#903");

    vi.spyOn(Math, "random").mockReturnValue(0.5);
    fireEvent.click(screen.getByRole("button", { name: "Pick a random speaker" }));
    expect(onVoiceChange).toHaveBeenLastCalledWith("en_US-libritts-high#452");
    vi.restoreAllMocks();

    // Selecting another voice drops the speaker; selecting LibriTTS again keeps this one.
    fireEvent.click(screen.getByRole("button", { name: /Browse/ }));
    fireEvent.click(screen.getByRole("button", { name: /LibriTTS/ }));
    expect(onVoiceChange).toHaveBeenLastCalledWith("en_US-libritts-high#4");
  });

  it("offers no speaker control for a single-speaker voice", () => {
    render(<PiperVoiceBrowser voice="en_GB-cori-high" onVoiceChange={vi.fn()} modelState={READY} />);

    expect(screen.queryByLabelText(/Speaker/)).not.toBeInTheDocument();
  });

  it("reports a voice download in progress", () => {
    render(<PiperVoiceBrowser voice="en_US-john-medium" onVoiceChange={vi.fn()} modelState={DOWNLOADING} />);

    expect(screen.getByRole("status")).toHaveTextContent("Downloading voice");
    expect(screen.getByRole("status")).toHaveTextContent("37%");
    expect(screen.queryByText(/download the first time/)).not.toBeInTheDocument();
  });

  it("marks voices already in the Piper cache as on this device", async () => {
    const kristin = PIPER_VOICES.find((voice) => voice.id === "en_US-kristin-medium")!;
    stubCache([`https://huggingface.co/rhasspy/piper-voices/resolve/rev/${kristin.model}`]);
    render(<PiperVoiceBrowser voice="en_US-kristin-medium" onVoiceChange={vi.fn()} modelState={READY} />);

    expect(await screen.findByText("On this device")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Browse/ }));
    expect(screen.getByRole("button", { name: /Kristin/ })).toHaveTextContent("downloaded");
    expect(screen.getByRole("button", { name: /John/ })).not.toHaveTextContent("downloaded");
  });

  it("still describes the download when the cache cannot be read", async () => {
    vi.stubGlobal("caches", { has: vi.fn(async () => { throw new Error("blocked"); }) });
    render(<PiperVoiceBrowser voice="en_US-kristin-medium" onVoiceChange={vi.fn()} modelState={READY} />);

    await waitFor(() => expect(screen.getByText(/MB download the first time it speaks/)).toBeInTheDocument());
  });
});
