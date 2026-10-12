import { useId, useRef, useState } from "react";
import { ChevronRight, FileDown, FileUp, ListPlus, Plus, Trash2 } from "lucide-react";
import {
  appendRules,
  dictionariesJson,
  dictionaryFileName,
  dictionaryPls,
  mergeImportedDictionaries,
  parseBulkRules,
  readDictionaryFile,
} from "../../lib/creator/dictionaryFiles";
import { downloadBlob } from "../../lib/exportAudio";
import {
  MAX_DICTIONARIES_PER_FILE,
  MAX_DICTIONARY_FILE_CHARS,
  PronunciationDictionaryError,
  createPronunciationDictionary,
  isLanguageTag,
  validatePronunciationDictionary,
  type PronunciationDictionary,
  type PronunciationDictionaryRule,
} from "../../lib/pronunciation/dictionary";
import {
  checkboxLabelClass,
  fieldClass,
  ghostIconButtonClass,
  selectClass,
  subtleButtonClass,
} from "./creatorStyles";

interface PronunciationDictionaryEditorProps {
  dictionaries: PronunciationDictionary[];
  onChange: (dictionaries: PronunciationDictionary[]) => void;
  /** Whether the active engine reads IPA phonemes; none does yet, so a phoneme rule speaks its alias. */
  phonemesSupported: boolean;
  engineLabel?: string;
}

type RuleType = PronunciationDictionaryRule["type"];

/** What a rule row is editing. Fields hold text while it is typed and only become a rule once complete. */
interface RuleDraft {
  type: RuleType;
  from: string;
  to: string;
  phoneme: string;
  alias: string;
  caseSensitive: "auto" | "match" | "any";
  scope: "word" | "anywhere";
}

function toDraft(rule: PronunciationDictionaryRule): RuleDraft {
  return {
    type: rule.type,
    from: rule.from,
    to: rule.type === "alias" ? rule.to : "",
    phoneme: rule.type === "phoneme" ? rule.phoneme : "",
    alias: rule.type === "phoneme" ? (rule.alias ?? "") : "",
    caseSensitive: rule.caseSensitive === undefined ? "auto" : rule.caseSensitive ? "match" : "any",
    scope: rule.scope ?? "word",
  };
}

/** The rule a draft describes, or null while a required field is empty. */
function toRule(draft: RuleDraft): PronunciationDictionaryRule | null {
  const from = draft.from.trim();
  if (!from) return null;
  const options = {
    ...(draft.caseSensitive === "auto" ? {} : { caseSensitive: draft.caseSensitive === "match" }),
    ...(draft.scope === "word" ? {} : { scope: draft.scope }),
  };
  if (draft.type === "alias") {
    const to = draft.to.trim();
    return to ? { type: "alias", from, to, ...options } : null;
  }
  const phoneme = draft.phoneme.trim();
  const alias = draft.alias.trim();
  return phoneme ? { type: "phoneme", from, phoneme, alphabet: "ipa", ...(alias ? { alias } : {}), ...options } : null;
}

interface RuleRowProps {
  rule: PronunciationDictionaryRule;
  label: string;
  onChange: (rule: PronunciationDictionaryRule) => void;
  onDelete: () => void;
}

