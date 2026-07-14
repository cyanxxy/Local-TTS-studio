import { StrictMode, type PropsWithChildren } from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearReaderLibraryForTests, listReaderDocuments } from "../lib/readerLibrary";
import { useReaderLibrary } from "./useReaderLibrary";

function StrictModeWrapper({ children }: PropsWithChildren) {
  return <StrictMode>{children}</StrictMode>;
}

describe("useReaderLibrary", () => {
  beforeEach(async () => {
    vi.stubGlobal("indexedDB", new IDBFactory());
    vi.stubGlobal("IDBKeyRange", IDBKeyRange);
    await clearReaderLibraryForTests();
  });

  it("creates only one seed document across the Strict Mode effect replay", async () => {
    const { result } = renderHook(
      () => useReaderLibrary("A single local seed document."),
      { wrapper: StrictModeWrapper },
    );

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.documents).toHaveLength(1);
    await waitFor(async () => expect(await listReaderDocuments()).toHaveLength(1));
  });

  it("does not let a delayed progress write overwrite a newer text save", async () => {
    const { result } = renderHook(() => useReaderLibrary("Original reader text."));
    await waitFor(() => expect(result.current.loading).toBe(false));
    const id = result.current.activeDocument?.id;

    vi.useFakeTimers();
    act(() => {
      result.current.updateProgress({ positionSec: 2, totalDurationSec: 10, textOffset: 4 });
      result.current.updateActiveText("Newest reader text survives the progress flush.");
      vi.advanceTimersByTime(600);
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    vi.useRealTimers();

    await waitFor(async () => {
      const stored = (await listReaderDocuments()).find((document) => document.id === id);
      expect(stored?.text).toBe("Newest reader text survives the progress flush.");
    });
  });
});
