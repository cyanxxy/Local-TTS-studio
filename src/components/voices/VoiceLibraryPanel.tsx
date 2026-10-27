import { useCallback, useMemo, useRef, useState } from "react";
import { Search, Star, Upload } from "lucide-react";
import { downloadBlob } from "../../lib/exportAudio";
import type { PresetSynthesize } from "../../lib/presetSynthesis";
import {
  buildEngineCatalog,
  catalogFacets,
  filterCatalog,
  libraryCatalogVoice,
  type CatalogGender,
  type CatalogVoice,
  type RuntimeVoiceMap,
} from "../../lib/voiceLibrary/catalog";
import { isSurfaceEngine } from "../../lib/voiceLibrary/presetRequest";
import { defaultVoiceDesignPreviewText } from "../../lib/voiceDesignPreviews";
import { loadBuiltinFavorites, saveBuiltinFavorites } from "../../lib/voiceLibrary/builtinFavorites";
import type { VoicePresetSettings } from "../../lib/voiceLibrary/types";
import { MAX_VOICE_PACKAGE_BYTES, VOICE_PACKAGE_EXTENSION } from "../../lib/voiceLibrary/portable";
import { useVoicePreview } from "../../hooks/useVoicePreview";
import type { CreateAuditionAudio } from "../../hooks/useAudition";
import type { ApplyResult, ApplySurface } from "../../hooks/useVoiceApplier";
import type { UseVoiceLibraryReturn } from "../../hooks/useVoiceLibrary";
import { SavePresetForm } from "./SavePresetForm";
import { useFocusRecovery } from "../useFocusRecovery";
import { VoiceRow } from "./VoiceRow";
import { errorCalloutClass, infoCalloutClass, inputClass, secondaryButtonClass } from "./ui";

type Scope = "all" | "mine" | "builtin";
const SCOPES: ReadonlyArray<{ value: Scope; label: string }> = [
  { value: "all", label: "All voices" },
  { value: "mine", label: "My voices" },
  { value: "builtin", label: "Built-in" },
];

export interface VoiceLibraryPanelProps {
  library: UseVoiceLibraryReturn;
  runtimeVoices: RuntimeVoiceMap;
  synthesize: PresetSynthesize;
  renderKey?: (voice: CatalogVoice) => Promise<string>;
  apply: (voice: CatalogVoice, surface: ApplySurface) => Promise<ApplyResult>;
  createAudio?: CreateAuditionAudio;
  /** Saves an exported voice; defaults to a browser download. */
  saveFile?: (blob: Blob, fileName: string) => void;
}

function previewTextFor(voice: CatalogVoice): string {
  return defaultVoiceDesignPreviewText(voice.language ?? "English");
}

/**
 * The Voice Library: every engine's built-in voices and the user's own voices
 * in one searchable list, with preview, favorites, presets, one-click use in
 * Studio or the Reader, and portable import and export.
 */
