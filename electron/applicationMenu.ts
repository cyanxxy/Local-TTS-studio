import { Menu } from "electron";

export function configureApplicationMenu(platform: NodeJS.Platform, isPackaged: boolean): void {
  if (!isPackaged) return;
  // macOS routes native editing shortcuts through the application menu, even
  // when the focused control is an HTML textarea.
  Menu.setApplicationMenu(platform === "darwin"
    ? Menu.buildFromTemplate([{ role: "appMenu" }, { role: "editMenu" }, { role: "windowMenu" }])
    : null);
}
