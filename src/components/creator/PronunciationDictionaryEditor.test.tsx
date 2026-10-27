import { useState } from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as exportAudioModule from "../../lib/exportAudio";
import {
  createPronunciationDictionary,
  serializePronunciationDictionaries,
  type PronunciationDictionary,
} from "../../lib/pronunciation/dictionary";
import { serializePls } from "../../lib/pronunciation/pls";
import { PronunciationDictionaryEditor } from "./PronunciationDictionaryEditor";

afterEach(() => vi.restoreAllMocks());

const brand = createPronunciationDictionary({
  id: "brand",
  name: "Brand",
  rules: [
    { type: "alias", from: "GIF", to: "jif" },
    { type: "phoneme", from: "Nguyen", phoneme: "wɪn", alphabet: "ipa", alias: "win" },
  ],
});

function renderEditor(initial: PronunciationDictionary[], props: { phonemesSupported?: boolean } = {}) {
  const latest = { current: initial };
  function Harness() {
    const [dictionaries, setDictionaries] = useState(initial);
    latest.current = dictionaries;
    return (
      <PronunciationDictionaryEditor
        dictionaries={dictionaries}
        onChange={setDictionaries}
        phonemesSupported={props.phonemesSupported ?? false}
        engineLabel="Kokoro"
      />
    );
  }
  render(<Harness />);
  return latest;
}

function file(name: string, content: string): File {
  return new File([content], name);
}

