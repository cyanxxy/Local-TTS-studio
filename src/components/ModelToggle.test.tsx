import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { ModelToggle } from "./ModelToggle";
import type { ModelState } from "../types";

const readyState: ModelState = {
  ready: true,
  loading: false,
  downloadProgress: 100,
  error: null,
  backend: "webgpu",
};
const loadingState: ModelState = {
  ready: false,
  loading: true,
  downloadProgress: 50,
  error: null,
  backend: null,
};
const errorState: ModelState = {
  ready: false,
  loading: false,
  downloadProgress: 0,
  error: "Failed",
  backend: null,
};

function openPicker() {
  fireEvent.click(screen.getByTestId("model-picker-trigger"));
  return screen.getByRole("menu", { name: "Select model" });
}

describe("ModelToggle", () => {
  it("keeps the model catalogue collapsed until the picker is opened", () => {
    render(
      <ModelToggle
        activeModel="kokoro"
        onModelChange={() => {}}
        kokoroState={readyState}
        supertonicState={readyState}
      />,
    );

    expect(screen.getByTestId("model-picker-trigger")).toHaveTextContent("Kokoro");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    const menu = openPicker();
    expect(within(menu).getByText("Kokoro")).toBeInTheDocument();
    expect(within(menu).getByText("Supertonic")).toBeInTheDocument();
  });

  it("omits legacy Supertonic when Electron exposes only Kokoro", () => {
    render(
      <ModelToggle
        activeModel="kokoro"
        onModelChange={() => {}}
        kokoroState={readyState}
        supertonicState={readyState}
        visibleModels={["kokoro"]}
      />,
    );

    const menu = openPicker();
    expect(within(menu).getByText("Kokoro")).toBeInTheDocument();
    expect(within(menu).queryByText("Supertonic")).not.toBeInTheDocument();
  });

  it("selects a browser model and closes the menu", () => {
    const onModelChange = vi.fn();
    render(
      <ModelToggle
        activeModel="kokoro"
        onModelChange={onModelChange}
        kokoroState={readyState}
        supertonicState={readyState}
      />,
    );

    const supertonic = within(openPicker()).getByRole("menuitemradio", { name: /Supertonic/i });
    fireEvent.pointerDown(supertonic);
    fireEvent.click(supertonic);
    expect(onModelChange).toHaveBeenCalledWith("supertonic");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it.each([
    ["ready", readyState],
    ["loading", loadingState],
    ["error", errorState],
  ])("shows the %s state for a browser model", (status, state) => {
    render(
      <ModelToggle
        activeModel="kokoro"
        onModelChange={() => {}}
        kokoroState={state}
        supertonicState={readyState}
      />,
    );

    const option = screen.getByTestId("model-picker-trigger");
    expect(option.querySelector(`[data-status='${status}']`)).toBeInTheDocument();
  });

  it("disables unavailable models and explains why", () => {
    render(
      <ModelToggle
        activeModel="supertonic"
        onModelChange={() => {}}
        kokoroState={loadingState}
        supertonicState={readyState}
        unavailableModels={{ kokoro: "Disabled on iOS" }}
      />,
    );

    const menu = openPicker();
    const kokoroButton = within(menu).getByRole("menuitemradio", { name: /Kokoro/i });
    expect(kokoroButton).toBeDisabled();
    expect(kokoroButton).toHaveAttribute("title", "Disabled on iOS");
    expect(within(menu).getByText("Unavailable")).toBeInTheDocument();
  });

  it("shows desktop models inside the same compact picker", () => {
    render(
      <ModelToggle
        activeModel="kokoro"
        onModelChange={() => {}}
        kokoroState={readyState}
        supertonicState={readyState}
        desktopModelOptions={[{
          key: "qwen3",
          label: "Qwen3-TTS",
          badge: "Electron",
          detail: "0.6B CustomVoice MLX / local runtime",
          onSelect: () => {},
        }]}
      />,
    );

    const menu = openPicker();
    expect(within(menu).getByText("Kokoro")).toBeInTheDocument();
    expect(within(menu).getByText("Supertonic")).toBeInTheDocument();
    expect(within(menu).getByText("Qwen3-TTS")).toBeInTheDocument();
    expect(within(menu).getByText("Electron")).toBeInTheDocument();
    expect(within(menu).getByText("0.6B CustomVoice MLX / local runtime")).toBeInTheDocument();
  });

  it("calls the desktop model callback without changing the browser model", () => {
    const onModelChange = vi.fn();
    const onSelectQwen3 = vi.fn();
    render(
      <ModelToggle
        activeModel="kokoro"
        onModelChange={onModelChange}
        kokoroState={readyState}
        supertonicState={readyState}
        desktopModelOptions={[{
          key: "qwen3",
          label: "Qwen3-TTS",
          badge: "Electron",
          detail: "0.6B CustomVoice MLX / local runtime",
          onSelect: onSelectQwen3,
        }]}
      />,
    );

    fireEvent.click(within(openPicker()).getByRole("menuitemradio", { name: /Qwen3-TTS/i }));
    expect(onSelectQwen3).toHaveBeenCalledTimes(1);
    expect(onModelChange).not.toHaveBeenCalled();
  });

  it("shows the selected desktop model in the closed picker", () => {
    render(
      <ModelToggle
        activeModel="kokoro"
        onModelChange={() => {}}
        kokoroState={readyState}
        supertonicState={readyState}
        desktopModelOptions={[{
          key: "qwen3",
          label: "Qwen3-TTS",
          badge: "Electron",
          detail: "0.6B CustomVoice MLX / local runtime",
          selected: true,
          onSelect: () => {},
        }]}
      />,
    );

    const trigger = screen.getByTestId("model-picker-trigger");
    expect(trigger).toHaveTextContent("Qwen3-TTS");
    expect(trigger).toHaveTextContent("0.6B CustomVoice MLX / local runtime");
    const menu = openPicker();
    expect(within(menu).getByRole("menuitemradio", { name: /Qwen3-TTS/i })).toHaveAttribute("aria-checked", "true");
    expect(within(menu).getByRole("menuitemradio", { name: /Kokoro/i })).toHaveAttribute("aria-checked", "false");
  });

  it("supports arrow navigation and Escape", () => {
    render(
      <ModelToggle
        activeModel="kokoro"
        onModelChange={() => {}}
        kokoroState={readyState}
        supertonicState={readyState}
      />,
    );

    const trigger = screen.getByTestId("model-picker-trigger");
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    const menu = screen.getByRole("menu");
    const kokoro = within(menu).getByRole("menuitemradio", { name: /Kokoro/i });
    const supertonic = within(menu).getByRole("menuitemradio", { name: /Supertonic/i });
    kokoro.focus();
    fireEvent.keyDown(kokoro, { key: "ArrowDown" });
    expect(supertonic).toHaveFocus();
    fireEvent.keyDown(supertonic, { key: "Escape" });
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it("skips unavailable models during keyboard navigation", () => {
    render(
      <ModelToggle
        activeModel="kokoro"
        onModelChange={() => {}}
        kokoroState={readyState}
        supertonicState={readyState}
        unavailableModels={{ supertonic: "Unavailable in this environment" }}
        desktopModelOptions={[{
          key: "qwen3",
          label: "Qwen3-TTS",
          onSelect: () => {},
        }]}
      />,
    );

    const menu = openPicker();
    const kokoro = within(menu).getByRole("menuitemradio", { name: /Kokoro/i });
    const qwen = within(menu).getByRole("menuitemradio", { name: /Qwen3-TTS/i });
    kokoro.focus();
    fireEvent.keyDown(kokoro, { key: "ArrowDown" });
    expect(qwen).toHaveFocus();
    fireEvent.keyDown(qwen, { key: "ArrowDown" });
    expect(kokoro).toHaveFocus();
  });

  it("focuses the first available model when the selected model is unavailable", () => {
    render(
      <ModelToggle
        activeModel="kokoro"
        onModelChange={() => {}}
        kokoroState={readyState}
        supertonicState={readyState}
        unavailableModels={{ kokoro: "Unavailable in this environment" }}
      />,
    );

    const trigger = screen.getByTestId("model-picker-trigger");
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    expect(screen.getByRole("menuitemradio", { name: /Supertonic/i })).toHaveFocus();
  });

  it("closes with Escape while focus remains on the trigger", () => {
    render(
      <ModelToggle
        activeModel="kokoro"
        onModelChange={() => {}}
        kokoroState={readyState}
        supertonicState={readyState}
      />,
    );

    const trigger = screen.getByTestId("model-picker-trigger");
    fireEvent.click(trigger);
    expect(screen.getByRole("menu")).toBeInTheDocument();
    fireEvent.keyDown(trigger, { key: "Escape" });
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("keeps picker Escape from closing a parent dialog", () => {
    const parentKeyDown = vi.fn();
    render(
      <div onKeyDown={parentKeyDown}>
        <ModelToggle
          activeModel="kokoro"
          onModelChange={() => {}}
          kokoroState={readyState}
          supertonicState={readyState}
        />
      </div>,
    );

    const trigger = screen.getByTestId("model-picker-trigger");
    fireEvent.click(trigger);
    fireEvent.keyDown(trigger, { key: "Escape" });
    expect(parentKeyDown).not.toHaveBeenCalled();
  });

  it("closes on Tab and moves focus past the picker", async () => {
    render(
      <div>
        <button type="button">Before picker</button>
        <ModelToggle
          activeModel="kokoro"
          onModelChange={() => {}}
          kokoroState={readyState}
          supertonicState={readyState}
        />
        <button type="button">After picker</button>
      </div>,
    );

    const trigger = screen.getByTestId("model-picker-trigger");
    trigger.focus();
    fireEvent.click(trigger);
    fireEvent.keyDown(trigger, { key: "Tab" });
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("button", { name: "After picker" })).toHaveFocus());
  });

  it("portals the menu outside clipping containers", () => {
    render(
      <div className="overflow-y-auto">
        <ModelToggle
          activeModel="kokoro"
          onModelChange={() => {}}
          kokoroState={readyState}
          supertonicState={readyState}
        />
      </div>,
    );

    const menu = openPicker();
    expect(menu.parentElement).toBe(document.body);
    expect(menu).toHaveAttribute("data-model-picker-menu");
  });

  it("constrains and flips the menu within a short viewport", () => {
    const originalInnerHeight = window.innerHeight;
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 420 });
    const rectSpy = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      if (this.dataset.testid === "model-picker-trigger") {
        return {
          x: 10,
          y: 180,
          top: 180,
          right: 310,
          bottom: 256,
          left: 10,
          width: 300,
          height: 76,
          toJSON: () => ({}),
        };
      }
      return {
        x: 0,
        y: 0,
        top: 0,
        right: 0,
        bottom: 0,
        left: 0,
        width: 0,
        height: 0,
        toJSON: () => ({}),
      };
    });
    const scrollHeightSpy = vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(320);

    try {
      render(
        <ModelToggle
          activeModel="kokoro"
          onModelChange={() => {}}
          kokoroState={readyState}
          supertonicState={readyState}
        />,
      );

      const menu = openPicker();
      expect(menu).toHaveStyle({ left: "10px", top: "8px", width: "300px", maxHeight: "164px" });
    } finally {
      rectSpy.mockRestore();
      scrollHeightSpy.mockRestore();
      Object.defineProperty(window, "innerHeight", { configurable: true, value: originalInnerHeight });
    }
  });
});
