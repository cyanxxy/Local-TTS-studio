import { useState, useRef, useEffect } from "react";
import { ChevronDown, Check } from "lucide-react";
import type { ModelType } from "../types";
import { MODELS } from "../constants";

interface VoiceSelectorProps {
  activeModel: ModelType;
  voice: string;
  onVoiceChange: (voice: string) => void;
  kokoroVoices: string[];
}

const GROUP_LABELS: Record<string, string> = {
  af: "American · Female",
  am: "American · Male",
  bf: "British · Female",
  bm: "British · Male",
};

/** "af_heart" → "Heart" */
function formatVoiceName(id: string): string {
  const i = id.indexOf("_");
  if (i === -1) return id;
  const name = id.slice(i + 1).replace(/_/g, " ");
  return name.charAt(0).toUpperCase() + name.slice(1);
}

function getGroup(id: string): string {
  return GROUP_LABELS[id.slice(0, 2)] ?? "Other";
}

export function VoiceSelector({
  activeModel,
  voice,
  onVoiceChange,
  kokoroVoices,
}: VoiceSelectorProps) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const openRef = useRef(open);

  const voices =
    activeModel === "supertonic"
      ? [...MODELS.supertonic.voices]
      : kokoroVoices;

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

  if (voices.length === 0) {
    return (
      <div className="flex flex-col gap-1.5">
        <span className="text-[10px] font-semibold uppercase tracking-widest text-text-muted">Voice</span>
        <span className="text-xs text-text-muted">Loading voices…</span>
      </div>
    );
  }

  if (activeModel === "supertonic") {
    return (
      <div className="flex flex-col gap-1.5">
        <span className="text-[10px] font-semibold uppercase tracking-widest text-text-muted">Voice</span>
        <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
          {voices.map((v) => (
            <button
              key={v}
              onClick={() => onVoiceChange(v)}
              className={`flex-1 py-2 px-3 text-sm rounded-xl border transition-all ${
                voice === v
                  ? "border-accent/40 bg-accent-light text-text-primary font-medium"
                  : "border-border text-text-muted hover:border-border-strong hover:text-text-secondary"
              }`}
            >
              {v}
            </button>
          ))}
        </div>
      </div>
    );
  }

  // Kokoro: group by accent
  const groups: Record<string, string[]> = {};
  for (const v of voices) {
    const g = getGroup(v);
    (groups[g] ??= []).push(v);
  }

  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-[10px] font-semibold uppercase tracking-widest text-text-muted">Voice</span>

      <div ref={containerRef} className="relative">
        {/* Trigger */}
        <button
          onClick={() => setOpen((o) => !o)}
          className="w-full flex items-center gap-2 px-3 py-2.5 text-sm bg-transparent border border-border rounded-xl text-text-primary hover:border-border-strong transition-all duration-200 active:scale-[0.98]"
        >
          <span className="flex-1 text-left">{formatVoiceName(voice)}</span>
          <ChevronDown
            size={14}
            className={`text-text-muted transition-transform duration-200 flex-shrink-0 ${open ? "rotate-180" : ""}`}
          />
        </button>

        {/* Dropdown */}
        {open && (
          <div
            className="absolute z-50 top-full mt-1.5 left-0 right-0 bg-panel border border-border rounded-xl overflow-hidden animate-scale-in"
            style={{ boxShadow: "var(--shadow-lg)" }}
          >
            <div className="max-h-64 overflow-y-auto">
              {Object.entries(groups).map(([groupLabel, groupVoices], i) => (
                <div key={groupLabel}>
                  {i > 0 && <div className="border-t border-border mx-3" />}
                  <div className="px-3 pt-2.5 pb-1 text-[9px] font-semibold uppercase tracking-widest text-text-muted">
                    {groupLabel}
                  </div>
                  {groupVoices.map((v) => (
                    <button
                      key={v}
                      onClick={() => { onVoiceChange(v); setOpen(false); }}
                      className={`w-full flex items-center justify-between px-3 py-2 text-sm transition-all duration-150 active:scale-[0.97] ${
                        v === voice
                          ? "text-text-primary bg-accent-light font-medium"
                          : "text-text-secondary hover:bg-border/40 hover:text-text-primary"
                      }`}
                    >
                      {formatVoiceName(v)}
                      {v === voice && <Check size={12} className="text-accent flex-shrink-0" />}
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
