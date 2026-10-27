// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import {
  assertTrustedIpcSender,
  createTrustedIpc,
  ipcSenderUrl,
  UNTRUSTED_SENDER_MESSAGE,
  type TrustedIpcOptions,
} from "./trusted";

type Handler = (event: unknown, request: unknown) => unknown;

/** `url` is the web contents' current URL; the sending frame's defaults to it. */
function makeEvent(url: string, frameUrl: string | null = url, ports: unknown[] = []) {
  return {
    senderFrame: frameUrl === null ? null : { url: frameUrl },
    sender: { getURL: () => url },
    ports,
  };
}

function createPort() {
  return { close: vi.fn(), postMessage: vi.fn() };
}

function setup(options: Partial<TrustedIpcOptions> = {}) {
  const handlers = new Map<string, Handler>();
  const listeners = new Map<string, Handler>();
  const ipcMain = {
    handle: vi.fn((channel: string, handler: Handler) => handlers.set(channel, handler)),
    on: vi.fn((channel: string, listener: Handler) => listeners.set(channel, listener)),
  };
  const onUntrustedSender = vi.fn();
  const onListenerError = vi.fn();
  const onHandlerError = vi.fn();
  const ipc = createTrustedIpc(ipcMain as never, {
    allowDevServer: false,
    onUntrustedSender,
    onListenerError,
    onHandlerError,
    ...options,
  });
  return { ipc, handlers, listeners, onUntrustedSender, onListenerError, onHandlerError };
}

function throwingReporter() {
  return vi.fn(() => {
    throw new Error("the reporter is broken");
  });
}

describe("assertTrustedIpcSender", () => {
  it("accepts trusted app senders and rejects untrusted IPC senders", () => {
    expect(() => assertTrustedIpcSender(makeEvent("https://evil.test", "app://-/studio"))).not.toThrow();
    expect(() => assertTrustedIpcSender(makeEvent("http://localhost:5173/qwen3"))).not.toThrow();
    expect(() => assertTrustedIpcSender(
      makeEvent("http://localhost:5173/qwen3"),
      { allowDevServer: false },
    )).toThrow(UNTRUSTED_SENDER_MESSAGE);
    expect(() => assertTrustedIpcSender(makeEvent("https://example.com"))).toThrow(UNTRUSTED_SENDER_MESSAGE);
  });

  it("trusts the sending frame only, and no one once that frame is gone", () => {
    expect(ipcSenderUrl(makeEvent("https://evil.test", "app://-/studio"))).toBe("app://-/studio");
    // The web contents now shows an app page, but the frame that sent this
    // message navigated away or was destroyed: it may not have been the app's.
    expect(ipcSenderUrl(makeEvent("app://-/reader", null))).toBeNull();
    expect(() => assertTrustedIpcSender(makeEvent("app://-/reader", null))).toThrow(UNTRUSTED_SENDER_MESSAGE);
    expect(() => assertTrustedIpcSender(makeEvent("app://-/reader", "https://evil.test/"))).toThrow(UNTRUSTED_SENDER_MESSAGE);
  });
});

