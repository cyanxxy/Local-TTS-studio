import type { WebContents } from "electron";
import type { ShutdownParticipant } from "../appShutdown";
import {
  clearAudio8Cache,
  getAudio8ModelDir,
  pruneStaleAudio8Revisions,
  readAudio8CacheInfo,
} from "../audio8Cache";
import { AUDIO8_MAX_TEXT_CHARACTERS, isAudio8VoiceId } from "../audio8Model";
import { Audio8NativeClient } from "../audio8NativeClient";
import { LOCAL_RUNTIME_SHUTTING_DOWN_MESSAGE } from "../errors";
import { isRecord } from "../guards";
import type { TrustedIpc } from "./trusted";

export interface Audio8IpcOptions {
  /** The app's userData directory, which holds the Audio8 model cache. */
  userDataPath: () => string;
}

function sendAudio8Progress(
  sender: WebContents,
  requestId: string,
  percent: number,
): void {
  try {
    if (!sender.isDestroyed()) sender.send("audio8:progress", { requestId, percent });
  } catch {
    // The window can be destroyed between the check and send. Progress is
    // advisory; closing a renderer must never turn it into a main-process error.
  }
}

function audio8RequestId(request: unknown): string {
  if (!isRecord(request) || typeof request.requestId !== "string" || !/^[a-zA-Z0-9._-]{1,128}$/.test(request.requestId)) {
    throw new TypeError("Invalid Audio8 request id.");
  }
  return request.requestId;
}

/**
 * Registers the `audio8:*` channels, backed by a lazily started native ONNX
 * worker, and returns its part in the quit barrier.
 */
export function registerAudio8Ipc(
  ipc: TrustedIpc,
  { userDataPath }: Audio8IpcOptions,
): ShutdownParticipant {
  let audio8NativeClient: Audio8NativeClient | null = null;
  // Latched by the quit, like the local runtime's own flag: no new worker may
  // start once the barrier has taken its snapshot.
  let shuttingDown = false;
  // Clearing or pruning the Audio8 cache unlinks hundreds of megabytes, so the
  // quit has to hold for it the way it holds for the workers and bridge children;
  // otherwise the process exits mid-`rm` and leaves a torn directory behind.
  const activeAudio8CacheTasks = new Set<Promise<unknown>>();
  // A clear stops the worker and only then unlinks the tree. Synthesis requests
  // that land in between would start a fresh worker downloading into the very
  // directory the `rm` is about to remove, so they wait this out first.
  let audio8CacheClear: Promise<void> | null = null;

  function getAudio8NativeClient(): Audio8NativeClient {
    // Guarded at the spawn point rather than in each handler, the way the
    // bridge worker pool is: a request that arrives mid-quit would otherwise
    // start a thread that memory-maps ~572 MiB and races the `destroy()` the
    // shutdown barrier is already waiting on.
    if (shuttingDown) throw new Error(LOCAL_RUNTIME_SHUTTING_DOWN_MESSAGE);
    audio8NativeClient ??= new Audio8NativeClient(getAudio8ModelDir(userDataPath()));
    return audio8NativeClient;
  }

  function trackAudio8CacheTask<T>(task: Promise<T>): Promise<T> {
    activeAudio8CacheTasks.add(task);
    void task.finally(() => activeAudio8CacheTasks.delete(task)).catch(() => undefined);
    return task;
  }

  // The inference worker keeps the ONNX graphs memory-mapped out of the revision
  // directory, so it has to stop before the unlink — the same ordering
  // `local-tts:clear-cache` uses for the bridge's WebSocket workers.
  async function handleAudio8ClearCache(): Promise<{ path: string; cleared: boolean }> {
    const shutdown = audio8NativeClient?.destroy() ?? null;
    audio8NativeClient = null;
    await shutdown;
    return clearAudio8Cache(userDataPath());
  }

  ipc.handle("audio8:load", async (event, request) => {
    const requestId = audio8RequestId(request);
    await audio8CacheClear;
    const result = await getAudio8NativeClient().load(requestId, (percent) => {
      sendAudio8Progress(event.sender, requestId, percent);
    });
    // A completed load is the only point where the current revision is known to
    // be fully downloaded and open, so pruning here can never be what leaves the
    // user without a usable model, and it provably touches nothing the worker
    // has mapped. Not awaited: reclaiming disk must not delay first synthesis.
    if (!shuttingDown) {
      void trackAudio8CacheTask(pruneStaleAudio8Revisions(userDataPath()));
    }
    return result;
  });

  ipc.handle("audio8:generate", async (event, request) => {
    const requestId = audio8RequestId(request);
    if (!isRecord(request) || typeof request.text !== "string" || request.text.trim().length === 0 || [...request.text].length > AUDIO8_MAX_TEXT_CHARACTERS) {
      throw new TypeError("Invalid Audio8 synthesis text.");
    }
    // Rejected rather than substituted with the default voice: every other enum
    // on this boundary throws, and quietly rendering the whole request in a
    // voice the caller did not ask for is a wrong answer with nothing to show it.
    if (!isAudio8VoiceId(request.voice)) throw new TypeError("Unsupported Audio8 voice.");
    // Generation lazily fetches the voice profile into the model directory, so
    // it writes there too and has to clear the same gate as a load.
    await audio8CacheClear;
    return getAudio8NativeClient().generate(requestId, request.text, request.voice, (percent) => {
      sendAudio8Progress(event.sender, requestId, percent);
    });
  });

  ipc.handle("audio8:cancel", (_event, request) => {
    const requestId = audio8RequestId(request);
    // Forwarded rather than assumed: `false` covers every way there is nothing
    // to stop — no worker built yet, the request already settled, or it was
    // never issued. Reporting `true` regardless told the renderer it had
    // stopped work that did not exist.
    return { cancelled: audio8NativeClient?.cancel(requestId) ?? false };
  });

  // Audio8 is not a `LocalModel`, so `local-tts:cache-info`/`clear-cache` cannot
  // address it; these report and reclaim the whole `audio8` namespace — every
  // revision, not just the current one — in the same shape.
  ipc.handle("audio8:cache-info", () => {
    return readAudio8CacheInfo(userDataPath());
  });

  ipc.handle("audio8:clear-cache", () => {
    // Join the existing gate before starting another teardown. Two windows can
    // press Clear independently; running both `rm`s at once can reopen the gate
    // while the first clear still owns the old worker.
    const previous = audio8CacheClear;
    const clear = trackAudio8CacheTask((async () => {
      // Do not yield when this is the first clear: it must claim and retire the
      // resident worker before a same-turn quit can race in and take it over.
      if (previous) await previous;
      return handleAudio8ClearCache();
    })());
    // The gate only carries timing — a failed clear still has to stop leaving
    // synthesis blocked — so it settles either way. The renderer learns the
    // outcome from `clear` itself.
    const gate = clear.then(() => undefined, () => undefined);
    audio8CacheClear = gate;
    void gate.then(() => {
      if (audio8CacheClear === gate) audio8CacheClear = null;
    });
    return clear;
  });

  return {
    name: "audio8",
    beginShutdown() {
      shuttingDown = true;
      const destroyed = audio8NativeClient?.destroy() ?? null;
      audio8NativeClient = null;
      // Snapshot rather than drain: the latch above already stops new prunes
      // being scheduled, and a clear-cache invoked from a renderer that is about
      // to close still has to finish its `rm`.
      const cacheTasks = [...activeAudio8CacheTasks];
      if (!destroyed && cacheTasks.length === 0) return null;
      return Promise.all([
        destroyed,
        Promise.allSettled(cacheTasks),
      ]);
    },
  };
}
