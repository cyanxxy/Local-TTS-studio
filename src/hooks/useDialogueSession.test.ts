import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PresetSynthesize } from "../lib/presetSynthesis";
import type { VoicePreset } from "../lib/voiceLibrary/types";
import type { AudioExportOptions } from "../types";
import { useDialogueSession } from "./useDialogueSession";

const downloadAudioChunks = vi.hoisted(() => vi.fn(async () => undefined));
const downloadBlob = vi.hoisted(() => vi.fn());
vi.mock("../lib/audioExportClient", () => ({ downloadAudioChunks }));
vi.mock("../lib/exportAudio", () => ({ downloadBlob }));

const POOL: VoicePreset[] = [
  { engineId: "kokoro", voiceId: "af_heart", settings: {} },
  { engineId: "supertonic3", voiceId: "F1", settings: {} },
];
const EXPORT_OPTIONS = { format: "wav-pcm16", sampleRate: "source", bitrateKbps: 192, mastering: { enabled: false } } as unknown as AudioExportOptions;
const SCRIPT = "Anna: Hello there.\nBen: Hi Anna.";

function tone(sampleRate: number, seconds: number): AsyncIterable<{ audio: Float32Array; samplingRate: number }> {
  return (async function* () {
    yield { audio: new Float32Array(Math.round(sampleRate * seconds)).fill(0.2), samplingRate: sampleRate };
  })();
}

function setup(synthesize: PresetSynthesize, initialSource = SCRIPT, storageKey: string | null = null) {
  return renderHook(() => useDialogueSession({ synthesize, exportOptions: EXPORT_OPTIONS, voicePool: POOL, initialSource, storageKey }));
}