export function VoiceLibraryPanel({ library, runtimeVoices, synthesize, renderKey, apply, createAudio, saveFile = downloadBlob }: VoiceLibraryPanelProps) {
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState<Scope>("all");
  const [engineId, setEngineId] = useState("");
  const [language, setLanguage] = useState("");
  const [gender, setGender] = useState<CatalogGender | "">("");
  const [favoritesOnly, setFavoritesOnly] = useState(false);
  const [builtinFavorites, setBuiltinFavorites] = useState(() => loadBuiltinFavorites());
  const [presetKey, setPresetKey] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const preview = useVoicePreview(synthesize, library.store, createAudio, renderKey);

  const catalog = useMemo(
    () => [...buildEngineCatalog(runtimeVoices, builtinFavorites), ...library.voices.map(libraryCatalogVoice)],
    [builtinFavorites, library.voices, runtimeVoices],
  );
  const facets = useMemo(() => catalogFacets(catalog), [catalog]);
  const visible = useMemo(
    () => filterCatalog(catalog, {
      query,
      scope,
      engineId: engineId || undefined,
      language: language || undefined,
      gender: gender || undefined,
      favoritesOnly,
    }),
    [catalog, engineId, favoritesOnly, gender, language, query, scope],
  );

  const toggleFavorite = useCallback(async (voice: CatalogVoice) => {
    if (voice.record) {
      try {
        await library.setFavorite(voice.record.id, !voice.record.favorite);
      } catch (error) {
        setNotice({ ok: false, text: error instanceof Error ? error.message : "The favorite could not be saved." });
      }
      return;
    }
    setBuiltinFavorites((current) => {
      const next = new Set(current);
      if (!next.delete(voice.key)) next.add(voice.key);
      saveBuiltinFavorites(next);
      return next;
    });
  }, [library]);

  const use = useCallback(async (voice: CatalogVoice, surface: ApplySurface) => {
    const result = await apply(voice, surface);
    setNotice({ ok: result.ok, text: result.message });
  }, [apply]);

  const savePreset = useCallback(async (voice: CatalogVoice, input: { name: string; settings: VoicePresetSettings }) => {
    const base = voice.preset;
    await library.createVoice({
      kind: "preset",
      name: input.name,
      preset: { engineId: base.engineId, voiceId: base.voiceId, settings: input.settings },
    });
    setPresetKey(null);
    setNotice({ ok: true, text: `Saved preset “${input.name}” to My Voices.` });
  }, [library]);

  const exportVoice = useCallback(async (voice: CatalogVoice) => {
    if (!voice.record) return;
    try {
      const { fileName, bytes } = await library.exportVoice(voice.record.id);
      saveFile(new Blob([bytes as BlobPart], { type: "application/zip" }), fileName);
      setNotice({ ok: true, text: `Exported ${fileName}.` });
    } catch (error) {
      setNotice({ ok: false, text: error instanceof Error ? error.message : "The voice could not be exported." });
    }
  }, [library, saveFile]);

  const removeVoice = useCallback(async (voice: CatalogVoice) => {
    if (!voice.record) return;
    try {
      await library.deleteVoice(voice.record.id);
      setNotice({ ok: true, text: `Removed ${voice.name}.` });
    } catch (error) {
      setNotice({ ok: false, text: error instanceof Error ? error.message : "The voice could not be removed." });
    }
  }, [library]);

  const importFile = useCallback(async (file: File | undefined) => {
    if (!file) return;
    try {
      // Size first: reading a huge file into memory is the cost to avoid.
      if (file.size > MAX_VOICE_PACKAGE_BYTES) {
        throw new Error(`That file is larger than ${Math.round(MAX_VOICE_PACKAGE_BYTES / 1_000_000)} MB, so it is not a voice package.`);
      }
      const record = await library.importVoice(new Uint8Array(await file.arrayBuffer()));
      setScope("mine");
      setNotice({ ok: true, text: `Imported ${record.name}.` });
    } catch (error) {
      setNotice({ ok: false, text: error instanceof Error ? error.message : "That file is not a voice package." });
    }
  }, [library]);

  const previewVoice = useCallback((voice: CatalogVoice) => {
    void preview.preview(voice, previewTextFor(voice));
  }, [preview]);

  const kokoroMissing = !runtimeVoices.kokoro || runtimeVoices.kokoro.length === 0;

  // Deleting a voice removes the row its confirm button was in; focus lands
  // on the list's first control instead of the page body.
  const sectionRef = useRef<HTMLElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  useFocusRecovery(sectionRef, () => listRef.current?.querySelector<HTMLElement>("button:not([disabled])"));

  return (
    <section ref={sectionRef} aria-label="Voice library" className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <label className="relative min-w-48 flex-1">
          <span className="sr-only">Search voices</span>
          <Search size={14} aria-hidden className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-muted" />
          <input
            type="search"
            aria-label="Search voices"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search by name, engine, tag or description"
            className={`${inputClass} pl-9`}
          />
        </label>
        <label className="text-xs font-medium text-text-secondary">
          Engine
          <select aria-label="Engine" value={engineId} onChange={(event) => setEngineId(event.target.value)} className={`mt-1 ${inputClass}`}>
            <option value="">All engines</option>
            {facets.engines.map((engine) => <option key={engine.id} value={engine.id}>{engine.label}</option>)}
          </select>
        </label>
        <label className="text-xs font-medium text-text-secondary">
          Language
          <select aria-label="Language" value={language} onChange={(event) => setLanguage(event.target.value)} className={`mt-1 ${inputClass}`}>
            <option value="">Any language</option>
            {facets.languages.map((item) => <option key={item} value={item}>{item}</option>)}
          </select>
        </label>
        <label className="text-xs font-medium text-text-secondary">
          Gender
          <select aria-label="Gender" value={gender} onChange={(event) => setGender(event.target.value as CatalogGender | "")} className={`mt-1 ${inputClass}`}>
            <option value="">Any</option>
            <option value="female">Female</option>
            <option value="male">Male</option>
          </select>
        </label>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div role="group" aria-label="Show" className="flex gap-1.5">
          {SCOPES.map((item) => (
            <button
              key={item.value}
              type="button"
              aria-pressed={scope === item.value}
              onClick={() => setScope(item.value)}
              className={`rounded-lg border px-3 py-1.5 text-xs font-semibold transition-colors ${
                scope === item.value ? "border-accent/45 bg-accent/10 text-accent" : "border-border bg-text-primary/[0.04] text-text-secondary hover:text-text-primary"
              }`}
            >
              {item.label}
            </button>
          ))}
        </div>
        <button
          type="button"
          aria-pressed={favoritesOnly}
          onClick={() => setFavoritesOnly((current) => !current)}
          className={`inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-semibold transition-colors ${
            favoritesOnly ? "border-warning/50 bg-warning-light text-text-primary" : "border-border bg-text-primary/[0.04] text-text-secondary hover:text-text-primary"
          }`}
        >
          <Star size={12} aria-hidden /> Favorites
        </button>
        <label className={`${secondaryButtonClass} ml-auto cursor-pointer`}>
          <Upload size={14} aria-hidden /> Import voice
          <input
            type="file"
            accept={`${VOICE_PACKAGE_EXTENSION},.zip,application/zip`}
            aria-label="Import voice file"
            className="sr-only"
            onChange={(event) => {
              void importFile(event.target.files?.[0]);
              event.target.value = "";
            }}
          />
        </label>
      </div>

      <div role="status" aria-live="polite">
        {notice && <p className={notice.ok ? infoCalloutClass : errorCalloutClass}>{notice.text}</p>}
        {library.error && <p className={errorCalloutClass}>{library.error}</p>}
      </div>

      {kokoroMissing && scope !== "mine" && (
        <p className="text-xs text-text-muted">Kokoro voices appear after its model has loaded once in Studio.</p>
      )}

      {visible.length === 0 ? (
        <p className="rounded-2xl border border-dashed border-border p-6 text-center text-sm text-text-muted">
          {library.loading ? "Loading voices…" : "No voices match. Clear the filters, or clone or design a new voice."}
        </p>
      ) : (
        <ul ref={listRef} aria-label="Voices" className="space-y-2">
          {visible.map((voice) => (
            <VoiceRow
              key={voice.key}
              voice={voice}
              preview={preview.state?.key === voice.key ? preview.state : null}
              canPreview={isSurfaceEngine(voice.engineId)}
              onPreview={previewVoice}
              onStopPreview={preview.stop}
              onToggleFavorite={(item) => void toggleFavorite(item)}
              onUse={(item, surface) => void use(item, surface)}
              onSavePreset={voice.record === null || voice.record.kind === "preset" ? (item) => setPresetKey(presetKey === item.key ? null : item.key) : undefined}
              onExport={voice.record ? (item) => void exportVoice(item) : undefined}
              onDelete={voice.record ? (item) => void removeVoice(item) : undefined}
            >
              {presetKey === voice.key && (
                <SavePresetForm voice={voice} onSave={(input) => savePreset(voice, input)} onCancel={() => setPresetKey(null)} />
              )}
            </VoiceRow>
          ))}
        </ul>
      )}
    </section>
  );
}
