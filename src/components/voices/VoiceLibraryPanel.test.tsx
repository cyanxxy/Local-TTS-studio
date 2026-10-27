import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useVoiceLibrary } from "../../hooks/useVoiceLibrary";
import type { AuditionAudio } from "../../hooks/useAudition";
import type { PresetSynthesize } from "../../lib/presetSynthesis";
import { createVoiceLibraryStore, type VoiceLibraryStore } from "../../lib/voiceLibrary/store";
import { encodeWavPcm16 } from "../../lib/wavCodec";
import { VoiceLibraryPanel } from "./VoiceLibraryPanel";

class FakeAudio implements AuditionAudio {
  onended: ((event: Event) => void) | null = null;
  onerror: ((event: Event | string) => void) | null = null;
  play = vi.fn(async () => undefined);
  pause = vi.fn();
}

const RUNTIME_VOICES = { kokoro: ["af_heart", "bm_george"] };

describe("VoiceLibraryPanel", () => {
  let store: VoiceLibraryStore;
  let synthesize: ReturnType<typeof vi.fn<PresetSynthesize>>;
  let apply: ReturnType<typeof vi.fn<(voice: unknown, surface: "studio" | "reader") => Promise<{ ok: boolean; message: string }>>>;
  let saveFile: ReturnType<typeof vi.fn<(blob: Blob, fileName: string) => void>>;
  let audios: FakeAudio[];

  function Harness({ runtimeVoices = RUNTIME_VOICES }: { runtimeVoices?: Record<string, string[]> }) {
    const library = useVoiceLibrary(store);
    return (
      <VoiceLibraryPanel
        library={library}
        runtimeVoices={runtimeVoices}
        synthesize={synthesize}
        apply={apply as never}
        saveFile={saveFile}
        createAudio={() => { const audio = new FakeAudio(); audios.push(audio); return audio; }}
      />
    );
  }

  beforeEach(() => {
    vi.stubGlobal("indexedDB", new IDBFactory());
    vi.stubGlobal("IDBKeyRange", IDBKeyRange);
    vi.stubGlobal("URL", Object.assign(Object.create(URL), { createObjectURL: () => "blob:x", revokeObjectURL: () => undefined }));
    localStorage.clear();
    audios = [];
    store = createVoiceLibraryStore();
    synthesize = vi.fn<PresetSynthesize>(async function* () {
      yield { audio: new Float32Array(2400).fill(0.2), samplingRate: 24000 };
    });
    apply = vi.fn(async () => ({ ok: true, message: "Using it in Studio." }));
    saveFile = vi.fn();
  });
  afterEach(async () => {
    await store.destroy();
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  const voiceNames = () => within(screen.getByRole("list", { name: "Voices" })).getAllByRole("listitem")
    .map((item) => within(item).getAllByRole("paragraph")[0].textContent);

  it("lists built-in voices from every engine and filters them", async () => {
    render(<Harness />);
    await screen.findByText("George");
    expect(voiceNames()).toEqual(expect.arrayContaining(["Heart", "George", "Clara", "Arthur", "Aiden"]));

    fireEvent.change(screen.getByLabelText("Engine"), { target: { value: "audio8" } });
    expect(voiceNames().sort()).toEqual(["Arthur", "Ben", "Clara", "Iris", "Mia", "Sophie"]);

    fireEvent.change(screen.getByLabelText("Gender"), { target: { value: "male" } });
    expect(voiceNames().sort()).toEqual(["Arthur", "Ben"]);

    fireEvent.change(screen.getByLabelText("Gender"), { target: { value: "" } });
    fireEvent.change(screen.getByLabelText("Language"), { target: { value: "Chinese" } });
    expect(voiceNames().sort()).toEqual(["Ben", "Mia"]);

    fireEvent.change(screen.getByLabelText("Language"), { target: { value: "" } });
    fireEvent.change(screen.getByLabelText("Engine"), { target: { value: "" } });
    fireEvent.change(screen.getByLabelText("Search voices"), { target: { value: "arthur" } });
    expect(voiceNames()).toEqual(["Arthur"]);
    fireEvent.change(screen.getByLabelText("Search voices"), { target: { value: "zzzz" } });
    expect(await screen.findByText(/No voices match/)).toBeInTheDocument();
  });

  it("keeps favorites of built-in voices on this device and of saved voices in the library", async () => {
    await store.createVoice({ kind: "preset", name: "Mine", preset: { engineId: "kokoro", voiceId: "af_heart", settings: {} } });
    render(<Harness />);
    await screen.findByText("Mine");
    expect(voiceNames()[0]).toBe("Mine");

    fireEvent.click(screen.getByRole("button", { name: "Favorite Arthur" }));
    expect(screen.getByRole("button", { name: "Favorite Arthur" })).toHaveAttribute("aria-pressed", "true");
    expect(localStorage.getItem("open-tts.voice-favorites.v1")).toContain("engine:audio8:arthur");
    expect(voiceNames()[0]).toBe("Arthur");

    fireEvent.click(screen.getByRole("button", { name: "Favorite Mine" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Favorite Mine" })).toHaveAttribute("aria-pressed", "true"));
    expect((await store.listVoices())[0].favorite).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Favorites" }));
    expect(voiceNames().sort()).toEqual(["Arthur", "Mine"]);
  });

  it("previews a voice once and replays it from the cache", async () => {
    render(<Harness />);
    await screen.findByText("Arthur");
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Preview Arthur" })); });
    await waitFor(() => expect(audios).toHaveLength(1));
    expect(synthesize).toHaveBeenCalledTimes(1);
    expect(synthesize.mock.calls[0][1]).toMatchObject({ engineId: "audio8", voiceId: "arthur" });
    expect((await store.getUsage()).previewCount).toBe(1);

    await screen.findByRole("button", { name: "Stop preview of Arthur" });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Stop preview of Arthur" })); });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Preview Arthur" })); });
    await waitFor(() => expect(audios).toHaveLength(2));
    expect(synthesize).toHaveBeenCalledTimes(1);
  });

  it("shows why a preview failed, and disables preview for engines without a runtime here", async () => {
    synthesize.mockImplementation(async function* () {
      throw new Error("Install a Qwen3 CustomVoice model in Qwen3 model setup to render this voice.");
      yield { audio: new Float32Array(1), samplingRate: 24000 };
    });
    await store.createVoice({
      kind: "cloned", name: "Neu clone", transcript: "Hi.", targets: ["neutts"], referenceWav: encodeWavPcm16(new Float32Array(48_000).fill(0.1), 24_000),
    });
    render(<Harness />);
    await screen.findByText("Neu clone");
    expect(screen.getByRole("button", { name: "Preview Neu clone" })).toBeDisabled();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Preview Aiden" })); });
    expect(await screen.findByRole("alert")).toHaveTextContent(/Install a Qwen3 CustomVoice model/);
  });

  it("uses a voice in Studio or the Reader and reports the outcome", async () => {
    render(<Harness />);
    await screen.findByText("Arthur");
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Use Arthur in Studio" })); });
    expect(apply).toHaveBeenCalledWith(expect.objectContaining({ voiceId: "arthur", engineId: "audio8" }), "studio");
    expect(await screen.findByText("Using it in Studio.")).toBeInTheDocument();

    apply.mockResolvedValueOnce({ ok: false, message: "Audio8 isn't available in this build." });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Use Clara in Reader" })); });
    expect(apply).toHaveBeenLastCalledWith(expect.objectContaining({ voiceId: "clara" }), "reader");
    expect(await screen.findByText("Audio8 isn't available in this build.")).toBeInTheDocument();
  });

  it("saves a voice with settings as a preset", async () => {
    render(<Harness />);
    await screen.findByText("George");
    fireEvent.click(screen.getByRole("button", { name: "Save George as a preset" }));
    const form = screen.getByRole("form", { name: "Save preset for George" });
    fireEvent.change(within(form).getByLabelText("Preset name"), { target: { value: "George, brisk" } });
    fireEvent.change(within(form).getByLabelText("Speed"), { target: { value: "1.25" } });
    expect(within(form).queryByLabelText("Seed")).toBeNull();
    fireEvent.click(within(form).getByRole("button", { name: "Save preset" }));
    // Saving writes through fake-indexeddb, which can take over a second on a
    // loaded coverage run; the default 1 s wait failed in CI.
    await screen.findByText(/Saved preset “George, brisk”/, undefined, { timeout: 3_000 });
    const [saved] = await store.listVoices();
    expect(saved).toMatchObject({ kind: "preset", name: "George, brisk", preset: { engineId: "kokoro", voiceId: "bm_george", settings: { speed: 1.25 } } });
    expect(screen.queryByRole("form", { name: "Save preset for George" })).toBeNull();
  });

  it("offers seed and instruction for engines that honour them", async () => {
    render(<Harness />);
    await screen.findByText("Aiden");
    fireEvent.click(screen.getByRole("button", { name: "Save Aiden as a preset" }));
    const form = screen.getByRole("form", { name: "Save preset for Aiden" });
    fireEvent.change(within(form).getByLabelText("Seed"), { target: { value: "42" } });
    fireEvent.change(within(form).getByLabelText("Style instruction"), { target: { value: " Calm. " } });
    fireEvent.click(within(form).getByRole("button", { name: "Save preset" }));
    await screen.findByText(/Saved preset “Aiden”/, undefined, { timeout: 3_000 });
    expect((await store.listVoices())[0]).toMatchObject({ preset: { engineId: "qwen3", voiceId: "Aiden", settings: { seed: 42, instruction: "Calm." } } });
  });

  it("exports a saved voice as a portable file and imports it back", async () => {
    const saved = await store.createVoice({ kind: "preset", name: "Portable", preset: { engineId: "kokoro", voiceId: "af_heart", settings: { speed: 1.1 } } });
    render(<Harness />);
    await screen.findByText("Portable");
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Export Portable" })); });
    await waitFor(() => expect(saveFile).toHaveBeenCalledTimes(1));
    const [blob, fileName] = saveFile.mock.calls[0];
    expect(fileName).toMatch(/\.voice\.zip$/);
    expect(blob.type).toBe("application/zip");

    await store.deleteVoice(saved.id);
    await waitFor(() => expect(screen.queryByText("Portable")).toBeNull());
    const file = new File([await blob.arrayBuffer()], fileName, { type: "application/zip" });
    await act(async () => { fireEvent.change(screen.getByLabelText("Import voice file"), { target: { files: [file] } }); });
    expect(await screen.findByText("Imported Portable.")).toBeInTheDocument();
    expect(await screen.findByText("Portable", { selector: "p" })).toBeInTheDocument();
  });

  it("refuses an oversized import without reading it", async () => {
    render(<Harness />);
    await screen.findByText("Arthur");
    const huge = new File(["x"], "huge.voice.zip");
    Object.defineProperty(huge, "size", { value: 500_000_000 });
    const read = vi.spyOn(huge, "arrayBuffer");
    await act(async () => { fireEvent.change(screen.getByLabelText("Import voice file"), { target: { files: [huge] } }); });
    expect(await screen.findByText(/larger than \d+ MB/)).toBeInTheDocument();
    expect(read).not.toHaveBeenCalled();
  });

  it("explains a file that is not a voice package", async () => {
    render(<Harness />);
    await screen.findByText("Arthur");
    await act(async () => { fireEvent.change(screen.getByLabelText("Import voice file"), { target: { files: [new File(["nope"], "x.zip")] } }); });
    expect(await screen.findByText("The voice file is not a valid zip archive.")).toBeInTheDocument();
  });

  it("removes a saved voice only after confirming", async () => {
    await store.createVoice({ kind: "preset", name: "Temp", preset: { engineId: "kokoro", voiceId: "af_heart", settings: {} } });
    render(<Harness />);
    await screen.findByText("Temp");
    fireEvent.click(screen.getByRole("button", { name: "Remove Temp" }));
    expect(await store.listVoices()).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Keep" }));
    expect(screen.getByRole("button", { name: "Remove Temp" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Remove Temp" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete Temp" }));
    await waitFor(() => expect(screen.queryByText("Temp", { selector: "p" })).toBeNull());
    expect(await store.listVoices()).toEqual([]);
  });

  it("hints that Kokoro voices need its model loaded", async () => {
    render(<Harness runtimeVoices={{}} />);
    expect(await screen.findByText(/Kokoro voices appear after its model has loaded/)).toBeInTheDocument();
  });
});