describe("useDialogueSession", () => {
  beforeEach(() => {
    downloadAudioChunks.mockClear();
    downloadBlob.mockClear();
  });

  it("detects speakers, casts them from the pool and plans the turns", () => {
    const { result } = setup(() => tone(10, 1));
    expect(result.current.speakers.map((speaker) => speaker.name)).toEqual(["Anna", "Ben"]);
    expect(result.current.casting.anna.voiceId).toBe("af_heart");
    expect(result.current.casting.ben.voiceId).toBe("F1");
    expect(result.current.uncastSpeakers).toEqual([]);
    expect(result.current.plan?.steps).toHaveLength(2);
  });

  it("reports parser issues inline and keeps manual casting over auto-cast", () => {
    const { result } = setup(() => tone(10, 1), "Anna: \nBen: Hi.");
    expect(result.current.issues.length).toBeGreaterThan(0);
    expect(result.current.issues[0]).toEqual(expect.objectContaining({ line: expect.any(Number), message: expect.any(String) }));

    act(() => result.current.castSpeaker("ben", { engineId: "audio8", voiceId: "narrator", settings: {} }));
    expect(result.current.casting.ben).toMatchObject({ engineId: "audio8", voiceId: "narrator" });
    act(() => result.current.autoCast());
    expect(result.current.casting.ben.engineId).not.toBe("audio8");
  });

  it("renders turn by turn at mixed sample rates, with progress and captions", async () => {
    const seen: Array<{ text: string; engineId: string }> = [];
    const synthesize: PresetSynthesize = (text, preset) => {
      seen.push({ text, engineId: preset.engineId });
      return tone(preset.engineId === "kokoro" ? 10 : 20, 1);
    };
    const { result } = setup(synthesize);

    await act(async () => {
      await result.current.render();
    });

    expect(seen).toEqual([
      { text: "Hello there.", engineId: "kokoro" },
      { text: "Hi Anna.", engineId: "supertonic3" },
    ]);
    expect(result.current.status).toBe("done");
    expect(result.current.turns.size).toBe(2);
    expect(result.current.stitched?.sampleRate).toBe(20);
    expect(result.current.stitched?.cues.map((cue) => cue.speaker)).toEqual(["Anna", "Ben"]);

    act(() => result.current.downloadCaptions("vtt"));
    const [blob, name] = downloadBlob.mock.calls[0] as unknown as [Blob, string];
    expect(name).toBe("open-tts-dialogue.vtt");
    expect(await blob.text()).toContain("<v Anna>Hello there.");
    act(() => result.current.downloadCaptions("srt"));
    expect(await (downloadBlob.mock.calls[1][0] as Blob).text()).toContain("Ben: Hi Anna.");

    await act(async () => {
      await result.current.exportAudio();
    });
    expect(downloadAudioChunks).toHaveBeenCalledWith(
      [expect.objectContaining({ samplingRate: 20 })],
      EXPORT_OPTIONS,
      { fileName: "open-tts-dialogue" },
    );
  });

  it("cancels mid-render and keeps the turns that finished", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const synthesize: PresetSynthesize = (text, _preset, signal) => {
      if (text === "Hello there.") return tone(10, 1);
      return (async function* () {
        await gate;
        signal.throwIfAborted();
        yield { audio: new Float32Array(10), samplingRate: 10 };
      })();
    };
    const { result } = setup(synthesize);

    let rendering: Promise<void> = Promise.resolve();
    act(() => { rendering = result.current.render(); });
    await waitFor(() => expect(result.current.turns.size).toBe(1));
    expect(result.current.status).toBe("rendering");
    expect(result.current.progress).toEqual({ position: 2, total: 2 });

    act(() => result.current.cancel());
    release();
    await act(async () => { await rendering; });

    expect(result.current.status).toBe("cancelled");
    expect(result.current.turns.size).toBe(1);
    expect(result.current.error).toBeNull();
    expect(result.current.stitched).not.toBeNull();
  });

  it("surfaces an engine failure and can regenerate a single turn", async () => {
    let failSecond = true;
    const synthesize: PresetSynthesize = (text) => {
      if (text === "Hi Anna." && failSecond) {
        return { [Symbol.asyncIterator]: () => ({ next: () => Promise.reject(new Error("Engine crashed.")) }) };
      }
      return tone(10, text === "Hi Anna." ? 2 : 1);
    };
    const { result } = setup(synthesize);
    await act(async () => { await result.current.render(); });
    expect(result.current.status).toBe("error");
    expect(result.current.error).toBe("Engine crashed.");
    expect(result.current.turns.size).toBe(1);

    failSecond = false;
    await act(async () => { await result.current.regenerateTurn(1); });
    expect(result.current.error).toBeNull();
    expect(result.current.turns.size).toBe(2);
    expect(result.current.stitched?.durationSec).toBeCloseTo(1 + 0.4 + 2, 5);
  });

  it("regenerates one turn without touching the others and flags edited lines", async () => {
    const synthesize = vi.fn<PresetSynthesize>((text) => tone(10, text.length > 10 ? 2 : 1));
    const { result } = setup(synthesize);
    await act(async () => { await result.current.render(); });
    const firstBefore = result.current.turns.get(0);
    synthesize.mockClear();

    await act(async () => { await result.current.regenerateTurn(1); });
    expect(synthesize).toHaveBeenCalledTimes(1);
    expect(result.current.turns.get(0)).toBe(firstBefore);

    act(() => result.current.setSource("Anna: Hello there.\nBen: Hi Anna, again."));
    expect([...result.current.outdatedTurns]).toEqual([1]);
    await act(async () => { await result.current.regenerateTurn(1); });
    expect(result.current.outdatedTurns.size).toBe(0);

    await act(async () => { await result.current.regenerateTurn(9); });
    expect(result.current.error).toMatch(/no longer in the script/);
  });

  it("keeps the script and manual casting across remounts", () => {
    window.localStorage.clear();
    const first = setup(() => tone(10, 1), "", "test:dialogue");
    act(() => first.result.current.setSource(SCRIPT));
    act(() => first.result.current.castSpeaker("ben", { engineId: "audio8", voiceId: "narrator", settings: {} }));
    first.unmount();

    const second = setup(() => tone(10, 1), "", "test:dialogue");
    expect(second.result.current.source).toBe(SCRIPT);
    expect(second.result.current.casting.ben.engineId).toBe("audio8");
    act(() => second.result.current.autoCast());
    second.unmount();
    expect(setup(() => tone(10, 1), "", "test:dialogue").result.current.casting.ben.engineId).toBe("supertonic3");
    window.localStorage.setItem("test:dialogue", "{not json");
    expect(setup(() => tone(10, 1), "fresh", "test:dialogue").result.current.source).toBe("fresh");
    window.localStorage.clear();
  });

  it("drops malformed stored voice choices and casts those speakers from the pool", () => {
    window.localStorage.clear();
    window.localStorage.setItem("test:dialogue", JSON.stringify({
      source: SCRIPT,
      overrides: {
        anna: null,
        ben: { engineId: "audio8", voiceId: "narrator", settings: {} },
        cara: { engineId: "kokoro", voiceId: 7, settings: {} },
        dan: { engineId: "kokoro", voiceId: "af_heart" },
      },
    }));
    const { result } = setup(() => tone(10, 1), "", "test:dialogue");
    expect(result.current.casting.anna.voiceId).toBe("af_heart");
    expect(result.current.casting.ben.engineId).toBe("audio8");
    expect(result.current.plan?.steps).toHaveLength(2);

    window.localStorage.setItem("test:dialogue", JSON.stringify({ source: SCRIPT, overrides: ["not", "a", "map"] }));
    expect(setup(() => tone(10, 1), "", "test:dialogue").result.current.casting.anna.voiceId).toBe("af_heart");
    window.localStorage.clear();
  });

  it("reports out-of-range pauses and stitches only once the render has finished", async () => {
    const { result } = setup(() => tone(10, 1));
    act(() => result.current.setGaps({ speakerChangeGapSec: 9 }));
    expect(result.current.gapProblem).toMatch(/between speakers must be between 0 and 5/);
    expect(result.current.plan).toBeNull();
    act(() => result.current.setGaps({ speakerChangeGapSec: 0.3, sameSpeakerGapSec: -1 }));
    expect(result.current.gapProblem).toMatch(/within a speaker/);
    act(() => result.current.setGaps({ sameSpeakerGapSec: 0.2 }));
    expect(result.current.gapProblem).toBeNull();

    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const slow = setup((text) => (text === "Hi Anna." ? (async function* () {
      await gate;
      yield { audio: new Float32Array(10), samplingRate: 10 };
    })() : tone(10, 1)));
    let rendering: Promise<void> = Promise.resolve();
    act(() => { rendering = slow.result.current.render(); });
    await waitFor(() => expect(slow.result.current.turns.size).toBe(1));
    expect(slow.result.current.stitched).toBeNull();
    release();
    await act(async () => { await rendering; });
    expect(slow.result.current.stitched?.cues).toHaveLength(2);
  });

  it("will not render without a complete plan", async () => {
    const synthesize = vi.fn<PresetSynthesize>(() => tone(10, 1));
    const { result } = setup(synthesize, "");
    await act(async () => { await result.current.render(); });
    expect(synthesize).not.toHaveBeenCalled();
    expect(result.current.error).toMatch(/at least one line/);
  });
});
