import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getQwen3Profiles } from "../../electron/qwen3Profiles";
import { libraryCatalogVoice, type CatalogVoice } from "../lib/voiceLibrary/catalog";
import { getStagedReference, resetStagedReferences } from "../lib/voiceLibrary/stagedReference";
import type { ClonedVoiceRecord, DesignedVoiceRecord, PresetVoiceRecord } from "../lib/voiceLibrary/types";
import { encodeWavPcm16 } from "../lib/wavCodec";
import { useVoiceApplier, type VoiceApplierDeps } from "./useVoiceApplier";

const profiles = getQwen3Profiles("darwin", "arm64");
const customVoice = profiles.find((profile) => profile.mode === "customVoice" && profile.parameters === "1.7B")!;
const base = profiles.find((profile) => profile.mode === "voiceClone")!;
const design = profiles.find((profile) => profile.mode === "voiceDesign")!;
const wav = encodeWavPcm16(new Float32Array(24000).fill(0.1), 24000);
const audio = { sampleRate: 24000, durationSec: 1, byteLength: wav.byteLength, sha256: "c".repeat(64) };
const common = { schemaVersion: 1 as const, description: "", tags: [], favorite: false, createdAt: 1, updatedAt: 1 };

const kokoroPreset: PresetVoiceRecord = { ...common, id: "k", name: "Heart fast", kind: "preset", preset: { engineId: "kokoro", voiceId: "af_heart", settings: { speed: 1.3 } } };
const audio8Preset: PresetVoiceRecord = { ...common, id: "a", name: "Arthur", kind: "preset", preset: { engineId: "audio8", voiceId: "arthur", settings: {} } };
const qwenPreset: PresetVoiceRecord = { ...common, id: "q", name: "Ryan calm", kind: "preset", preset: { engineId: "qwen3", voiceId: "Ryan", settings: { instruction: "Calm.", seed: 4, language: "English" } } };
const clone: ClonedVoiceRecord = { ...common, id: "c", name: "Me", kind: "cloned", transcript: "I said this.", language: "English", targets: ["qwen3-base", "neutts", "chatterbox"], source: "recording", reference: audio };
const designed: DesignedVoiceRecord = { ...common, id: "d", name: "Gravel", kind: "designed", design: { description: "Gravel", seed: 9, language: "English", previewText: "Hi." }, sample: audio };

function entry(record: PresetVoiceRecord | ClonedVoiceRecord | DesignedVoiceRecord, target?: "neutts" | "chatterbox"): CatalogVoice {
  const voice = libraryCatalogVoice(record);
  return target ? { ...voice, engineId: target, preset: { ...voice.preset, engineId: target } } : voice;
}

function setup(overrides: Partial<VoiceApplierDeps> = {}, qwen: Partial<VoiceApplierDeps["qwen3"]> = {}) {
  const qwen3 = {
    available: true,
    profiles,
    profile: customVoice,
    instruct: "",
    referenceAudioBase64: null,
    setup: { profiles: [customVoice, base, design].map((profile) => ({ repo: profile.repo, readiness: "verified" })) },
    setProfileRepo: vi.fn(),
    setSpeaker: vi.fn(),
    setLanguage: vi.fn(),
    setInstruct: vi.fn(),
    setSeed: vi.fn(),
    setReferenceAudio: vi.fn(),
    setReferenceText: vi.fn(),
    ...qwen,
  } as VoiceApplierDeps["qwen3"];
  const deps: VoiceApplierDeps = {
    selectBrowserModel: vi.fn(),
    selectDesktopModel: vi.fn(),
    desktopEngineAvailability: { audio8: true, supertonic3: true, qwen3: true },
    patchVoice: vi.fn(),
    setSpeed: vi.fn(),
    navigate: vi.fn(),
    qwen3,
    library: { getVoiceAudio: vi.fn(async () => wav) },
    neuttsEnabled: true,
    ...overrides,
  };
  const hook = renderHook((props: VoiceApplierDeps) => useVoiceApplier(props), { initialProps: deps });
  return { deps, qwen3, hook };
}

afterEach(resetStagedReferences);

