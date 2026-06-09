import { defineConfig } from "vitest/config";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { kokoroOnnxWasmAssetPlugin } from "./vite.kokoroAssets";

const ROOT_DIR = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [kokoroOnnxWasmAssetPlugin(ROOT_DIR) as never],
  test: {
    globals: true,
    environment: "jsdom",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx", "electron/**/*.test.ts", "vite.*.test.ts"],
    setupFiles: [resolve(ROOT_DIR, "src/test-setup.ts")],
    coverage: {
      provider: "istanbul",
      reporter: ["text", "json", "html"],
      // The 100% gate is scoped to deterministic unit contracts. Browser/Electron
      // bootstraps, Web Audio scheduling, workers, and page shells still have
      // focused tests, but jsdom/Istanbul branch accounting makes those a poor
      // denominator for an enforceable 100% threshold.
      include: [
        "electron/generateRateLimiter.ts",
        "src/constants.ts",
        "src/components/TextInput.tsx",
        "src/lib/audio.ts",
        "src/lib/audioOutput.ts",
        "src/lib/audioTimeline.ts",
        "src/lib/onnxWasmAssets.ts",
        "src/lib/textValidation.ts",
        "src/workers/export.worker.ts",
      ],
      exclude: [
        "src/**/*.test.{ts,tsx}",
        "electron/**/*.test.ts",
        "src/**/*.d.ts",
        "src/vite-env.d.ts",
        "src/test-setup.ts",
      ],
      thresholds: {
        branches: 100,
        functions: 100,
        lines: 100,
        statements: 100,
      },
    },
  },
});