function RuleRow({ rule, label, onChange, onDelete }: RuleRowProps) {
  const [draft, setDraft] = useState(() => toDraft(rule));
  const [syncedRule, setSyncedRule] = useState(rule);
  // A rule changed from outside (an import, a deleted row above) replaces what was typed.
  if (rule !== syncedRule) {
    setSyncedRule(rule);
    setDraft(toDraft(rule));
  }
  const complete = toRule(draft) !== null;

  const commit = (next: RuleDraft) => {
    const built = toRule(next);
    if (built) onChange(built);
  };
  const edit = (patch: Partial<RuleDraft>, commitNow: boolean) => {
    const next = { ...draft, ...patch };
    setDraft(next);
    if (commitNow) commit(next);
  };

  return (
    <li className="rounded-lg border border-border/70 bg-text-primary/[0.03] p-2">
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_auto_1.4fr]">
        <input
          type="text"
          aria-label={`${label} written word`}
          aria-invalid={!complete}
          placeholder="Written as"
          value={draft.from}
          className={fieldClass}
          onChange={(event) => edit({ from: event.target.value }, false)}
          onBlur={() => commit(draft)}
        />
        <select
          aria-label={`${label} type`}
          value={draft.type}
          className={selectClass}
          onChange={(event) => edit({ type: event.target.value as RuleType }, true)}
        >
          <option value="alias">Alias</option>
          <option value="phoneme">IPA</option>
        </select>
        {draft.type === "alias" ? (
          <input
            type="text"
            aria-label={`${label} spoken replacement`}
            aria-invalid={!complete}
            placeholder="Spoken as"
            value={draft.to}
            className={fieldClass}
            onChange={(event) => edit({ to: event.target.value }, false)}
            onBlur={() => commit(draft)}
          />
        ) : (
          <div className="grid grid-cols-2 gap-2">
            <input
              type="text"
              aria-label={`${label} IPA`}
              aria-invalid={!complete}
              placeholder="IPA, e.g. dʒɪf"
              value={draft.phoneme}
              className={`${fieldClass} font-mono`}
              onChange={(event) => edit({ phoneme: event.target.value }, false)}
              onBlur={() => commit(draft)}
            />
            <input
              type="text"
              aria-label={`${label} spoken alias`}
              placeholder="Alias fallback"
              value={draft.alias}
              className={fieldClass}
              onChange={(event) => edit({ alias: event.target.value }, false)}
              onBlur={() => commit(draft)}
            />
          </div>
        )}
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <select
          aria-label={`${label} case`}
          value={draft.caseSensitive}
          className={`${selectClass} !w-auto`}
          onChange={(event) => edit({ caseSensitive: event.target.value as RuleDraft["caseSensitive"] }, true)}
        >
          <option value="auto">Case: automatic</option>
          <option value="match">Case: match exactly</option>
          <option value="any">Case: ignore</option>
        </select>
        <select
          aria-label={`${label} scope`}
          value={draft.scope}
          className={`${selectClass} !w-auto`}
          onChange={(event) => edit({ scope: event.target.value as RuleDraft["scope"] }, true)}
        >
          <option value="word">Whole words only</option>
          <option value="anywhere">Anywhere in a word</option>
        </select>
        {!complete && <span className="text-xs text-danger">Fill both fields to use this rule.</span>}
        <button
          type="button"
          aria-label={`Delete ${label}`}
          title="Delete rule"
          onClick={onDelete}
          className={`${ghostIconButtonClass} ml-auto`}
        >
          <Trash2 size={13} aria-hidden="true" />
        </button>
      </div>
    </li>
  );
}

interface DictionaryCardProps {
  dictionary: PronunciationDictionary;
  expanded: boolean;
  onToggleExpanded: () => void;
  onChange: (dictionary: PronunciationDictionary) => void;
  onDelete: () => void;
  onNotify: (message: Notice) => void;
}

interface Notice {
  tone: "info" | "error";
  text: string;
}

function errorText(error: unknown): string {
  return error instanceof PronunciationDictionaryError || error instanceof Error ? error.message : String(error);
}

