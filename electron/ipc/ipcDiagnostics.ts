import type { DiagnosticsLogger } from "../diagnostics";
import { describeError, errorMessage, nativeFailureDiagnostics } from "../errors";
import type { TrustedIpcOptions } from "./trusted";

// Each distinct (channel, origin) pair is logged once, and only this many
// pairs at all, so a page hammering IPC cannot flood the log.
const MAX_REPORTED_UNTRUSTED_SENDERS = 64;

// Each runtime words its own deliberate stop ("Generation cancelled.",
// "Audio8 request cancelled.", "Download cancelled."). Stops are routine, so
// they are recorded at debug level only.
const CANCELLATION = /\bcancell?ed\b/i;

export type IpcDiagnostics = Required<
  Pick<TrustedIpcOptions, "onUntrustedSender" | "onListenerError" | "onHandlerError">
>;

/** Records rejected senders and failed IPC requests in the diagnostics log. */
export function createIpcDiagnostics(log: DiagnosticsLogger): IpcDiagnostics {
  const reportedUntrustedSenders = new Set<string>();

  return {
    onUntrustedSender(channel, senderOrigin) {
      const key = `${channel}\0${senderOrigin}`;
      if (reportedUntrustedSenders.has(key) || reportedUntrustedSenders.size >= MAX_REPORTED_UNTRUSTED_SENDERS) return;
      reportedUntrustedSenders.add(key);
      log.warn("Rejected IPC from an untrusted sender", { channel, senderOrigin });
    },

    onListenerError(channel, error) {
      log.error("IPC listener failed", { channel, error: describeError(error) });
    },

    onHandlerError(channel, error) {
      // A native runtime failure is always worth its diagnostics, even if its
      // native output happens to mention a cancellation.
      if (nativeFailureDiagnostics(error)) {
        log.error("IPC request failed", { channel, error: describeError(error) });
      } else if (CANCELLATION.test(errorMessage(error))) {
        log.debug("IPC request cancelled", { channel });
      } else {
        log.warn("IPC request failed", { channel, error: describeError(error) });
      }
    },
  };
}
