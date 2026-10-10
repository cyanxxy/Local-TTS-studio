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

function makeEvent(url: string, frameUrl?: string | null, ports: unknown[] = []) {
  return {
    senderFrame: frameUrl === undefined ? undefined : frameUrl === null ? null : { url: frameUrl },
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
  const ipc = createTrustedIpc(ipcMain as never, {
    allowDevServer: false,
    onUntrustedSender,
    onListenerError,
    ...options,
  });
  return { ipc, handlers, listeners, onUntrustedSender, onListenerError };
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

  it("falls back to the web contents URL once the sending frame is gone", () => {
    expect(ipcSenderUrl(makeEvent("app://-/reader", null))).toBe("app://-/reader");
    expect(ipcSenderUrl(makeEvent("https://evil.test", "app://-/studio"))).toBe("app://-/studio");
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

    it("propagates handler failures to the invoking renderer", () => {
      const { ipc, handlers, onListenerError } = setup();
      ipc.handle("local-tts:cancel", () => {
        throw new TypeError("Invalid cancel request payload.");
      });

      expect(() => handlers.get("local-tts:cancel")!(makeEvent("app://-/studio"), null))
        .toThrow("Invalid cancel request payload.");
      expect(onListenerError).not.toHaveBeenCalled();
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
