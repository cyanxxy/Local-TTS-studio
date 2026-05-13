import { defineConfig } from "vite";
import { resolve } from "path";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { kokoroOnnxWasmAssetPlugin } from "./vite.kokoroAssets";

const rootDir = __dirname;

export default defineConfig({
  plugins: [kokoroOnnxWasmAssetPlugin(rootDir), react(), tailwindcss()],
  server: {
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
    },
    warmup: {
      clientFiles: [
        "./src/main.tsx",
        "./src/App.tsx",
        "./src/hooks/useModelLoader.ts",
      ],
    },
  },
  worker: {
    format: "es",
    plugins: () => [kokoroOnnxWasmAssetPlugin(rootDir)],
  },
  resolve: {
    conditions: ["onnxruntime-web-use-extern-wasm"],
    alias: {
      // Use the browser build of kokoro-js which bundles espeak-ng WASM inline.
      // The default export (kokoro.js) is the 11KB Node version that imports
      // phonemizer separately — it fails to phonemize in the browser, producing
      // garbled non-English audio. The web build (2.1MB) bundles everything needed.
      "kokoro-js": resolve(__dirname, "node_modules/kokoro-js/dist/kokoro.web.js"),
    },
  },
  optimizeDeps: {
    esbuildOptions: {
      conditions: ["onnxruntime-web-use-extern-wasm"],
    },
    entries: [
      "src/main.tsx",
      "src/workers/kokoro.worker.ts",
      "src/workers/supertonic.worker.ts",
    ],
    include: [
      "kokoro-js",
      "@huggingface/transformers",
      "react",
      "react-dom/client",
      "lucide-react",
    ],
    exclude: ["onnxruntime-web"],
  },
  build: {
    target: "esnext",
  },
});
