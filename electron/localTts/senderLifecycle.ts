import type { WebContents } from "electron";

/**
 * The renderer behind a request or lease. Watching it lets main release what
 * a crashed, navigating or closed renderer can no longer release itself.
 */
export type RequestSender = Pick<WebContents, "id" | "on" | "once" | "removeListener">;

/**
 * Chromium's net::ERR_ABORTED. A navigation that ends with it never commits an
 * error page, so the current document is still there.
 */
const NET_ERR_ABORTED = -3;

/**
 * Returns `watch(sender)`, which calls `onGone(sender.id)` whenever that
 * renderer crashes or its main frame commits another document (a reload
 * included), and once more when it is destroyed. Each sender is watched once,
 * however often it is passed in, and its listeners go when it is destroyed.
 *
 * Only a committed navigation counts. `did-start-navigation` also fires for a
 * navigation that `will-navigate` then blocks (a link to another site, a file
 * dropped on the window), and the page that started it keeps running, so
 * releasing its requests and leases there would cancel a live generation.
 * `did-navigate` reports a committed main-frame document; a failed navigation
 * that commits an error page in its place reports `did-fail-provisional-load`
 * instead, and Electron only emits that one for committed navigations.
 */
export function createSenderWatcher(onGone: (senderId: number) => void): (sender: RequestSender) => void {
  const watched = new WeakSet<RequestSender>();
  return (sender) => {
    if (watched.has(sender)) return;
    watched.add(sender);
    const senderId = sender.id;
    const gone = () => onGone(senderId);
    const errorPageCommitted = (
      _event: unknown,
      errorCode: number,
      _errorDescription: string,
      _validatedUrl: string,
      isMainFrame: boolean,
    ) => {
      if (isMainFrame && errorCode !== NET_ERR_ABORTED) gone();
    };
    sender.on("render-process-gone", gone);
    sender.on("did-navigate", gone);
    sender.on("did-fail-provisional-load", errorPageCommitted);
    sender.once("destroyed", () => {
      gone();
      sender.removeListener("render-process-gone", gone);
      sender.removeListener("did-navigate", gone);
      sender.removeListener("did-fail-provisional-load", errorPageCommitted);
    });
  };
}
