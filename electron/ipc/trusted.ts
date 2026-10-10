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
  sender: { getURL(): string };
}

export function ipcSenderUrl(event: IpcSenderEvent): string {
  // `senderFrame` is null once the frame has navigated away or been destroyed.
  return event.senderFrame?.url ?? event.sender.getURL();
}

export function assertTrustedIpcSender(
  event: IpcSenderEvent,
  options: { allowDevServer?: boolean } = { allowDevServer: true },
): void {
  if (!isAllowedAppUrl(ipcSenderUrl(event), options)) {
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
}

function senderOrigin(event: IpcSenderEvent): string {
  try {
    return new URL(ipcSenderUrl(event)).origin;
  } catch {
    return "unknown";
  }
}

export function createTrustedIpc(
  ipcMain: Pick<IpcMain, "handle" | "on">,
  { allowDevServer, onUntrustedSender, onListenerError }: TrustedIpcOptions,
): TrustedIpc {
  const isTrusted = (channel: string, event: IpcSenderEvent): boolean => {
    if (isAllowedAppUrl(ipcSenderUrl(event), { allowDevServer })) return true;
    onUntrustedSender?.(channel, senderOrigin(event));
    return false;
  };

  return {
    handle(channel, handler) {
      ipcMain.handle(channel, (event, request: unknown) => {
        if (!isTrusted(channel, event)) throw new Error(UNTRUSTED_SENDER_MESSAGE);
        return handler(event, request);
      });
    },

    on(channel, listener) {
      ipcMain.on(channel, (event, request: unknown) => {
        if (!isTrusted(channel, event)) return;
        try {
          listener(event, request);
        } catch (error) {
          onListenerError?.(channel, error);
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
          onListenerError?.(channel, error);
        }
      });
    },
  };
}