describe("useVoiceApplier", () => {
  it("applies a browser engine voice and speed, then opens the surface", async () => {
    const { deps, hook } = setup();
    let result;
    await act(async () => { result = await hook.result.current(entry(kokoroPreset), "reader"); });
    expect(result).toEqual({ ok: true, message: "Using Heart fast in the Reader." });
    expect(deps.setSpeed).toHaveBeenCalledWith(1.3);
    expect(deps.selectBrowserModel).toHaveBeenCalledWith("reader", "kokoro");
    expect(deps.patchVoice).toHaveBeenCalledWith("kokoro", { voice: "af_heart" });
    expect(deps.navigate).toHaveBeenCalledWith("reader");
  });

  it("applies a desktop engine voice only where the engine exists", async () => {
    const { deps, hook } = setup();
    await act(async () => { await hook.result.current(entry(audio8Preset), "studio"); });
    expect(deps.selectDesktopModel).toHaveBeenCalledWith("studio", "audio8");
    expect(deps.patchVoice).toHaveBeenCalledWith("audio8", { voice: "arthur" });

    const missing = setup({ desktopEngineAvailability: { audio8: false, supertonic3: true, qwen3: true } });
    let result;
    await act(async () => { result = await missing.hook.result.current(entry(audio8Preset), "studio"); });
    expect(result).toMatchObject({ ok: false });
    expect(missing.deps.navigate).not.toHaveBeenCalled();
  });

  it("sets a Qwen3 speaker, instruction, seed and language on the profile it already uses", async () => {
    const { deps, qwen3, hook } = setup();
    await act(async () => { await hook.result.current(entry(qwenPreset), "studio"); });
    expect(deps.selectDesktopModel).toHaveBeenCalledWith("studio", "qwen3");
    expect(qwen3.setSpeaker).toHaveBeenCalledWith("Ryan");
    expect(qwen3.setLanguage).toHaveBeenCalledWith("English");
    expect(qwen3.setSeed).toHaveBeenCalledWith(4);
    expect(qwen3.setInstruct).toHaveBeenCalledWith("Calm.");
    expect(qwen3.setProfileRepo).not.toHaveBeenCalled();
    expect(deps.navigate).toHaveBeenCalledWith("studio");
  });

  it("switches to the Base profile first, then loads the reference once the switch lands", async () => {
    const { deps, qwen3, hook } = setup();
    await act(async () => { await hook.result.current(entry(clone), "studio"); });
    expect(qwen3.setProfileRepo).toHaveBeenCalledWith(base.repo);
    expect(qwen3.setReferenceAudio).not.toHaveBeenCalled();

    const landed = { ...deps, qwen3: { ...qwen3, profile: base } };
    hook.rerender(landed);
    expect(qwen3.setReferenceAudio).toHaveBeenCalledWith("Me", expect.any(String), "c".repeat(64), 1);
    expect(qwen3.setReferenceText).toHaveBeenCalledWith("I said this.");
    expect(qwen3.setInstruct).toHaveBeenCalledWith("");

    vi.mocked(qwen3.setReferenceAudio).mockClear();
    hook.rerender({ ...landed });
    expect(qwen3.setReferenceAudio).not.toHaveBeenCalled();
  });

  it("uses a designed voice's sample text when it is applied through VoiceDesign", async () => {
    const { qwen3, hook } = setup({}, { profile: design });
    await act(async () => { await hook.result.current(entry(designed), "studio"); });
    expect(qwen3.setInstruct).toHaveBeenCalledWith("Gravel");
    expect(qwen3.setSeed).toHaveBeenCalledWith(9);
    expect(qwen3.setProfileRepo).not.toHaveBeenCalled();
  });

  it("explains a missing Qwen3 model or reference instead of half-applying", async () => {
    const none = setup({}, { setup: { profiles: [] } });
    let result;
    await act(async () => { result = await none.hook.result.current(entry(clone), "studio"); });
    expect(result).toMatchObject({ ok: false, message: expect.stringContaining("Install a Qwen3 Base model") });
    expect(none.qwen3.setProfileRepo).not.toHaveBeenCalled();

    const unavailable = setup({}, { available: false });
    await act(async () => { result = await unavailable.hook.result.current(entry(qwenPreset), "studio"); });
    expect(result).toMatchObject({ ok: false });

    const noAudio = setup({ library: { getVoiceAudio: vi.fn(async () => null) } });
    await act(async () => { result = await noAudio.hook.result.current(entry(clone), "studio"); });
    expect(result).toMatchObject({ ok: false, message: expect.stringContaining("missing") });
    expect(noAudio.deps.selectDesktopModel).not.toHaveBeenCalled();
  });

  it("stages a NeuTTS reference and opens its page when NeuTTS is enabled", async () => {
    const { deps, hook } = setup();
    let result;
    await act(async () => { result = await hook.result.current(entry(clone, "neutts"), "studio"); });
    expect(result).toMatchObject({ ok: true });
    expect(getStagedReference("neutts")).toMatchObject({ voiceId: "c", transcript: "I said this.", target: "neutts", sha256: "c".repeat(64) });
    expect(deps.navigate).toHaveBeenCalledWith("neutts");

    const disabled = setup({ neuttsEnabled: false });
    await act(async () => { result = await disabled.hook.result.current(entry(clone, "neutts"), "studio"); });
    expect(result).toMatchObject({ ok: false, message: expect.stringContaining("Settings") });
    expect(disabled.deps.navigate).not.toHaveBeenCalled();
  });

  it("stages a Chatterbox reference and says the engine is not available yet", async () => {
    const { deps, hook } = setup();
    let result;
    await act(async () => { result = await hook.result.current(entry(clone, "chatterbox"), "studio"); });
    expect(result).toMatchObject({ ok: false, message: expect.stringContaining("Chatterbox") });
    expect(getStagedReference("chatterbox")).toMatchObject({ voiceId: "c" });
    expect(deps.navigate).not.toHaveBeenCalled();
  });
});
