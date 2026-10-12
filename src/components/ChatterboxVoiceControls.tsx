import { useId, useRef, useState } from "react";
import { AudioLines, Upload } from "lucide-react";
import { useChatterboxClips } from "../hooks/useChatterboxClips";
import { addChatterboxClipFromWav } from "../lib/chatterboxClips";
import { CHATTERBOX_DEFAULT_REFERENCE_ID } from "../lib/chatterboxProtocol";
import { CHATTERBOX_REFERENCE_MAX_SECONDS, CHATTERBOX_REFERENCE_MIN_SECONDS } from "../lib/chatterboxReference";
import { isChatterboxClipVoice } from "../models/chatterbox";
import { browserEngineVoiceLabel } from "../models/registry";

interface ChatterboxVoiceControlsProps {
  /** `chatterbox-default`, or the id of a loaded clip. */
  voice: string;
  onVoiceChange: (voice: string) => void;
}

function formatSeconds(seconds: number): string {
  return `${seconds.toFixed(1)} s`;
}

/**
 * Chatterbox speaks in a reference voice: the built-in sample, or any WAV clip
 * the user picks. The clip needs no transcript, never leaves this device, and
 * is kept for the session only.
 */
export function ChatterboxVoiceControls({ voice, onVoiceChange }: ChatterboxVoiceControlsProps) {
  const clips = useChatterboxClips();
  const inputRef = useRef<HTMLInputElement>(null);
  const inputId = useId();
  const [error, setError] = useState<string | null>(null);
  const [reading, setReading] = useState(false);
  const selectedClip = clips.find((clip) => clip.id === voice);
  // A cloned voice chosen in an earlier session whose file has not been loaded again.
  const missingClip = isChatterboxClipVoice(voice) && !selectedClip;

  const choose = async (file: File | undefined) => {
    if (!file) return;
    setError(null);
    setReading(true);
    try {
      const clip = await addChatterboxClipFromWav(await file.arrayBuffer(), file.name);
      onVoiceChange(clip.id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "That file could not be read.");
    } finally {
      setReading(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  };

  const optionClass = (selected: boolean) => `flex w-full items-center gap-2 rounded-xl border px-3 py-2 text-left text-sm transition-all duration-200 ${
    selected
      ? "border-accent/40 bg-accent-light font-medium text-text-primary shadow-accent-sm"
      : "border-border bg-text-primary/[0.03] text-text-muted hover:bg-text-primary/[0.07] hover:text-text-primary"
  }`;

  return (
    <div className="flex flex-col gap-2">
      <span className="text-sm font-semibold text-text-secondary">Voice</span>
      <div className="flex flex-col gap-1.5">
        <button
          type="button"
          aria-pressed={voice === CHATTERBOX_DEFAULT_REFERENCE_ID}
          onClick={() => onVoiceChange(CHATTERBOX_DEFAULT_REFERENCE_ID)}
          className={optionClass(voice === CHATTERBOX_DEFAULT_REFERENCE_ID)}
        >
          <AudioLines size={14} aria-hidden="true" className="shrink-0" />
          <span className="flex-1">Default voice</span>
          <span className="text-2xs font-normal text-text-muted">Built-in sample</span>
        </button>
        {clips.map((clip) => (
          <button
            key={clip.id}
            type="button"
            aria-pressed={voice === clip.id}
            onClick={() => onVoiceChange(clip.id)}
            className={optionClass(voice === clip.id)}
          >
            <AudioLines size={14} aria-hidden="true" className="shrink-0" />
            <span className="min-w-0 flex-1 truncate">{browserEngineVoiceLabel("chatterbox", clip.id)}</span>
            <span className="text-2xs font-normal text-text-muted">{formatSeconds(clip.durationSec)} of speech</span>
          </button>
        ))}
        {missingClip && (
          <p role="status" className="rounded-xl border border-warning/30 bg-warning/[0.08] px-3 py-2 text-xs leading-5 text-text-secondary">
            “{browserEngineVoiceLabel("chatterbox", voice)}” is selected but its file is not loaded in this session.
            Choose the WAV file again, or pick another voice.
          </p>
        )}
      </div>

      <input
        ref={inputRef}
        id={inputId}
        type="file"
        accept=".wav,audio/wav,audio/x-wav"
        className="sr-only"
        aria-label="Reference voice WAV file"
        onChange={(event) => void choose(event.target.files?.[0])}
      />
      <button
        type="button"
        disabled={reading}
        onClick={() => inputRef.current?.click()}
        className="flex w-full items-center justify-center gap-2 rounded-xl border border-border bg-text-primary/[0.04] px-3 py-2 text-sm text-text-secondary transition-colors hover:bg-text-primary/[0.07] hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-60"
      >
        <Upload size={14} aria-hidden="true" />
        {reading ? "Reading clip…" : "Clone a voice from a WAV file"}
      </button>
      {error && <p role="alert" className="text-xs leading-5 text-danger">{error}</p>}
      <p className="text-xs leading-5 text-text-muted">
        {CHATTERBOX_REFERENCE_MIN_SECONDS} to {CHATTERBOX_REFERENCE_MAX_SECONDS} seconds of clear speech from one
        speaker works best. No transcript is needed, and the clip stays on this device.
      </p>
    </div>
  );
}