function DictionaryCard({ dictionary, expanded, onToggleExpanded, onChange, onDelete, onNotify }: DictionaryCardProps) {
  const [bulk, setBulk] = useState<string | null>(null);
  const [newFrom, setNewFrom] = useState("");
  const [newTo, setNewTo] = useState("");
  const [language, setLanguage] = useState(dictionary.language ?? "");
  const [name, setName] = useState(dictionary.name);
  const idPrefix = useId();
  const bodyId = `${idPrefix}-body`;
  const newRuleReady = newFrom.trim() !== "" && newTo.trim() !== "";
  const languageValid = language.trim() === "" || isLanguageTag(language.trim());

  const apply = (next: unknown) => {
    try {
      onChange(validatePronunciationDictionary(next));
    } catch (error) {
      onNotify({ tone: "error", text: errorText(error) });
    }
  };
  const commitName = () => {
    const trimmed = name.trim();
    if (!trimmed) {
      setName(dictionary.name);
      return;
    }
    if (trimmed !== dictionary.name) apply({ ...dictionary, name: trimmed });
  };
  const commitLanguage = () => {
    const trimmed = language.trim();
    if (!languageValid) return;
    if (trimmed === (dictionary.language ?? "")) return;
    const { language: previous, ...rest } = dictionary;
    void previous;
    apply(trimmed ? { ...rest, language: trimmed } : rest);
  };
  const replaceRule = (index: number, rule: PronunciationDictionaryRule) => {
    apply({ ...dictionary, rules: dictionary.rules.map((existing, at) => (at === index ? rule : existing)) });
  };
  const addBulk = () => {
    const { rules, skipped } = parseBulkRules(bulk ?? "");
    if (rules.length === 0) {
      onNotify({ tone: "error", text: "No rules found. Write one rule per line as word=replacement." });
      return;
    }
    try {
      onChange(appendRules(dictionary, rules));
    } catch (error) {
      onNotify({ tone: "error", text: errorText(error) });
      return;
    }
    setBulk(null);
    onNotify({
      tone: skipped.length > 0 ? "error" : "info",
      text: skipped.length > 0
        ? `Added ${rules.length} ${rules.length === 1 ? "rule" : "rules"}. Skipped ${skipped.length} ${skipped.length === 1 ? "line" : "lines"} that were not word=replacement.`
        : `Added ${rules.length} ${rules.length === 1 ? "rule" : "rules"}.`,
    });
  };
  const exportPls = () => {
    downloadBlob(
      new Blob([dictionaryPls(dictionary)], { type: "application/pls+xml" }),
      dictionaryFileName(dictionary.name, "pls"),
    );
  };

  return (
    <li className="rounded-xl border border-border bg-text-primary/[0.03]">
      <div className="flex items-center gap-2 px-2 py-1.5">
        <button
          type="button"
          aria-expanded={expanded}
          aria-controls={bodyId}
          aria-label={`${expanded ? "Collapse" : "Expand"} ${dictionary.name}`}
          onClick={onToggleExpanded}
          className={ghostIconButtonClass}
        >
          <ChevronRight size={14} aria-hidden="true" className={`transition-transform ${expanded ? "rotate-90" : ""}`} />
        </button>
        <input
          type="text"
          aria-label={`Dictionary name for ${dictionary.name}`}
          value={name}
          className={`${fieldClass} !w-auto min-w-0 flex-1 !py-1.5 font-medium`}
          onChange={(event) => setName(event.target.value)}
          onBlur={commitName}
        />
        <span className="shrink-0 font-mono text-2xs tabular-nums text-text-muted">
          {dictionary.rules.length}
        </span>
        <label className={`${checkboxLabelClass} shrink-0 !items-center text-xs`}>
          <input
            type="checkbox"
            checked={dictionary.enabled}
            className="accent-accent"
            onChange={(event) => apply({ ...dictionary, enabled: event.target.checked })}
          />
          <span>On<span className="sr-only">: {dictionary.name}</span></span>
        </label>
        <button
          type="button"
          aria-label={`Delete dictionary ${dictionary.name}`}
          title="Delete dictionary"
          onClick={onDelete}
          className={ghostIconButtonClass}
        >
          <Trash2 size={13} aria-hidden="true" />
        </button>
      </div>

      {expanded && (
        <div id={bodyId} className="space-y-2 border-t border-border/70 p-2">
          <div className="flex flex-wrap items-center gap-2">
            <label className="flex items-center gap-2 text-xs text-text-secondary">
              Language
              <input
                type="text"
                aria-label={`Language tag for ${dictionary.name}`}
                aria-invalid={!languageValid}
                placeholder="All languages"
                value={language}
                className={`${fieldClass} !w-32 !py-1.5`}
                onChange={(event) => setLanguage(event.target.value)}
                onBlur={commitLanguage}
              />
            </label>
            <button type="button" className={`${subtleButtonClass} ml-auto`} onClick={exportPls}>
              <FileDown size={12} aria-hidden="true" />
              Export PLS
            </button>
          </div>
          {!languageValid && (
            <p className="text-xs text-danger">Use a language tag such as en, en-GB or fr.</p>
          )}

          {dictionary.rules.length === 0 && (
            <p className="text-xs text-text-muted">No rules yet. Add one below.</p>
          )}
          <ul className="space-y-2">
            {dictionary.rules.map((rule, index) => (
              <RuleRow
                // Rows have no identity beyond their place; RuleRow resyncs when its rule changes.
                key={index}
                rule={rule}
                label={`Rule ${index + 1}`}
                onChange={(next) => replaceRule(index, next)}
                onDelete={() => apply({ ...dictionary, rules: dictionary.rules.filter((_, at) => at !== index) })}
              />
            ))}
          </ul>

          <form
            className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_1fr_auto]"
            onSubmit={(event) => {
              event.preventDefault();
              if (!newRuleReady) return;
              try {
                onChange(appendRules(dictionary, [{ type: "alias", from: newFrom.trim(), to: newTo.trim() }]));
              } catch (error) {
                onNotify({ tone: "error", text: errorText(error) });
                return;
              }
              setNewFrom("");
              setNewTo("");
            }}
          >
            <input
              type="text"
              aria-label={`New rule in ${dictionary.name}: written as`}
              placeholder="Written as"
              value={newFrom}
              className={fieldClass}
              onChange={(event) => setNewFrom(event.target.value)}
            />
            <input
              type="text"
              aria-label={`New rule in ${dictionary.name}: spoken as`}
              placeholder="Spoken as"
              value={newTo}
              className={fieldClass}
              onChange={(event) => setNewTo(event.target.value)}
            />
            <button type="submit" className={subtleButtonClass} disabled={!newRuleReady}>
              <Plus size={12} aria-hidden="true" />
              Add rule
            </button>
          </form>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className={subtleButtonClass}
              aria-expanded={bulk !== null}
              onClick={() => setBulk((current) => (current === null ? "" : null))}
            >
              <ListPlus size={12} aria-hidden="true" />
              Add many
            </button>
          </div>
          {bulk !== null && (
            <div className="space-y-2">
              <label className="text-xs font-medium text-text-secondary" htmlFor={`${idPrefix}-bulk`}>
                One rule per line, as word=replacement
              </label>
              <textarea
                id={`${idPrefix}-bulk`}
                value={bulk}
                placeholder={"route=root\nGIF=jif\nSQL=sequel"}
                className={`${fieldClass} min-h-16 resize-y text-sm`}
                onChange={(event) => setBulk(event.target.value)}
              />
              <button type="button" className={subtleButtonClass} onClick={addBulk}>
                Add these rules
              </button>
            </div>
          )}
        </div>
      )}
    </li>
  );
}

