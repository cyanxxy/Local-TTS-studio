import { useState } from "react";
import { BookmarkPlus, Download, Loader2, Play, Square, Star, Trash2 } from "lucide-react";
import type { CatalogVoice } from "../../lib/voiceLibrary/catalog";
import type { VoicePreviewState } from "../../hooks/useVoicePreview";
import { iconButtonClass, secondaryButtonClass } from "./ui";

interface VoiceRowProps {
  voice: CatalogVoice;
  preview: VoicePreviewState | null;
  canPreview: boolean;
  onPreview: (voice: CatalogVoice) => void;
  onStopPreview: () => void;
  onToggleFavorite: (voice: CatalogVoice) => void;
  onUse: (voice: CatalogVoice, surface: "studio" | "reader") => void;
  onSavePreset?: (voice: CatalogVoice) => void;
  onExport?: (voice: CatalogVoice) => void;
  onDelete?: (voice: CatalogVoice) => void;
  children?: React.ReactNode;
}

/** One voice in the library list: identity, favorite, preview, and the actions that apply to it. */
export function VoiceRow({
  voice,
  preview,
  canPreview,
  onPreview,
  onStopPreview,
  onToggleFavorite,
  onUse,
  onSavePreset,
  onExport,
  onDelete,
  children,
}: VoiceRowProps) {
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const rendering = preview?.status === "rendering";
  const playing = preview?.status === "playing";

  return (
    <li className="rounded-2xl border border-border bg-panel p-3">
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          className={iconButtonClass}
          aria-pressed={voice.favorite}
          aria-label={`Favorite ${voice.name}`}
          onClick={() => onToggleFavorite(voice)}
        >
          <Star size={14} aria-hidden className={voice.favorite ? "fill-warning text-warning" : undefined} />
        </button>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold text-text-primary">{voice.name}</p>
          <p className="truncate text-xs text-text-muted">
            {voice.origin === "engine" ? [voice.engineLabel, voice.detail].filter(Boolean).join(" · ") : voice.detail}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            className={iconButtonClass}
            disabled={!canPreview || rendering}
            aria-label={playing ? `Stop preview of ${voice.name}` : `Preview ${voice.name}`}
            title={canPreview ? "Preview" : "This engine can't be previewed here"}
            onClick={() => (playing ? onStopPreview() : onPreview(voice))}
          >
            {rendering ? <Loader2 size={14} className="animate-spin" aria-hidden /> : playing ? <Square size={14} aria-hidden /> : <Play size={14} aria-hidden />}
          </button>
          <button type="button" className={secondaryButtonClass} aria-label={`Use ${voice.name} in Studio`} onClick={() => onUse(voice, "studio")}>
            Studio
          </button>
          <button type="button" className={secondaryButtonClass} aria-label={`Use ${voice.name} in Reader`} onClick={() => onUse(voice, "reader")}>
            Reader
          </button>
          {onSavePreset && (
            <button type="button" className={iconButtonClass} aria-label={`Save ${voice.name} as a preset`} title="Save as preset" onClick={() => onSavePreset(voice)}>
              <BookmarkPlus size={14} aria-hidden />
            </button>
          )}
          {onExport && (
            <button type="button" className={iconButtonClass} aria-label={`Export ${voice.name}`} title="Export" onClick={() => onExport(voice)}>
              <Download size={14} aria-hidden />
            </button>
          )}
          {onDelete && (confirmingDelete ? (
            <>
              <button type="button" className={`${secondaryButtonClass} text-danger`} onClick={() => { setConfirmingDelete(false); onDelete(voice); }}>
                Delete {voice.name}
              </button>
              <button type="button" className={secondaryButtonClass} onClick={() => setConfirmingDelete(false)}>Keep</button>
            </>
          ) : (
            <button type="button" className={iconButtonClass} aria-label={`Remove ${voice.name}`} title="Remove" onClick={() => setConfirmingDelete(true)}>
              <Trash2 size={14} aria-hidden />
            </button>
          ))}
        </div>
      </div>
      {preview?.status === "error" && <p role="alert" className="mt-2 text-xs text-danger">{preview.message}</p>}
      {children}
    </li>
  );
}
