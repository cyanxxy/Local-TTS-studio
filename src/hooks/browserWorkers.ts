import type { BrowserEngineId } from "../models/registry";

/**
 * The module worker behind each browser engine. Keyed by the registry's
 * browser ids, so a browser engine added to the registry does not typecheck
 * until it has a worker here.
 *
 * Each factory spells out `new Worker(new URL(<literal>, import.meta.url))`:
 * that exact form is what Vite recognises to bundle the worker.
 */
export const BROWSER_WORKER_FACTORIES: { readonly [Id in BrowserEngineId]: () => Worker } = {
  kokoro: () => new Worker(new URL("../workers/kokoro.worker.ts", import.meta.url), { type: "module" }),
  supertonic: () => new Worker(new URL("../workers/supertonic.worker.ts", import.meta.url), { type: "module" }),
  kitten: () => new Worker(new URL("../workers/kitten.worker.ts", import.meta.url), { type: "module" }),
  paradee: () => new Worker(new URL("../workers/paradee.worker.ts", import.meta.url), { type: "module" }),
  chatterbox: () => new Worker(new URL("../workers/chatterbox.worker.ts", import.meta.url), { type: "module" }),
  piper: () => new Worker(new URL("../workers/piper.worker.ts", import.meta.url), { type: "module" }),
};