/**
 * Manages the pronunciation dictionaries: named, switchable lists of alias and
 * IPA rules, with import and export as JSON or W3C PLS files.
 */
export function PronunciationDictionaryEditor({
  dictionaries,
  onChange,
  phonemesSupported,
  engineLabel,
}: PronunciationDictionaryEditorProps) {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set(dictionaries.slice(0, 1).map((dictionary) => dictionary.id)));
  const [notice, setNotice] = useState<Notice | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const fileInputId = useId();
  const noticeId = useId();
  const phonemeRuleCount = dictionaries.reduce(
    (total, dictionary) => total + dictionary.rules.filter((rule) => rule.type === "phoneme").length,
    0,
  );
  const atLimit = dictionaries.length >= MAX_DICTIONARIES_PER_FILE;

  const toggleExpanded = (id: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  };
  const addDictionary = () => {
    const created = createPronunciationDictionary({ name: `Dictionary ${dictionaries.length + 1}` });
    onChange([...dictionaries, created]);
    setExpanded((current) => new Set(current).add(created.id));
    setNotice(null);
  };
  const importFile = async (file: File) => {
    try {
      // Reject by size before reading: a legal file is at most three bytes per character.
      if (file.size > MAX_DICTIONARY_FILE_CHARS * 3) throw new PronunciationDictionaryError("The file is too large.");
      const { dictionaries: imported, warnings } = readDictionaryFile(file.name, await file.text());
      const merged = mergeImportedDictionaries(dictionaries, imported);
      onChange(merged);
      setExpanded((current) => new Set([...current, ...merged.slice(dictionaries.length).map((dictionary) => dictionary.id)]));
      const ruleCount = imported.reduce((total, dictionary) => total + dictionary.rules.length, 0);
      setNotice({
        tone: warnings.length > 0 ? "error" : "info",
        text: `Imported ${imported.length} ${imported.length === 1 ? "dictionary" : "dictionaries"} with ${ruleCount} ${ruleCount === 1 ? "rule" : "rules"}.${warnings.length > 0 ? ` ${warnings.join(" ")}` : ""}`,
      });
    } catch (error) {
      setNotice({ tone: "error", text: `Could not import ${file.name}. ${errorText(error)}` });
    }
  };
  const exportJson = () => {
    downloadBlob(new Blob([dictionariesJson(dictionaries)], { type: "application/json" }), "pronunciation-dictionaries.json");
  };

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className={subtleButtonClass} disabled={atLimit} onClick={addDictionary}>
          <Plus size={12} aria-hidden="true" />
          New dictionary
        </button>
        <input
          ref={fileInputRef}
          id={fileInputId}
          type="file"
          accept=".json,.pls,.xml,application/json,application/pls+xml,text/xml"
          aria-label="Import pronunciation dictionary file"
          className="sr-only"
          tabIndex={-1}
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = "";
            if (file) void importFile(file);
          }}
        />
        <button type="button" className={subtleButtonClass} onClick={() => fileInputRef.current?.click()}>
          <FileUp size={12} aria-hidden="true" />
          Import
        </button>
        <button type="button" className={subtleButtonClass} disabled={dictionaries.length === 0} onClick={exportJson}>
          <FileDown size={12} aria-hidden="true" />
          Export JSON
        </button>
      </div>

      <div id={noticeId} role="status" aria-live="polite">
        {notice && (
          <p className={`text-xs ${notice.tone === "error" ? "text-danger" : "text-text-muted"}`}>{notice.text}</p>
        )}
      </div>

      {dictionaries.length === 0 ? (
        <p className="text-xs text-text-muted">
          No dictionaries yet. Add one, or import a JSON or PLS file.
        </p>
      ) : (
        <ul className="space-y-2">
          {dictionaries.map((dictionary, index) => (
            <DictionaryCard
              key={dictionary.id}
              dictionary={dictionary}
              expanded={expanded.has(dictionary.id)}
              onToggleExpanded={() => toggleExpanded(dictionary.id)}
              onChange={(next) => onChange(dictionaries.map((existing, at) => (at === index ? next : existing)))}
              onDelete={() => {
                onChange(dictionaries.filter((_, at) => at !== index));
                setNotice(null);
              }}
              onNotify={setNotice}
            />
          ))}
        </ul>
      )}

      {phonemeRuleCount > 0 && !phonemesSupported && (
        <p className="text-xs text-text-muted">
          {engineLabel ?? "This engine"} reads text, not IPA, so IPA rules speak their alias. Rules without an alias are skipped.
        </p>
      )}
    </div>
  );
}
