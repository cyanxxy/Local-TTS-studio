import { useCallback, useId, useState } from "react";
import { AudioLines, Library, Wand2 } from "lucide-react";
import type { PresetSynthesize } from "../../lib/presetSynthesis";
import { libraryCatalogVoice, type CatalogVoice, type RuntimeVoiceMap } from "../../lib/voiceLibrary/catalog";
import type { TranscribeClip } from "../../lib/voiceLibrary/cloneWizard";
import type { VoiceRecord } from "../../lib/voiceLibrary/types";
import type { CreateAuditionAudio } from "../../hooks/useAudition";
import type { ApplyResult, ApplySurface } from "../../hooks/useVoiceApplier";
import type { UseMicRecorderOptions } from "../../hooks/useMicRecorder";
import type { UseVoiceLibraryReturn } from "../../hooks/useVoiceLibrary";
import { CloneWizard } from "./CloneWizard";
import { VoiceDesignPanel } from "./VoiceDesignPanel";
import { VoiceLibraryPanel } from "./VoiceLibraryPanel";

export interface VoicesPageProps {
  library: UseVoiceLibraryReturn;
  runtimeVoices: RuntimeVoiceMap;
  synthesize: PresetSynthesize;
  renderKey?: (voice: CatalogVoice) => Promise<string>;
  apply: (voice: CatalogVoice, surface: ApplySurface) => Promise<ApplyResult>;
  /** Whether a Qwen3 VoiceDesign model is installed, and what to tell the user when it is not. */
  designAvailable: boolean;
  designUnavailableReason?: string;
  /** Automatic transcription for the cloning wizard; absent while it is paused. */
  transcribe?: TranscribeClip;
  createRecorder?: UseMicRecorderOptions["createRecorder"];
  createAudio?: CreateAuditionAudio;
  saveFile?: (blob: Blob, fileName: string) => void;
}

const TABS = [
  { id: "library", label: "Library", icon: Library },
  { id: "clone", label: "Clone a voice", icon: AudioLines },
  { id: "design", label: "Design a voice", icon: Wand2 },
] as const;
type TabId = typeof TABS[number]["id"];

/**
 * The Voice Library page: browse and preview every voice, clone one from a
 * recording, or design one from a description. The tabs stay mounted, so a
 * half-finished clone survives a look at the library.
 */
export function VoicesPage({
  library,
  runtimeVoices,
  synthesize,
  renderKey,
  apply,
  designAvailable,
  designUnavailableReason,
  transcribe,
  createRecorder,
  createAudio,
  saveFile,
}: VoicesPageProps) {
  const [tab, setTab] = useState<TabId>("library");
  const baseId = useId();
  const applyRecord = useCallback(
    (record: VoiceRecord, surface: ApplySurface) => apply(libraryCatalogVoice(record), surface),
    [apply],
  );

  return (
    <div className="mt-6 space-y-4">
      <div className="flex flex-col gap-1">
        <h2 className="font-display text-xl font-semibold text-text-primary">Voices</h2>
        <p className="text-sm text-text-secondary">Every voice in one place. Preview, clone, design and save them, then use one in Studio or the Reader.</p>
      </div>
      <div role="tablist" aria-label="Voice tools" className="flex flex-wrap gap-2">
        {TABS.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            type="button"
            role="tab"
            id={`${baseId}-${id}-tab`}
            aria-selected={tab === id}
            aria-controls={`${baseId}-${id}-panel`}
            tabIndex={tab === id ? 0 : -1}
            onClick={() => setTab(id)}
            onKeyDown={(event) => {
              const index = TABS.findIndex((item) => item.id === tab);
              const next = event.key === "ArrowRight" ? index + 1 : event.key === "ArrowLeft" ? index - 1 : null;
              if (next === null) return;
              event.preventDefault();
              const target = TABS[(next + TABS.length) % TABS.length].id;
              setTab(target);
              document.getElementById(`${baseId}-${target}-tab`)?.focus();
            }}
            className={`inline-flex items-center gap-2 rounded-xl border px-4 py-2 text-sm font-semibold transition-colors ${
              tab === id ? "border-accent/45 bg-accent/10 text-accent" : "border-border bg-text-primary/[0.04] text-text-secondary hover:text-text-primary"
            }`}
          >
            <Icon size={14} aria-hidden /> {label}
          </button>
        ))}
      </div>
      <div className="surface rounded-[24px] p-4 sm:p-6">
        <div role="tabpanel" id={`${baseId}-library-panel`} aria-labelledby={`${baseId}-library-tab`} hidden={tab !== "library"}>
          <VoiceLibraryPanel
            library={library}
            runtimeVoices={runtimeVoices}
            synthesize={synthesize}
            renderKey={renderKey}
            apply={apply}
            createAudio={createAudio}
            saveFile={saveFile}
          />
        </div>
        <div role="tabpanel" id={`${baseId}-clone-panel`} aria-labelledby={`${baseId}-clone-tab`} hidden={tab !== "clone"}>
          <CloneWizard library={library} onUse={applyRecord} transcribe={transcribe} createRecorder={createRecorder} createAudio={createAudio} />
        </div>
        <div role="tabpanel" id={`${baseId}-design-panel`} aria-labelledby={`${baseId}-design-tab`} hidden={tab !== "design"}>
          <VoiceDesignPanel
            library={library}
            synthesize={synthesize}
            available={designAvailable}
            unavailableReason={designUnavailableReason}
            onUse={applyRecord}
            createAudio={createAudio}
          />
        </div>
      </div>
    </div>
  );
}
