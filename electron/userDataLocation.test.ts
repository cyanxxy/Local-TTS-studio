// @vitest-environment node

import { describe, expect, it } from "vitest";
import { windowsLocalUserDataPath } from "./userDataLocation";

const ROAMING = "C:\\Users\\Ada\\AppData\\Roaming\\Open TTS";
const LOCAL = "C:\\Users\\Ada\\AppData\\Local\\Open TTS";
const env = { LOCALAPPDATA: "C:\\Users\\Ada\\AppData\\Local" };

describe("windowsLocalUserDataPath", () => {
  it("puts a new Windows install under %LOCALAPPDATA%", () => {
    expect(windowsLocalUserDataPath(ROAMING, env, () => false, "win32")).toBe(LOCAL);
  });

  it("keeps an existing roaming install where it is", () => {
    expect(windowsLocalUserDataPath(ROAMING, env, (directory) => directory === ROAMING, "win32")).toBeNull();
  });

  it("stays local once it has started there, even if a roaming folder appeared later", () => {
    expect(windowsLocalUserDataPath(ROAMING, env, () => true, "win32")).toBe(LOCAL);
  });

  it("leaves other platforms and a missing %LOCALAPPDATA% alone", () => {
    expect(windowsLocalUserDataPath("/Users/ada/Library/Application Support/Open TTS", env, () => false, "darwin")).toBeNull();
    expect(windowsLocalUserDataPath(ROAMING, {}, () => false, "win32")).toBeNull();
  });
});
