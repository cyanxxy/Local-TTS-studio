import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { GENERATION_HISTORY_LIMITS, type GenerationHistoryEntry } from "../lib/history/generationHistory";
import { StudioHistoryPanel } from "./StudioHistoryPanel";

function entry(id: string, overrides: Partial<GenerationHistoryEntry> = {}): GenerationHistoryEntry {
  return {
    schemaVersion: 1,
    id,
    createdAt: Date.UTC(2026, 9, 11, 14, 5),
    lastAccessedAt: Date.UTC(2026, 9, 11, 14, 5),
    title: `Title ${id}`,
    text: `Text ${id}`,
    engineId: "kokoro",
    voice: { engineId: "kokoro", voiceId: "af_heart", settings: {} },
    settings: {},
    durationSec: 65,
    sampleRate: 24000,
    byteLength: 1000,
    chunkCount: 1,
    favorite: false,
    completed: true,
    ...overrides,
  };
}

function baseProps(overrides: Partial<React.ComponentProps<typeof StudioHistoryPanel>> = {}): React.ComponentProps<typeof StudioHistoryPanel> {
  return {
    entries: [entry("a")],
    usage: { entryCount: 1, totalBytes: 0, favoriteCount: 0 },
    loading: false,
    error: null,
    onReplay: vi.fn(),
    onDownload: vi.fn(),
    onReuse: vi.fn(),
    onSetFavorite: vi.fn(async () => undefined),
    onDelete: vi.fn(async () => undefined),
    onClear: vi.fn(async () => undefined),
    ...overrides,
  };
}

function setup(overrides: Partial<React.ComponentProps<typeof StudioHistoryPanel>> = {}) {
  const props: React.ComponentProps<typeof StudioHistoryPanel> = {
    entries: [entry("a"), entry("b", { favorite: true, seed: 42, engineId: "qwen3" })],
    usage: { entryCount: 2, totalBytes: 5 * 1024 * 1024, favoriteCount: 1 },
    loading: false,
    error: null,
    onReplay: vi.fn(),
    onDownload: vi.fn(),
    onReuse: vi.fn(),
    onSetFavorite: vi.fn(async () => undefined),
    onDelete: vi.fn(async () => undefined),
    onClear: vi.fn(async () => undefined),
    ...overrides,
  };
  render(<StudioHistoryPanel {...props} />);
  fireEvent.click(screen.getByRole("button", { name: /Generation History/ }));
  return props;
}

describe("StudioHistoryPanel", () => {
  it("shows storage use against the store limits", () => {
    setup();
    expect(screen.getByTestId("history-usage").textContent).toBe(
      `2 of ${GENERATION_HISTORY_LIMITS.maxEntries} generations · 5.0 MB of 512 MB · 1 of ${GENERATION_HISTORY_LIMITS.maxFavoriteEntries} favorites`,
    );
    expect(screen.getByRole("progressbar", { name: "History storage used" })).toHaveAttribute("aria-valuenow", "1");
  });

  it("lists entries with engine, seed, duration and fires replay, reuse, download", () => {
    const props = setup();
    expect(screen.getByText(/Qwen3-TTS · af_heart · seed 42 · 1:05/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: 'Play "Title a"' }));
    fireEvent.click(screen.getByRole("button", { name: 'Reuse settings of "Title a"' }));
    fireEvent.click(screen.getByRole("button", { name: 'Download "Title a"' }));

    expect(props.onReplay).toHaveBeenCalledWith("a");
    expect(props.onReuse).toHaveBeenCalledWith("a");
    expect(props.onDownload).toHaveBeenCalledWith(props.entries[0]);
  });

  it("toggles favorites and reports a refused favorite", async () => {
    const props = setup({ onSetFavorite: vi.fn().mockRejectedValue(new Error("Favorites are full.")) });
    expect(screen.getByRole("button", { name: 'Remove "Title b" from favorites' })).toHaveAttribute("aria-pressed", "true");

    fireEvent.click(screen.getByRole("button", { name: 'Favorite "Title a"' }));
    expect(props.onSetFavorite).toHaveBeenCalledWith("a", true);
    expect(await screen.findByRole("alert")).toHaveTextContent("Favorites are full.");
  });

  it("deletes an entry", async () => {
    const props = setup();
    fireEvent.click(screen.getByRole("button", { name: 'Delete "Title a"' }));
    await waitFor(() => expect(props.onDelete).toHaveBeenCalledWith("a"));
  });

  it("clears everything but favorites only after confirming", async () => {
    const props = setup();
    fireEvent.click(screen.getByRole("button", { name: "Clear history" }));
    expect(props.onClear).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(props.onClear).toHaveBeenCalledWith({ keepFavorites: true }));

    fireEvent.click(screen.getByRole("button", { name: "Clear history" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(props.onClear).toHaveBeenCalledTimes(1);
  });

  it("disables clearing when only favorites remain and explains an empty history", () => {
    setup({ entries: [entry("b", { favorite: true })] });
    expect(screen.getByRole("button", { name: "Clear history" })).toBeDisabled();
  });

  it("shows an empty state and store errors", () => {
    setup({ entries: [], error: "Storage is blocked." });
    expect(screen.getByText(/Generations you finish in Studio are kept here/)).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("Storage is blocked.");
  });

  it("shows errors while the panel is collapsed, flags the toggle and lets the user dismiss them", () => {
    render(<StudioHistoryPanel {...baseProps()} error="Could not save to history: quota exceeded." />);
    expect(screen.getByRole("alert")).toHaveTextContent("quota exceeded");
    expect(screen.queryByTestId("history-usage")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Dismiss history error" }));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("returns focus to the panel header after a delete or a clear", async () => {
    setup();
    const toggle = screen.getByRole("button", { name: /Generation History/ });
    fireEvent.click(screen.getByRole("button", { name: 'Delete "Title a"' }));
    await waitFor(() => expect(toggle).toHaveFocus());
    toggle.blur();
    fireEvent.click(screen.getByRole("button", { name: "Clear history" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(toggle).toHaveFocus());
  });
});
