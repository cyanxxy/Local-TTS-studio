import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppHeader } from "./AppHeader";
import type { AppPage } from "../lib/appRouting";

const TABS = [
  { key: "studio", label: "Studio" },
  { key: "reader", label: "Reader" },
] as const;

function renderHeader(overrides: Partial<Parameters<typeof AppHeader>[0]> = {}) {
  const props = {
    immersive: false,
    compact: false,
    subtitle: "Text to speech, entirely on your device.",
    cpuMode: null,
    onOpenSettings: vi.fn(),
    tabs: TABS,
    activePage: "studio" as AppPage,
    routeBasePath: "/desktop",
    onNavigate: vi.fn(),
    ...overrides,
  };
  return { props, ...render(<AppHeader {...props} />) };
}

describe("AppHeader", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("links each tab to its route and navigates in place", () => {
    const { props } = renderHeader();

    const reader = screen.getByRole("link", { name: "Reader" });
    expect(reader).toHaveAttribute("href", "/desktop/reader");
    expect(screen.getByRole("link", { name: "Studio" })).toHaveAttribute("aria-current", "page");
    expect(reader).not.toHaveAttribute("aria-current");

    const click = new MouseEvent("click", { bubbles: true, cancelable: true });
    fireEvent(reader, click);
    expect(click.defaultPrevented).toBe(true);
    expect(props.onNavigate).toHaveBeenCalledWith("reader");
  });

  it("measures the active tab for the travelling pill and animates only after the first measurement", () => {
    vi.spyOn(HTMLElement.prototype, "offsetLeft", "get").mockImplementation(function (this: HTMLElement) {
      return this.dataset.pageTab === "reader" ? 90 : 4;
    });
    vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(function (this: HTMLElement) {
      return this.dataset.pageTab === "reader" ? 70 : 80;
    });
    const { props, rerender, container } = renderHeader();
    const pill = container.querySelector("nav > span") as HTMLElement;

    expect(pill.style.transform).toBe("translateX(4px)");
    expect(pill.style.width).toBe("80px");
    expect(pill.className).toContain("opacity-100");
    expect(pill.className).not.toContain("transition-");

    rerender(<AppHeader {...props} activePage="reader" />);
    expect(pill.style.transform).toBe("translateX(90px)");
    expect(pill.style.width).toBe("70px");
    expect(pill.className).toContain("transition-");
  });

  it("shows the subtitle outside the compact layout only", () => {
    const { props, rerender } = renderHeader();
    expect(screen.getByText(props.subtitle)).toBeInTheDocument();

    rerender(<AppHeader {...props} compact />);
    expect(screen.queryByText(props.subtitle)).not.toBeInTheDocument();
  });

  it("explains CPU mode when the app falls back from WebGPU", () => {
    const { props, rerender } = renderHeader();
    expect(screen.queryByText("CPU mode")).not.toBeInTheDocument();

    rerender(<AppHeader {...props} cpuMode={{ note: "No GPU available", singleThreaded: true }} />);
    expect(screen.getByText("CPU mode")).toBeInTheDocument();
    expect(screen.getByText("No GPU available")).toBeInTheDocument();
    expect(screen.getByText(/runs single-threaded/)).toBeInTheDocument();

    rerender(<AppHeader {...props} cpuMode={{ note: null, singleThreaded: false }} />);
    expect(screen.getByText("CPU mode")).toBeInTheDocument();
    expect(screen.queryByText(/single-threaded/)).not.toBeInTheDocument();
  });

  it("opens settings and names the platform shortcut", () => {
    Object.defineProperty(window, "electron", { value: { platform: "darwin" }, configurable: true });
    const { props, rerender } = renderHeader();
    const button = screen.getByRole("button", { name: "Open app settings" });
    expect(button).toHaveAttribute("title", "Settings (⌘,)");
    fireEvent.click(button);
    expect(props.onOpenSettings).toHaveBeenCalledOnce();

    Object.defineProperty(window, "electron", { value: { platform: "win32" }, configurable: true });
    rerender(<AppHeader {...props} subtitle="Again" />);
    expect(screen.getByRole("button", { name: "Open app settings" })).toHaveAttribute("title", "Settings (Ctrl+,)");
    Object.defineProperty(window, "electron", { value: undefined, configurable: true });
  });

  it("keeps an empty draggable strip in the immersive layout", () => {
    const { container } = renderHeader({ immersive: true });

    expect(screen.queryByText("Open TTS")).not.toBeInTheDocument();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    expect(container.querySelector("header")).toHaveAttribute("aria-hidden");
  });
});
