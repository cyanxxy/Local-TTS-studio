import type {
  IpcMain,
  IpcMainEvent,
  IpcMainInvokeEvent,
  MessagePortMain,
} from "electron";
import { isAllowedAppUrl } from "../security";
import type { IpcInvokeChannel, IpcMessageChannel, IpcPortChannel } from "./channels";

export const UNTRUSTED_SENDER_MESSAGE = "Rejected IPC from untrusted sender.";

/** The part of an IPC event the trust check reads. */
export interface IpcSenderEvent {
  senderFrame?: { url: string } | null;
}

/**
 * The URL of the frame that sent the message, or null once that frame has
 * navigated away or been destroyed. Electron's security checklist (item 17)
 * validates the sending frame. The web contents' URL is not a stand-in for
 * it: that is the main frame's current document, which may not be the
 * document (or the frame) that sent the message, so a message whose sender is
 * gone is treated as untrusted.
 */
export function ipcSenderUrl(event: IpcSenderEvent): string | null {
  return event.senderFrame?.url ?? null;
}

function isTrustedSenderUrl(url: string | null, options: { allowDevServer?: boolean }): boolean {
  return url !== null && isAllowedAppUrl(url, options);
}

export function assertTrustedIpcSender(
  event: IpcSenderEvent,
  options: { allowDevServer?: boolean } = { allowDevServer: true },
): void {
  if (!isTrustedSenderUrl(ipcSenderUrl(event), options)) {
    throw new Error(UNTRUSTED_SENDER_MESSAGE);
  }
}

export interface TrustedIpc {
  /**
   * `ipcMain.handle` that rejects untrusted senders before the handler runs.
   * The handler's return value (or synchronous throw) passes through as is.
   */
  handle(
    channel: IpcInvokeChannel,
    handler: (event: IpcMainInvokeEvent, request: unknown) => unknown,
  ): void;
  /** `ipcMain.on` for fire-and-forget messages; untrusted senders are ignored. */
  on(
    channel: IpcMessageChannel,
    listener: (event: IpcMainEvent, request: unknown) => void,
  ): void;
  /**
   * `ipcMain.on` for messages that transfer a MessagePort. A message without a
   * port is ignored, and the port of an untrusted sender is closed without
   * telling that sender anything about why it was rejected.
   */
  onPort(
    channel: IpcPortChannel,
    listener: (port: MessagePortMain, request: unknown, event: IpcMainEvent) => void,
  ): void;
}

export interface TrustedIpcOptions {
  allowDevServer: boolean;
  /** Told about every rejected sender; only the origin, never the full URL. */
  onUntrustedSender?: (channel: string, senderOrigin: string) => void;
  /**
   * Told when an `on`/`onPort` listener throws. Electron would otherwise raise
   * it as an uncaught exception in the main process.
   */
  onListenerError?: (channel: string, error: unknown) => void;
  /**
   * Told when a `handle` handler throws or its promise rejects. The renderer
   * still receives the failure exactly as before.
   */
  onHandlerError?: (channel: string, error: unknown) => void;
}

function senderOrigin(event: IpcSenderEvent): string {
  const url = ipcSenderUrl(event);
  if (url === null) return "unknown";
  try {
    return new URL(url).origin;
  } catch {
    return "unknown";
  }
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return typeof value === "object" && value !== null && typeof (value as { then?: unknown }).then === "function";
}

export function createTrustedIpc(
  ipcMain: Pick<IpcMain, "handle" | "on">,
  { allowDevServer, onUntrustedSender, onListenerError, onHandlerError }: TrustedIpcOptions,
): TrustedIpc {
  // The callbacks only observe. One that throws must never change what the
  // sender gets back, leave a port open, or escape into Electron.
  const report = <Args extends unknown[]>(callback: ((...args: Args) => void) | undefined, ...args: Args): void => {
    try {
      callback?.(...args);
    } catch {
      // Diagnostics only.
    }
  };

  const isTrusted = (channel: string, event: IpcSenderEvent): boolean => {
    if (isTrustedSenderUrl(ipcSenderUrl(event), { allowDevServer })) return true;
    report(onUntrustedSender, channel, senderOrigin(event));
    return false;
  };

  return {
    handle(channel, handler) {
      ipcMain.handle(channel, (event, request: unknown) => {
        if (!isTrusted(channel, event)) throw new Error(UNTRUSTED_SENDER_MESSAGE);
        let result: unknown;
        try {
          result = handler(event, request);
        } catch (error) {
          report(onHandlerError, channel, error);
          throw error;
        }
        // Observe an async failure without touching a synchronous result.
        if (!onHandlerError || !isPromiseLike(result)) return result;
        return Promise.resolve(result).catch((error: unknown) => {
          report(onHandlerError, channel, error);
          throw error;
        });
      });
    },

    on(channel, listener) {
      ipcMain.on(channel, (event, request: unknown) => {
        if (!isTrusted(channel, event)) return;
        try {
          listener(event, request);
        } catch (error) {
          report(onListenerError, channel, error);
        }
      });
    },

    onPort(channel, listener) {
      ipcMain.on(channel, (event, request: unknown) => {
        const [port] = event.ports;
        if (!port) return;
        if (!isTrusted(channel, event)) {
          port.close();
          return;
        }
        try {
          listener(port, request, event);
        } catch (error) {
          // The port already belongs to main, so a listener bug must not
          // leave the renderer waiting out its own transfer timeout.
          try {
            port.close();
          } catch {
            // Already closed by the listener.
          }
          report(onListenerError, channel, error);
        }
      });
    },
  };
}