describe("createTrustedIpc", () => {
  describe("handle", () => {
    it("runs the handler for a trusted sender and passes its result through synchronously", () => {
      const { ipc, handlers } = setup();
      ipc.handle("audio8:cancel", (_event, request) => ({ cancelled: false, request }));

      expect(handlers.get("audio8:cancel")!(makeEvent("app://-/studio"), "payload"))
        .toEqual({ cancelled: false, request: "payload" });
    });

    it("rejects an untrusted sender before the handler runs and reports only its origin", () => {
      const { ipc, handlers, onUntrustedSender } = setup();
      const handler = vi.fn();
      ipc.handle("local-tts:generate", handler);

      expect(() => handlers.get("local-tts:generate")!(makeEvent("https://evil.test/path?secret=1"), {}))
        .toThrow(UNTRUSTED_SENDER_MESSAGE);
      expect(handler).not.toHaveBeenCalled();
      expect(onUntrustedSender).toHaveBeenCalledWith("local-tts:generate", "https://evil.test");
    });

    it("admits the dev server only when configured to", () => {
      const devServer = makeEvent("http://localhost:5173/desktop/studio");
      const packaged = setup({ allowDevServer: false });
      const development = setup({ allowDevServer: true });
      packaged.ipc.handle("document:import", () => "imported");
      development.ipc.handle("document:import", () => "imported");

      expect(() => packaged.handlers.get("document:import")!(devServer, undefined)).toThrow(UNTRUSTED_SENDER_MESSAGE);
      expect(development.handlers.get("document:import")!(devServer, undefined)).toBe("imported");
    });

    it("propagates handler failures to the invoking renderer and reports them", () => {
      const { ipc, handlers, onListenerError, onHandlerError } = setup();
      const failure = new TypeError("Invalid cancel request payload.");
      ipc.handle("local-tts:cancel", () => {
        throw failure;
      });

      expect(() => handlers.get("local-tts:cancel")!(makeEvent("app://-/studio"), null))
        .toThrow(failure);
      expect(onHandlerError).toHaveBeenCalledWith("local-tts:cancel", failure);
      expect(onListenerError).not.toHaveBeenCalled();
    });

    it("reports an async handler failure and still rejects with the same error", async () => {
      const { ipc, handlers, onHandlerError } = setup();
      const failure = new Error("Rust local bridge exited.");
      ipc.handle("local-tts:generate", () => Promise.reject(failure));

      await expect(handlers.get("local-tts:generate")!(makeEvent("app://-/studio"), {})).rejects.toBe(failure);
      expect(onHandlerError).toHaveBeenCalledWith("local-tts:generate", failure);
    });

    it("passes a resolved result through without reporting anything", async () => {
      const { ipc, handlers, onHandlerError } = setup();
      ipc.handle("local-tts:probe", () => Promise.resolve({ ready: true }));

      await expect(handlers.get("local-tts:probe")!(makeEvent("app://-/studio"), {})).resolves.toEqual({ ready: true });
      expect(onHandlerError).not.toHaveBeenCalled();
    });

    it("leaves a handler's promise untouched when nobody observes failures", () => {
      const { ipc, handlers } = setup({ onHandlerError: undefined });
      const result = Promise.resolve("same promise");
      ipc.handle("local-tts:probe", () => result);

      expect(handlers.get("local-tts:probe")!(makeEvent("app://-/studio"), {})).toBe(result);
    });

    it("keeps the renderer's failure when the reporter itself throws", async () => {
      const { ipc, handlers } = setup({ onHandlerError: throwingReporter() });
      ipc.handle("audio8:load", () => {
        throw new Error("sync failure");
      });
      ipc.handle("audio8:generate", () => Promise.reject(new Error("async failure")));

      expect(() => handlers.get("audio8:load")!(makeEvent("app://-/studio"), {})).toThrow("sync failure");
      await expect(handlers.get("audio8:generate")!(makeEvent("app://-/studio"), {})).rejects.toThrow("async failure");
    });

    it("still refuses an untrusted sender when its reporter throws", () => {
      const { ipc, handlers } = setup({ onUntrustedSender: throwingReporter() });
      const handler = vi.fn();
      ipc.handle("local-tts:generate", handler);

      expect(() => handlers.get("local-tts:generate")!(makeEvent("https://evil.test"), {}))
        .toThrow(UNTRUSTED_SENDER_MESSAGE);
      expect(handler).not.toHaveBeenCalled();
    });

    it("reports an unparseable sender URL as an unknown origin", () => {
      const { ipc, handlers, onUntrustedSender } = setup();
      ipc.handle("audio8:load", () => undefined);

      expect(() => handlers.get("audio8:load")!(makeEvent("not a url"), {})).toThrow(UNTRUSTED_SENDER_MESSAGE);
      expect(onUntrustedSender).toHaveBeenCalledWith("audio8:load", "unknown");
    });
  });

  describe("on", () => {
    it("delivers trusted messages and drops untrusted ones without a reply", () => {
      const { ipc, listeners, onUntrustedSender } = setup();
      const listener = vi.fn();
      ipc.on("reader-library:flush-complete", listener);

      listeners.get("reader-library:flush-complete")!(makeEvent("https://evil.test"), { token: "t" });
      expect(listener).not.toHaveBeenCalled();
      expect(onUntrustedSender).toHaveBeenCalledWith("reader-library:flush-complete", "https://evil.test");

      const trusted = makeEvent("app://-/studio");
      listeners.get("reader-library:flush-complete")!(trusted, { token: "t" });
      expect(listener).toHaveBeenCalledWith(trusted, { token: "t" });
    });

    it("contains a throwing listener instead of raising it in the main process", () => {
      const { ipc, listeners, onListenerError } = setup();
      const failure = new Error("listener bug");
      ipc.on("reader-library:flush-complete", () => {
        throw failure;
      });

      expect(() => listeners.get("reader-library:flush-complete")!(makeEvent("app://-/studio"), {})).not.toThrow();
      expect(onListenerError).toHaveBeenCalledWith("reader-library:flush-complete", failure);
    });

    it("works without any reporting callbacks", () => {
      const { ipc, listeners } = setup({ onUntrustedSender: undefined, onListenerError: undefined });
      ipc.on("reader-library:flush-complete", () => {
        throw new Error("listener bug");
      });

      expect(() => listeners.get("reader-library:flush-complete")!(makeEvent("https://evil.test"), {})).not.toThrow();
      expect(() => listeners.get("reader-library:flush-complete")!(makeEvent("app://-/studio"), {})).not.toThrow();
    });
  });

  describe("onPort", () => {
    it("hands a trusted sender's port to the listener", () => {
      const { ipc, listeners } = setup();
      const listener = vi.fn();
      ipc.onPort("document:read-epub", listener);
      const port = createPort();
      const event = makeEvent("app://-/studio", undefined, [port]);

      listeners.get("document:read-epub")!(event, { transferId: "t" });

      expect(listener).toHaveBeenCalledWith(port, { transferId: "t" }, event);
      expect(port.close).not.toHaveBeenCalled();
    });

    it("closes an untrusted sender's port without answering on it", () => {
      const { ipc, listeners, onUntrustedSender } = setup();
      const listener = vi.fn();
      ipc.onPort("reader-library:get-audio-stream", listener);
      const port = createPort();

      listeners.get("reader-library:get-audio-stream")!(makeEvent("https://evil.test", undefined, [port]), {});

      expect(listener).not.toHaveBeenCalled();
      expect(port.close).toHaveBeenCalledTimes(1);
      expect(port.postMessage).not.toHaveBeenCalled();
      expect(onUntrustedSender).toHaveBeenCalledWith("reader-library:get-audio-stream", "https://evil.test");
    });

    it("ignores a message that carries no port, trusted or not", () => {
      const { ipc, listeners, onUntrustedSender } = setup();
      const listener = vi.fn();
      ipc.onPort("document:read-epub", listener);

      listeners.get("document:read-epub")!(makeEvent("app://-/studio"), {});
      listeners.get("document:read-epub")!(makeEvent("https://evil.test"), {});

      expect(listener).not.toHaveBeenCalled();
      expect(onUntrustedSender).not.toHaveBeenCalled();
    });

    it("closes the port and reports when the listener throws", () => {
      const { ipc, listeners, onListenerError } = setup();
      const failure = new Error("listener bug");
      ipc.onPort("reader-library:save-audio-stream", () => {
        throw failure;
      });
      const port = createPort();

      expect(() => listeners.get("reader-library:save-audio-stream")!(
        makeEvent("app://-/studio", undefined, [port]),
        {},
      )).not.toThrow();
      expect(port.close).toHaveBeenCalledTimes(1);
      expect(onListenerError).toHaveBeenCalledWith("reader-library:save-audio-stream", failure);
    });

    it("still closes an untrusted sender's port and contains a listener bug when reporters throw", () => {
      const { ipc, listeners } = setup({
        onUntrustedSender: throwingReporter(),
        onListenerError: throwingReporter(),
      });
      ipc.onPort("reader-library:save-audio-stream", () => {
        throw new Error("listener bug");
      });
      ipc.on("reader-library:flush-complete", () => {
        throw new Error("listener bug");
      });
      const untrustedPort = createPort();
      const trustedPort = createPort();

      expect(() => listeners.get("reader-library:save-audio-stream")!(
        makeEvent("https://evil.test", undefined, [untrustedPort]),
        {},
      )).not.toThrow();
      expect(() => listeners.get("reader-library:save-audio-stream")!(
        makeEvent("app://-/studio", undefined, [trustedPort]),
        {},
      )).not.toThrow();
      expect(() => listeners.get("reader-library:flush-complete")!(makeEvent("app://-/studio"), {})).not.toThrow();
      expect(untrustedPort.close).toHaveBeenCalledTimes(1);
      expect(trustedPort.close).toHaveBeenCalledTimes(1);
    });

    it("tolerates a port the throwing listener already closed", () => {
      const { ipc, listeners, onListenerError } = setup();
      ipc.onPort("reader-library:save-audio-stream", () => {
        throw new Error("listener bug");
      });
      const port = createPort();
      port.close.mockImplementation(() => {
        throw new Error("already closed");
      });

      expect(() => listeners.get("reader-library:save-audio-stream")!(
        makeEvent("app://-/studio", undefined, [port]),
        {},
      )).not.toThrow();
      expect(onListenerError).toHaveBeenCalledTimes(1);
    });
  });
});
