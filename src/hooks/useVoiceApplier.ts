import { useCallback, useEffect, useRef } from "react";
import type { Qwen3Profile } from "../../electron/qwen3Profiles";
import type { Qwen3RuntimeSettings } from "../contexts/Qwen3RuntimeContext";
import type { AppPage } from "../lib/appRouting";
import type { CatalogVoice } from "../lib/voiceLibrary/catalog";
import { isSurfaceEngine } from "../lib/voiceLibrary/presetRequest";
import { bytesToBase64, stageReference } from "../lib/voiceLibrary/stagedReference";
import type { VoiceLibraryStore } from "../lib/voiceLibrary/store";
import type { ClonedVoiceRecord } from "../lib/voiceLibrary/types";
import { decodeWav } from "../lib/wavCodec";
import type { BrowserEngineId, DesktopInlineEngineId, SurfaceEngineId } from "../models/registry";
import { QWEN3_ENGINE_SPEAKERS } from "../models/qwen3";

export type ApplySurface = "studio" | "reader";

export interface ApplyResult {
  ok: boolean;
  /** What happened, or why nothing did; shown next to the voice. */
  message: string;
}

type Qwen3Controls = Pick<
  Qwen3RuntimeSettings,
  "profile" | "instruct" | "referenceAudioBase64"
> & {
  available: boolean;
  profiles: readonly Qwen3Profile[];
  setup: { profiles: ReadonlyArray<{ repo: string; readiness: string }> } | null;
  setProfileRepo: (repo: string) => void;
  setSpeaker: (speaker: string) => void;
  setLanguage: (language: string) => void;
  setInstruct: (instruct: string) => void;
  setSeed: (seed: number | null) => void;
  setReferenceAudio: (name: string, base64: string | null, signature?: string, durationSec?: number | null) => void;
  setReferenceText: (text: string) => void;
};

export interface VoiceApplierDeps {
  selectBrowserModel: (surface: ApplySurface, model: BrowserEngineId) => void;
  selectDesktopModel: (surface: ApplySurface, engine: DesktopInlineEngineId) => void;
  desktopEngineAvailability: Readonly<Record<DesktopInlineEngineId, boolean>>;
  /** Merge a voice (and language) into a Studio-owned engine's settings. */
  patchVoice: (engine: Exclude<SurfaceEngineId, "qwen3">, patch: { voice?: string; language?: string }) => void;
  setSpeed: (speed: number) => void;
  navigate: (page: AppPage) => void;
  qwen3: Qwen3Controls;
  library: Pick<VoiceLibraryStore, "getVoiceAudio">;
  /** NeuTTS has a page only while the user has it switched on. */
  neuttsEnabled: boolean;
}

interface PendingQwen3 {
  repo: string;
  instruct: string;
  reference: { name: string; base64: string; signature: string; durationSec: number; transcript: string } | null;
}

const BROWSER_ENGINES: readonly string[] = ["kokoro", "supertonic"];
const DESKTOP_ENGINES: readonly string[] = ["audio8", "supertonic3"];
const SURFACE_NAME: Record<ApplySurface, string> = { studio: "Studio", reader: "the Reader" };

function qwen3ModeFor(voice: CatalogVoice): Qwen3Profile["mode"] {
  const { mode } = voice.preset;
  if (mode === "voiceClone") return "voiceClone";
  if (mode === "voiceDesign") return "voiceDesign";
  return "customVoice";
}

function pickInstalledProfile(qwen3: Qwen3Controls, mode: Qwen3Profile["mode"]): Qwen3Profile | null {
  const installed = (repo: string) => qwen3.setup?.profiles.some((entry) => entry.repo === repo && entry.readiness !== "missing");
  const candidates = qwen3.profiles.filter((profile) => profile.mode === mode && installed(profile.repo));
  return candidates.find((profile) => profile.repo === qwen3.profile.repo) ?? candidates[0] ?? null;
}

/**
 * Sends a Voice Library voice to Studio or the Reader in one step: picks the
 * engine, sets its voice and settings, loads a clone's reference clip into
 * the engine that needs it, and opens the surface.
 */