describe("PronunciationDictionaryEditor", () => {
  it("starts empty and creates a dictionary that opens for editing", () => {
    const state = renderEditor([]);
    expect(screen.getByText(/No dictionaries yet/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Export JSON/ })).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "New dictionary" }));

    expect(state.current).toHaveLength(1);
    expect(state.current[0]).toMatchObject({ name: "Dictionary 1", enabled: true, rules: [] });
    expect(screen.getByText("No rules yet. Add one below.")).toBeInTheDocument();
  });

  it("edits a rule when a field loses focus and sets an incomplete one aside", () => {
    const state = renderEditor([brand]);
    const written = screen.getByLabelText("Rule 1 written word");
    const spoken = screen.getByLabelText("Rule 1 spoken replacement");

    fireEvent.change(spoken, { target: { value: "gif" } });
    expect(state.current[0].rules[0]).toMatchObject({ to: "jif" });
    fireEvent.blur(spoken);
    expect(state.current[0].rules[0]).toMatchObject({ type: "alias", from: "GIF", to: "gif" });

    // The UI says the rule is unused, so generation must not use it either:
    // it leaves the dictionary, while its row keeps its place and its text.
    fireEvent.change(written, { target: { value: "  " } });
    fireEvent.blur(written);
    expect(state.current[0].rules).toEqual([brand.rules[1]]);
    expect(screen.getByLabelText("Rule 1 written word")).toBe(written);
    expect(written).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByLabelText("Rule 1 spoken replacement")).toHaveValue("gif");
    expect(screen.getByText("Fill both fields to use this rule.")).toBeInTheDocument();

    // Completing it puts it back where it was.
    fireEvent.change(written, { target: { value: "GIFs" } });
    fireEvent.blur(written);
    expect(state.current[0].rules[0]).toMatchObject({ from: "GIFs", to: "gif" });
    expect(state.current[0].rules).toHaveLength(2);
  });

  it("deactivates a rule whose spoken field is cleared (F2)", () => {
    const state = renderEditor([brand]);
    const spoken = screen.getByRole("textbox", { name: "Rule 1 spoken replacement" });
    fireEvent.change(spoken, { target: { value: "" } });
    fireEvent.blur(spoken);
    expect(screen.getByText("Fill both fields to use this rule.")).toBeInTheDocument();
    expect(state.current[0].rules.some((rule) => rule.from === "GIF")).toBe(false);
  });

  it("drops an unfinished row on delete and keeps later rows in order", () => {
    const state = renderEditor([brand]);
    const spoken = screen.getByLabelText("Rule 1 spoken replacement");
    fireEvent.change(spoken, { target: { value: "" } });
    fireEvent.blur(spoken);
    fireEvent.click(screen.getByRole("button", { name: "Delete Rule 1" }));
    expect(state.current[0].rules).toEqual([brand.rules[1]]);
    expect(screen.getByLabelText("Rule 1 written word")).toHaveValue("Nguyen");
    expect(screen.queryByLabelText("Rule 2 written word")).not.toBeInTheDocument();
  });

  it("sets case and scope on a rule and switches a rule to IPA", () => {
    const state = renderEditor([brand]);

    fireEvent.change(screen.getByLabelText("Rule 1 case"), { target: { value: "match" } });
    fireEvent.change(screen.getByLabelText("Rule 1 scope"), { target: { value: "anywhere" } });
    expect(state.current[0].rules[0]).toMatchObject({ caseSensitive: true, scope: "anywhere" });
    fireEvent.change(screen.getByLabelText("Rule 1 case"), { target: { value: "any" } });
    expect(state.current[0].rules[0]).toMatchObject({ caseSensitive: false });
    fireEvent.change(screen.getByLabelText("Rule 1 case"), { target: { value: "auto" } });
    fireEvent.change(screen.getByLabelText("Rule 1 scope"), { target: { value: "word" } });
    expect(state.current[0].rules[0]).toEqual({ type: "alias", from: "GIF", to: "jif" });

    fireEvent.change(screen.getByLabelText("Rule 1 type"), { target: { value: "phoneme" } });
    // Until the IPA is filled in, the rule is set aside rather than still
    // speaking its old alias.
    expect(state.current[0].rules[0]).toMatchObject({ from: "Nguyen" });
    fireEvent.change(screen.getByLabelText("Rule 1 IPA"), { target: { value: "dʒɪf" } });
    fireEvent.change(screen.getByLabelText("Rule 1 spoken alias"), { target: { value: "jif" } });
    fireEvent.blur(screen.getByLabelText("Rule 1 spoken alias"));
    expect(state.current[0].rules[0]).toEqual({ type: "phoneme", from: "GIF", phoneme: "dʒɪf", alphabet: "ipa", alias: "jif" });

    fireEvent.change(screen.getByLabelText("Rule 1 spoken alias"), { target: { value: "" } });
    fireEvent.blur(screen.getByLabelText("Rule 1 IPA"));
    expect(state.current[0].rules[0]).toEqual({ type: "phoneme", from: "GIF", phoneme: "dʒɪf", alphabet: "ipa" });
  });

  it("adds and deletes rules", () => {
    const state = renderEditor([brand]);
    const add = screen.getByRole("button", { name: "Add rule" });
    expect(add).toBeDisabled();

    fireEvent.change(screen.getByLabelText("New rule in Brand: written as"), { target: { value: "SQL" } });
    expect(add).toBeDisabled();
    fireEvent.change(screen.getByLabelText("New rule in Brand: spoken as"), { target: { value: "sequel" } });
    fireEvent.click(add);
    expect(state.current[0].rules.at(-1)).toEqual({ type: "alias", from: "SQL", to: "sequel" });
    expect(screen.getByLabelText("New rule in Brand: written as")).toHaveValue("");

    fireEvent.submit(screen.getByLabelText("New rule in Brand: written as").closest("form")!);
    expect(state.current[0].rules).toHaveLength(3);

    fireEvent.click(screen.getByRole("button", { name: "Delete Rule 1" }));
    expect(state.current[0].rules.map((rule) => rule.from)).toEqual(["Nguyen", "SQL"]);
    // The remaining rows show the remaining rules.
    expect(screen.getByLabelText("Rule 1 written word")).toHaveValue("Nguyen");
  });

  it("adds many rules from pasted lines and reports skipped lines", () => {
    const state = renderEditor([brand]);
    fireEvent.click(screen.getByRole("button", { name: "Add many" }));
    const box = screen.getByLabelText("One rule per line, as word=replacement");

    fireEvent.click(screen.getByRole("button", { name: "Add these rules" }));
    expect(screen.getByRole("status")).toHaveTextContent("No rules found");

    fireEvent.change(box, { target: { value: "route=root\nnot a rule" } });
    fireEvent.click(screen.getByRole("button", { name: "Add these rules" }));
    expect(state.current[0].rules.at(-1)).toMatchObject({ from: "route", to: "root" });
    expect(screen.getByRole("status")).toHaveTextContent("Added 1 rule. Skipped 1 line that were not word=replacement.");
    expect(screen.queryByLabelText("One rule per line, as word=replacement")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Add many" }));
    fireEvent.change(screen.getByLabelText("One rule per line, as word=replacement"), { target: { value: "a=b\nc=d" } });
    fireEvent.click(screen.getByRole("button", { name: "Add these rules" }));
    expect(screen.getByRole("status")).toHaveTextContent("Added 2 rules.");
    fireEvent.click(screen.getByRole("button", { name: "Add many" }));
    fireEvent.click(screen.getByRole("button", { name: "Add many" }));
  });

  it("renames, toggles, tags a language and deletes a dictionary", () => {
    const state = renderEditor([brand]);

    const name = screen.getByLabelText("Dictionary name for Brand");
    fireEvent.change(name, { target: { value: "Names" } });
    fireEvent.blur(name);
    expect(state.current[0].name).toBe("Names");
    fireEvent.change(screen.getByLabelText("Dictionary name for Names"), { target: { value: "  " } });
    fireEvent.blur(screen.getByLabelText("Dictionary name for Names"));
    expect(screen.getByLabelText("Dictionary name for Names")).toHaveValue("Names");
    fireEvent.blur(screen.getByLabelText("Dictionary name for Names"));

    fireEvent.click(screen.getByRole("checkbox", { name: /On: Names/ }));
    expect(state.current[0].enabled).toBe(false);

    const language = screen.getByLabelText("Language tag for Names");
    fireEvent.change(language, { target: { value: "not a tag!" } });
    fireEvent.blur(language);
    expect(language).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByText(/Use a language tag/)).toBeInTheDocument();
    expect(state.current[0].language).toBeUndefined();
    fireEvent.change(language, { target: { value: "en-GB" } });
    fireEvent.blur(language);
    expect(state.current[0].language).toBe("en-GB");
    fireEvent.blur(language);
    fireEvent.change(language, { target: { value: "" } });
    fireEvent.blur(language);
    expect(state.current[0]).not.toHaveProperty("language");

    fireEvent.click(screen.getByRole("button", { name: "Collapse Names" }));
    expect(screen.queryByLabelText("Language tag for Names")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Expand Names" }));
    expect(screen.getByLabelText("Language tag for Names")).toBeInTheDocument();

    // A dictionary with rules asks first, and focus moves to the safe choice.
    const deleteButton = screen.getByRole("button", { name: "Delete dictionary Names" });
    deleteButton.focus();
    fireEvent.click(deleteButton);
    expect(state.current).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Keep" })).toHaveFocus();
    fireEvent.click(screen.getByRole("button", { name: "Keep" }));
    expect(screen.getByRole("button", { name: "Delete dictionary Names" })).toHaveFocus();
    fireEvent.click(screen.getByRole("button", { name: "Delete dictionary Names" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete Names" }));
    expect(state.current).toEqual([]);
  });

  it("imports JSON and PLS files, merging them with what is there", async () => {
    const state = renderEditor([brand]);
    const input = screen.getByLabelText("Import pronunciation dictionary file") as HTMLInputElement;

    const other = createPronunciationDictionary({ id: "brand", name: "Imported", rules: [{ type: "alias", from: "SQL", to: "sequel" }] });
    await act(async () => {
      fireEvent.change(input, { target: { files: [file("more.json", serializePronunciationDictionaries([other]))] } });
    });
    await waitFor(() => expect(state.current).toHaveLength(2));
    expect(state.current[1].name).toBe("Imported");
    expect(state.current[1].id).not.toBe("brand");
    expect(screen.getByRole("status")).toHaveTextContent("Imported 1 dictionary with 1 rule.");

    await act(async () => {
      fireEvent.change(input, { target: { files: [file("Names.pls", serializePls(brand))] } });
    });
    await waitFor(() => expect(state.current).toHaveLength(3));
    expect(state.current[2].name).toBe("Names");
    expect(screen.getByRole("status")).toHaveTextContent("Imported 1 dictionary with 2 rules.");

    await act(async () => {
      fireEvent.change(input, { target: { files: [] } });
    });
    expect(state.current).toHaveLength(3);
  });

  it("says why an import failed", async () => {
    const state = renderEditor([brand]);
    const input = screen.getByLabelText("Import pronunciation dictionary file");

    await act(async () => {
      fireEvent.change(input, { target: { files: [file("bad.json", "{nope")] } });
    });
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Could not import bad.json. The file is not valid JSON."));
    expect(state.current).toEqual([brand]);
  });

  it("refuses an oversized file without reading it", async () => {
    renderEditor([brand]);
    const huge = file("huge.json", "{}");
    Object.defineProperty(huge, "size", { value: 13 * 1024 * 1024 });
    const text = vi.spyOn(huge, "text");

    await act(async () => {
      fireEvent.change(screen.getByLabelText("Import pronunciation dictionary file"), { target: { files: [huge] } });
    });

    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Could not import huge.json. The file is too large."));
    expect(text).not.toHaveBeenCalled();
  });

  it("warns about PLS entries it skipped", async () => {
    renderEditor([]);
    const pls = '<?xml version="1.0"?><lexicon version="1.0" xmlns="http://www.w3.org/2005/01/pronunciation-lexicon" alphabet="ipa" xml:lang="en"><lexeme><grapheme>ok</grapheme><alias>okay</alias></lexeme><lexeme><grapheme>none</grapheme></lexeme></lexicon>';
    await act(async () => {
      fireEvent.change(screen.getByLabelText("Import pronunciation dictionary file"), { target: { files: [file("x.pls", pls)] } });
    });
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("has no alias or phoneme and was skipped"));
  });

  it("exports every dictionary as JSON and one as PLS", async () => {
    const downloads: Array<[Blob, string]> = [];
    vi.spyOn(exportAudioModule, "downloadBlob").mockImplementation((blob, name) => {
      downloads.push([blob, name]);
    });
    renderEditor([brand]);

    fireEvent.click(screen.getByRole("button", { name: /Export JSON/ }));
    fireEvent.click(screen.getByRole("button", { name: /Export PLS/ }));

    expect(downloads.map(([, name]) => name)).toEqual(["pronunciation-dictionaries.json", "Brand.pls"]);
    expect(await downloads[0][0].text()).toContain('"format": "open-tts-pronunciation-dictionaries"');
    expect(await downloads[1][0].text()).toContain("<grapheme>Nguyen</grapheme>");
  });

  it("is honest that no engine reads IPA yet, only when IPA rules exist", () => {
    const { unmount } = render(
      <PronunciationDictionaryEditor dictionaries={[brand]} onChange={() => {}} phonemesSupported={false} engineLabel="Kokoro" />,
    );
    expect(screen.getByText(/Kokoro reads text, not IPA/)).toBeInTheDocument();
    unmount();

    render(<PronunciationDictionaryEditor dictionaries={[brand]} onChange={() => {}} phonemesSupported />);
    expect(screen.queryByText(/reads text, not IPA/)).not.toBeInTheDocument();
  });

  it("falls back to a generic engine name and stops at the dictionary limit", () => {
    const full = Array.from({ length: 50 }, (_, index) => createPronunciationDictionary({ name: `D${index}` }));
    render(<PronunciationDictionaryEditor dictionaries={[brand, ...full.slice(1)]} onChange={() => {}} phonemesSupported={false} />);
    expect(screen.getByText(/This engine reads text/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "New dictionary" })).toBeDisabled();
  });
});
