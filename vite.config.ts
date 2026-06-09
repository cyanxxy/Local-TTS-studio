import { resolve } from "path";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { kokoroOnnxWasmAssetPlugin } from "./vite.kokoroAssets";

const rootDir = __dirname;

function rewriteDesktopShellRequest(req: { url?: string }) {
  const requestUrl = new URL(req.url ?? "/", "http://localhost");
  const pathname = requestUrl.pathname.toLowerCase().replace(/\/+$/, "") || "/";

  if (pathname === "/desktop" || pathname.startsWith("/desktop/")) {
    req.url = `/desktop.html${requestUrl.search}`;
  }
}

function desktopShellFallbackPlugin(): Plugin {
  return {
    name: "open-tts-desktop-shell-fallback",
    configureServer(server) {
      server.middlewares.use((req, _res, next) => {
        rewriteDesktopShellRequest(req);
        next();
      });
    },
    configurePreviewServer(server) {
      server.middlewares.use((req, _res, next) => {
        rewriteDesktopShellRequest(req);
        next();
      });
    },
  };
}

export default defineConfig({
  plugins: [kokoroOnnxWasmAssetPlugin(rootDir), desktopShellFallbackPlugin(), react(), tailwindcss()],
  server: {
    port: 5173,
    strictPort: true,
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
    },
    warmup: {
      clientFiles: [
        "./src/apps/web/main.tsx",
        "./src/apps/desktop/main.tsx",
        "./src/shared/SynthesisApp.tsx",
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
      "src/apps/web/main.tsx",
      "src/apps/desktop/main.tsx",
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
    chunkSizeWarningLimit: 2500,
    rollupOptions: {
      input: {
        web: resolve(__dirname, "index.html"),
        desktop: resolve(__dirname, "desktop.html"),
      },
    },
  },
});
