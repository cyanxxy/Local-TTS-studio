import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { CatalogVoice } from "../../lib/voiceLibrary/catalog";
import { VoiceRow } from "./VoiceRow";

const voice = {
  key: "voice-1",
  name: "Narrator",
  origin: "library",
  detail: "Cloned voice",
  favorite: false,
  engineId: "qwen3",
} as unknown as CatalogVoice;

function renderRow(onDelete = vi.fn()) {
  render(
    <ul>
      <VoiceRow
        voice={voice}
        preview={null}
        canPreview={false}
        onPreview={vi.fn()}
        onStopPreview={vi.fn()}
        onToggleFavorite={vi.fn()}
        onUse={vi.fn()}
        onDelete={onDelete}
      />
    </ul>,
  );
  return onDelete;
}

describe("VoiceRow", () => {
  it("moves focus to Keep when Remove turns into its confirmation, and back", () => {
    renderRow();
    const remove = screen.getByRole("button", { name: "Remove Narrator" });
    remove.focus();
    fireEvent.click(remove);
    expect(screen.getByRole("button", { name: "Keep" })).toHaveFocus();

    fireEvent.click(screen.getByRole("button", { name: "Keep" }));
    expect(screen.getByRole("button", { name: "Remove Narrator" })).toHaveFocus();
  });

  it("deletes only after the confirmation", () => {
    const onDelete = renderRow();
    fireEvent.click(screen.getByRole("button", { name: "Remove Narrator" }));
    expect(onDelete).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Delete Narrator" }));
    expect(onDelete).toHaveBeenCalledWith(voice);
  });
});
