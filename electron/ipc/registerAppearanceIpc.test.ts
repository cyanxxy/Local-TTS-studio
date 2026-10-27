// @vitest-environment node

import { describe, expect, it, vi } from "vitest";

const nativeTheme = vi.hoisted(() => ({ themeSource: "system" as string }));
vi.mock("electron", () => ({ nativeTheme }));

import { registerAppearanceIpc } from "./registerAppearanceIpc";

type Listener = (event: unknown, request: unknown) => void;

function setup() {
  const listeners = new Map<string, Listener>();
  registerAppearanceIpc({
    handle: vi.fn(),
    on: (channel: string, listener: Listener) => listeners.set(channel, listener),
    onPort: vi.fn(),
  } as never);
  return (request: unknown) => listeners.get("app:set-theme-source")!({}, request);
}

describe("registerAppearanceIpc", () => {
  it("makes the native theme follow the app's theme choice", () => {
    const send = setup();
    send({ source: "dark" });
    expect(nativeTheme.themeSource).toBe("dark");
    send({ source: "system" });
    expect(nativeTheme.themeSource).toBe("system");
  });

  it("ignores anything but a known theme source", () => {
    const send = setup();
    nativeTheme.themeSource = "light";
    for (const request of [null, "dark", { source: "sepia" }, { source: 1 }]) send(request);
    expect(nativeTheme.themeSource).toBe("light");
  });
});
