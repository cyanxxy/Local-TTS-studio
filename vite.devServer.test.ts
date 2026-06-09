// @vitest-environment node

import { describe, expect, it } from "vitest";
import type { UserConfig } from "vite";
import viteConfig from "./vite.config";

describe("vite dev server config", () => {
  it("keeps the dev server on the Electron dev port", () => {
    const config = viteConfig as UserConfig;

    expect(config.server?.port).toBe(5173);
    expect(config.server?.strictPort).toBe(true);
    expect(config.server?.watch).toBeUndefined();
  });
});
