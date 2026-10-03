import { beforeEach, describe, expect, it, vi } from "vitest";
import { Menu } from "electron";
import { configureApplicationMenu } from "./applicationMenu";

vi.mock("electron", () => ({
  Menu: { buildFromTemplate: vi.fn(() => ({ nativeMenu: true })), setApplicationMenu: vi.fn() },
}));

beforeEach(() => vi.clearAllMocks());

describe("packaged application menu", () => {
  it("keeps native Mac editing, app, and window commands", () => {
    configureApplicationMenu("darwin", true);
    expect(Menu.buildFromTemplate).toHaveBeenCalledWith([
      { role: "appMenu" }, { role: "editMenu" }, { role: "windowMenu" },
    ]);
    expect(Menu.setApplicationMenu).toHaveBeenCalledWith({ nativeMenu: true });
  });

  it.each(["win32", "linux"] as const)("hides the packaged %s menu", (platform) => {
    configureApplicationMenu(platform, true);
    expect(Menu.setApplicationMenu).toHaveBeenCalledWith(null);
    expect(Menu.buildFromTemplate).not.toHaveBeenCalled();
  });

  it("preserves the development menu", () => {
    configureApplicationMenu("darwin", false);
    expect(Menu.setApplicationMenu).not.toHaveBeenCalled();
  });
});
