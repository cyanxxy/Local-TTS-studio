import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CHATTERBOX_TAG_TOKENS } from "../lib/chatterboxTags";
import { chatterboxEngine } from "../models/chatterbox";
import type { ModelState } from "../types";
import { ChatterboxInlineSettings } from "./ChatterboxInlineSettings";

const COLD: ModelState = { ready: false, loading: false, downloadProgress: 0, error: null, backend: null };
const READY: ModelState = { ready: true, loading: false, downloadProgress: 100, error: null, backend: "webgpu" };

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ChatterboxInlineSettings", () => {
  it("states the first-use download and that generation is slower than playback", () => {
    render(<ChatterboxInlineSettings settings={chatterboxEngine.defaultSettings} onChange={vi.fn()} modelState={COLD} />);

    expect(screen.getByText(/First use downloads about 0\.\d GB and needs WebGPU/)).toBeInTheDocument();
    expect(screen.getByText(/slower than real time/)).toBeInTheDocument();
  });

  it("tells a loaded model's user that audio arrives passage by passage", () => {
    render(<ChatterboxInlineSettings settings={chatterboxEngine.defaultSettings} onChange={vi.fn()} modelState={READY} />);

    expect(screen.queryByText(/First use downloads/)).not.toBeInTheDocument();
    expect(screen.getByText(/playback may pause between passages/)).toBeInTheDocument();
  });

  it("changes the temperature and the seed, and clears the seed", () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <ChatterboxInlineSettings settings={chatterboxEngine.defaultSettings} onChange={onChange} modelState={READY} />,
    );
    expect(screen.getByLabelText("Seed")).toHaveValue(null);
    expect(screen.queryByRole("button", { name: "Use a random seed" })).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText(/Variation/), { target: { value: "1.5" } });
    expect(onChange).toHaveBeenLastCalledWith({ temperature: 1.5 });
    fireEvent.change(screen.getByLabelText("Seed"), { target: { value: "42" } });
    expect(onChange).toHaveBeenLastCalledWith({ seed: 42 });
    // Out-of-range input is rejected rather than wiping the seed.
    fireEvent.change(screen.getByLabelText("Seed"), { target: { value: "-5" } });
    expect(onChange).toHaveBeenLastCalledWith({ seed: 42 });

    rerender(<ChatterboxInlineSettings settings={{ ...chatterboxEngine.defaultSettings, seed: 42 }} onChange={onChange} modelState={READY} />);
    expect(screen.getByLabelText("Seed")).toHaveValue(42);
    fireEvent.click(screen.getByRole("button", { name: "Use a random seed" }));
    expect(onChange).toHaveBeenLastCalledWith({ seed: null });
  });

  it("lists every supported tag and copies the one chosen", async () => {
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    render(<ChatterboxInlineSettings settings={chatterboxEngine.defaultSettings} onChange={vi.fn()} modelState={READY} />);

    const tags = screen.getByRole("list", { name: "Supported tags" });
    expect(tags.querySelectorAll("li")).toHaveLength(CHATTERBOX_TAG_TOKENS.length);

    fireEvent.click(screen.getByRole("button", { name: "Copy [laugh]" }));

    expect(writeText).toHaveBeenCalledWith("[laugh]");
    await vi.waitFor(() => expect(screen.getByRole("button", { name: "Copy [laugh]" }).querySelector(".lucide-check")).not.toBeNull());
  });

  it("adds a tag to the script when the host can, with a space after a word", () => {
    const onInsertTag = vi.fn();
    render(
      <ChatterboxInlineSettings
        settings={chatterboxEngine.defaultSettings}
        onChange={vi.fn()}
        modelState={READY}
        onInsertTag={onInsertTag}
      />,
    );

    expect(screen.getByText(/add it to the end of the script/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Add [laugh]" }));

    expect(onInsertTag).toHaveBeenCalledWith("[laugh]");
    expect(screen.queryByRole("button", { name: "Copy [laugh]" })).not.toBeInTheDocument();
  });

  it("copes with a clipboard that refuses or is missing", async () => {
    vi.stubGlobal("navigator", { clipboard: { writeText: vi.fn(async () => { throw new Error("denied"); }) } });
    const { unmount } = render(<ChatterboxInlineSettings settings={chatterboxEngine.defaultSettings} onChange={vi.fn()} modelState={READY} />);
    fireEvent.click(screen.getByRole("button", { name: "Copy [sigh]" }));
    await vi.waitFor(() => expect(screen.getByRole("button", { name: "Copy [sigh]" }).querySelector(".lucide-check")).toBeNull());
    unmount();

    vi.stubGlobal("navigator", {});
    render(<ChatterboxInlineSettings settings={chatterboxEngine.defaultSettings} onChange={vi.fn()} modelState={READY} />);
    expect(() => fireEvent.click(screen.getByRole("button", { name: "Copy [sigh]" }))).not.toThrow();
  });
});
