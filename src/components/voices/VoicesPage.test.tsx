import { fireEvent, render, screen } from "@testing-library/react";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useVoiceLibrary } from "../../hooks/useVoiceLibrary";
import { createVoiceLibraryStore, type VoiceLibraryStore } from "../../lib/voiceLibrary/store";
import { VoicesPage, type VoicesPageProps } from "./VoicesPage";

describe("VoicesPage", () => {
  let store: VoiceLibraryStore;
  const apply = vi.fn(async () => ({ ok: true, message: "ok" }));

  function Harness(props: Partial<VoicesPageProps>) {
    const library = useVoiceLibrary(store);
    return (
      <VoicesPage
        library={library}
        runtimeVoices={{ kokoro: ["af_heart"] }}
        synthesize={async function* () { /* no audio */ }}
        apply={apply}
        designAvailable={false}
        designUnavailableReason="Install VoiceDesign."
        {...props}
      />
    );
  }

  beforeEach(() => {
    vi.stubGlobal("indexedDB", new IDBFactory());
    vi.stubGlobal("IDBKeyRange", IDBKeyRange);
    localStorage.clear();
    store = createVoiceLibraryStore();
  });
  afterEach(async () => {
    await store.destroy();
    vi.unstubAllGlobals();
  });

  it("shows the library first and switches to cloning and design without losing either", () => {
    render(<Harness />);
    expect(screen.getByRole("tab", { name: "Library" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("region", { name: "Voice library" })).toBeVisible();
    expect(screen.getByRole("region", { name: "Instant voice cloning", hidden: true })).not.toBeVisible();

    fireEvent.click(screen.getByRole("tab", { name: "Clone a voice" }));
    expect(screen.getByRole("region", { name: "Instant voice cloning" })).toBeVisible();
    expect(screen.getByRole("region", { name: "Voice library", hidden: true })).not.toBeVisible();

    fireEvent.click(screen.getByRole("tab", { name: "Design a voice" }));
    fireEvent.change(screen.getByLabelText("Voice description"), { target: { value: "Kept while away" } });
    expect(screen.getByText("Install VoiceDesign.")).toBeVisible();

    fireEvent.click(screen.getByRole("tab", { name: "Library" }));
    fireEvent.click(screen.getByRole("tab", { name: "Design a voice" }));
    expect(screen.getByLabelText("Voice description")).toHaveValue("Kept while away");
  });

  it("moves between tabs with the arrow keys", () => {
    render(<Harness />);
    const library = screen.getByRole("tab", { name: "Library" });
    fireEvent.keyDown(library, { key: "ArrowRight" });
    expect(screen.getByRole("tab", { name: "Clone a voice" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: "Clone a voice" })).toHaveFocus();
    fireEvent.keyDown(screen.getByRole("tab", { name: "Clone a voice" }), { key: "ArrowLeft" });
    fireEvent.keyDown(library, { key: "ArrowLeft" });
    expect(screen.getByRole("tab", { name: "Design a voice" })).toHaveAttribute("aria-selected", "true");
  });
});