export function useVoiceApplier(deps: VoiceApplierDeps): (voice: CatalogVoice, surface: ApplySurface) => Promise<ApplyResult> {
  const depsRef = useRef(deps);
  const pendingRef = useRef<PendingQwen3 | null>(null);

  useEffect(() => {
    depsRef.current = deps;
    // Instruction and reference belong to the active Qwen3 profile, so they
    // are written only once a profile switch has taken effect.
    const pending = pendingRef.current;
    if (!pending || deps.qwen3.profile.repo !== pending.repo) return;
    pendingRef.current = null;
    deps.qwen3.setInstruct(pending.instruct);
    if (pending.reference) {
      const { name, base64, signature, durationSec, transcript } = pending.reference;
      deps.qwen3.setReferenceAudio(name, base64, signature, durationSec);
      deps.qwen3.setReferenceText(transcript);
    }
  });

  return useCallback(async (voice, surface) => {
    const current = depsRef.current;
    const { preset, record } = voice;
    const where = SURFACE_NAME[surface];
    if (preset.settings.speed !== undefined) current.setSpeed(preset.settings.speed);

    const cloneReference = async (target: "qwen3-base" | "neutts" | "chatterbox") => {
      if (record?.kind !== "cloned" && record?.kind !== "designed") return null;
      const role = record.kind === "cloned" ? "reference" : "sample";
      const wav = await current.library.getVoiceAudio(record.id, role);
      if (!wav) return null;
      const info = record.kind === "cloned" ? record.reference : record.sample;
      const transcript = record.kind === "cloned" ? record.transcript : record.design.previewText;
      let durationSec = info?.durationSec ?? 0;
      try {
        const decoded = decodeWav(wav);
        durationSec = decoded.channels[0].length / decoded.sampleRate;
      } catch {
        // The stored duration stands in for a header that cannot be read.
      }
      return {
        target,
        name: record.name,
        wav,
        base64: bytesToBase64(wav),
        signature: info?.sha256 ?? "",
        durationSec,
        transcript,
        language: record.kind === "cloned" ? record.language : record.design.language,
      };
    };

    if (BROWSER_ENGINES.includes(preset.engineId) && isSurfaceEngine(preset.engineId)) {
      current.selectBrowserModel(surface, preset.engineId as BrowserEngineId);
      current.patchVoice(preset.engineId as "kokoro" | "supertonic", {
        voice: preset.voiceId,
        ...(preset.settings.language ? { language: preset.settings.language } : {}),
      });
      current.navigate(surface);
      return { ok: true, message: `Using ${voice.name} in ${where}.` };
    }

    if (DESKTOP_ENGINES.includes(preset.engineId) && isSurfaceEngine(preset.engineId)) {
      const engine = preset.engineId as DesktopInlineEngineId;
      if (!current.desktopEngineAvailability[engine]) {
        return { ok: false, message: `${voice.engineLabel} isn't available in this build.` };
      }
      current.selectDesktopModel(surface, engine);
      current.patchVoice(engine as "audio8" | "supertonic3", {
        voice: preset.voiceId,
        ...(engine === "supertonic3" && preset.settings.language ? { language: preset.settings.language } : {}),
      });
      current.navigate(surface);
      return { ok: true, message: `Using ${voice.name} in ${where}.` };
    }

    if (preset.engineId === "qwen3") {
      const { qwen3 } = current;
      if (!qwen3.available) return { ok: false, message: "Qwen3 runs in the desktop app once its model is installed." };
      const mode = qwen3ModeFor(voice);
      const profile = pickInstalledProfile(qwen3, mode);
      if (!profile) {
        return { ok: false, message: `Install a Qwen3 ${mode === "voiceClone" ? "Base" : mode === "voiceDesign" ? "VoiceDesign" : "CustomVoice"} model in Qwen3 model setup first.` };
      }
      let reference: PendingQwen3["reference"] = null;
      if (mode === "voiceClone") {
        const loaded = await cloneReference("qwen3-base");
        if (!loaded) return { ok: false, message: "This voice's reference clip is missing from the library." };
        reference = { name: loaded.name, base64: loaded.base64, signature: loaded.signature, durationSec: loaded.durationSec, transcript: loaded.transcript };
      }
      // Re-read after the await: the controls may have moved on.
      const live = depsRef.current;
      live.selectDesktopModel(surface, "qwen3");
      if (mode === "customVoice" && QWEN3_ENGINE_SPEAKERS.some((speaker) => speaker.id === preset.voiceId)) {
        live.qwen3.setSpeaker(preset.voiceId);
      }
      if (preset.settings.language) live.qwen3.setLanguage(preset.settings.language);
      live.qwen3.setSeed(preset.settings.seed ?? null);
      pendingRef.current = { repo: profile.repo, instruct: preset.settings.instruction ?? "", reference };
      if (live.qwen3.profile.repo !== profile.repo) live.qwen3.setProfileRepo(profile.repo);
      else {
        // Already on the profile: the next render's effect applies the rest.
        live.qwen3.setInstruct(pendingRef.current.instruct);
        if (reference) {
          live.qwen3.setReferenceAudio(reference.name, reference.base64, reference.signature, reference.durationSec);
          live.qwen3.setReferenceText(reference.transcript);
        }
        pendingRef.current = null;
      }
      live.navigate(surface);
      return { ok: true, message: `Using ${voice.name} in ${where}.` };
    }

    if (preset.engineId === "neutts" || preset.engineId === "chatterbox") {
      const target = preset.engineId;
      const loaded = await cloneReference(target);
      if (!loaded || record?.kind !== "cloned") return { ok: false, message: "This voice's reference clip is missing from the library." };
      stageReference({
        voiceId: record.id,
        name: loaded.name,
        target,
        wavBase64: loaded.base64,
        transcript: (record as ClonedVoiceRecord).transcript,
        language: loaded.language,
        durationSec: loaded.durationSec,
        sha256: loaded.signature,
      });
      if (target === "chatterbox") {
        return { ok: false, message: "Reference saved for Chatterbox, which isn't available in this build yet." };
      }
      if (!depsRef.current.neuttsEnabled) {
        return { ok: false, message: "Turn on NeuTTS in Settings, then use this voice from its page." };
      }
      depsRef.current.navigate("neutts");
      return { ok: true, message: `Loaded ${voice.name} on the NeuTTS page.` };
    }

    return { ok: false, message: `${voice.engineLabel} voices can't be used from the library yet.` };
  }, []);
}
