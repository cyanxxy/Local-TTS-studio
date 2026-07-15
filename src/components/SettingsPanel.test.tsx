import { describe, it, expect, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { SettingsPanel } from "./SettingsPanel";

/** Open the collapsible settings panel by clicking its header. */
function openPanel() {
  fireEvent.click(screen.getByText(/model storage/i));
}

describe("SettingsPanel", () => {
  it("renders cache action buttons when opened", () => {
    render(
      <SettingsPanel
        activeModel="supertonic"
        busy={false}
        status={null}
        onClearCache={() => {}}
        onRedownloadActive={() => {}}
      />,
    );

    openPanel();

    expect(screen.getByText("Clear Model Cache")).toBeInTheDocument();
    expect(screen.getByText("Re-download Supertonic")).toBeInTheDocument();
  });

  it("invokes handlers when clicking actions", () => {
    const onClearCache = vi.fn();
    const onRedownloadActive = vi.fn();

    render(
      <SettingsPanel
        activeModel="kokoro"
        busy={false}
        status={null}
        onClearCache={onClearCache}
        onRedownloadActive={onRedownloadActive}
      />,
    );

    openPanel();

    fireEvent.click(screen.getByText("Clear Model Cache"));
    fireEvent.click(screen.getByText("Re-download Kokoro"));

    expect(onClearCache).toHaveBeenCalledOnce();
    expect(onRedownloadActive).toHaveBeenCalledOnce();
  });

  it("disables actions while busy", () => {
    render(
      <SettingsPanel
        activeModel="kokoro"
        busy={true}
        status={{ type: "info", message: "Working..." }}
        onClearCache={() => {}}
        onRedownloadActive={() => {}}
      />,
    );

    openPanel();

    expect(screen.getByText("Clear Model Cache").closest("button")).toBeDisabled();
    expect(screen.getByText("Re-download Kokoro").closest("button")).toBeDisabled();
    expect(screen.getByText("Working...")).toBeInTheDocument();
  });
});
