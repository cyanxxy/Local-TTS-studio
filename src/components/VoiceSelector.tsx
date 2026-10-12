import { useState, useRef, useEffect, useId } from "react";
import { ChevronDown, Check } from "lucide-react";
import type { ModelState, ModelType } from "../types";
import { engineVoices } from "../models/registry";
import type { EngineVoice } from "../models/types";
import { PiperVoiceBrowser } from "./PiperVoiceBrowser";

interface VoiceSelectorProps {
  activeModel: ModelType;
  voice: string;
  onVoiceChange: (voice: string) => void;
  /** Voices the loaded Kokoro model reported; other engines list their own. */
  kokoroVoices: string[];
  /** The active browser engine's load state; Piper reports its voice downloads through it. */
  modelState?: ModelState;
}

export function VoiceSelector({
  activeModel,
  voice,
  onVoiceChange,
  kokoroVoices,
  modelState,
}: VoiceSelectorProps) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const openRef = useRef(open);
  const menuId = useId();

  const voices = engineVoices(activeModel, { runtimeVoices: kokoroVoices });

  useEffect(() => {
    openRef.current = open;
  }, [open]);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (!openRef.current) return;
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  // Piper's twenty-odd voices need a browser of their own: grouped, filterable,
  // with sizes, licences and attribution.
  if (activeModel === "piper") {
    return <PiperVoiceBrowser voice={voice} onVoiceChange={onVoiceChange} modelState={modelState} />;
  }

  if (voices.length === 0) {
    return (
      <div className="flex flex-col gap-1.5">
        <span className="text-sm font-semibold text-text-secondary">Voice</span>
        <span className="text-xs text-text-muted">Loading voices…</span>
      </div>
    );
  }

  // A short, ungrouped catalogue reads best as buttons; a grouped one (Kokoro's
  // accents) gets a menu with a section per group.
  if (!voices.every((entry) => entry.group)) {
    return (
      <div className="flex flex-col gap-1.5">
        <span className="text-sm font-semibold text-text-secondary">Voice</span>
        <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
          {voices.map((entry) => (
            <button
              key={entry.id}
              type="button"
              aria-pressed={voice === entry.id}
              onClick={() => onVoiceChange(entry.id)}
              className={`flex-1 py-2 px-3 text-sm rounded-xl border transition-all duration-200 ${
                voice === entry.id
                  ? "border-accent/40 bg-accent-light text-text-primary font-medium shadow-accent-sm"
                  : "border-border bg-text-primary/[0.03] text-text-muted hover:bg-text-primary/[0.07] hover:text-text-primary"
              }`}
            >
              {entry.label}
              {entry.detail && <span className="block text-2xs font-normal text-text-muted">{entry.detail}</span>}
            </button>
          ))}
        </div>
      </div>
    );
  }

  const groups: Record<string, EngineVoice[]> = {};
  for (const entry of voices) {
    (groups[entry.group ?? "Other"] ??= []).push(entry);
  }
  const selectedLabel = voices.find((entry) => entry.id === voice)?.label ?? voice;

  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-sm font-semibold text-text-secondary">Voice</span>

      <div ref={containerRef} className="relative">
        {/* Trigger */}
        <button
          ref={triggerRef}
          type="button"
          onClick={() => setOpen((o) => !o)}
          onKeyDown={(event) => {
            if (event.key === "Escape" && open) {
              event.preventDefault();
              setOpen(false);
            }
          }}
          aria-haspopup="menu"
          aria-expanded={open}
          aria-controls={open ? menuId : undefined}
          className="w-full flex items-center gap-2 px-3 py-2.5 text-sm rounded-xl border border-border bg-text-primary/[0.04] text-text-primary transition-all duration-200 hover:bg-text-primary/[0.07] active:scale-[0.98]"
        >
          <span className="flex-1 text-left">{selectedLabel}</span>
          <ChevronDown
            size={14}
            className={`text-text-muted transition-transform duration-200 flex-shrink-0 ${open ? "rotate-180" : ""}`}
          />
        </button>

        {/* Dropdown */}
        {open && (
          <div
            id={menuId}
            role="menu"
            aria-label="Select voice"
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                setOpen(false);
                triggerRef.current?.focus();
              }
            }}
            className="absolute z-50 top-full mt-1.5 left-0 right-0 glass-pop rounded-2xl overflow-hidden animate-scale-in"
          >
            <div className="max-h-64 overflow-y-auto">
              {Object.entries(groups).map(([groupLabel, groupVoices], i) => (
                <div key={groupLabel}>
                  {i > 0 && <div className="border-t border-black/5 mx-3" />}
                  <div className="px-3 pt-2.5 pb-1 text-xs font-semibold text-text-secondary">
                    {groupLabel}
                  </div>
                  {groupVoices.map((entry) => (
                    <button
                      key={entry.id}
                      type="button"
                      role="menuitemradio"
                      aria-checked={entry.id === voice}
                      onClick={() => { onVoiceChange(entry.id); setOpen(false); }}
                      className={`w-full flex items-center justify-between px-3 py-2 text-sm transition-all duration-150 active:scale-[0.97] ${
                        entry.id === voice
                          ? "text-text-primary bg-accent-light font-medium"
                          : "text-text-secondary hover:bg-text-primary/[0.07] hover:text-text-primary"
                      }`}
                    >
                      {entry.label}
                      {entry.id === voice && <Check size={12} className="text-accent flex-shrink-0" />}
                    </button>
                  ))}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
