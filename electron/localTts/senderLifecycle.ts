import type { WebContents } from "electron";

/**
 * The renderer behind a request or lease. Watching it lets main release what
 * a crashed, navigating or closed renderer can no longer release itself.
 */
export type RequestSender = Pick<WebContents, "id" | "on" | "once" | "removeListener">;

/**
 * Returns `watch(sender)`, which calls `onGone(sender.id)` whenever that
 * renderer crashes or its main frame navigates to another document (a reload
 * included), and once more when it is destroyed. Each sender is watched once,
 * however often it is passed in, and its listeners go when it is destroyed.
 */
export function createSenderWatcher(onGone: (senderId: number) => void): (sender: RequestSender) => void {
  const watched = new WeakSet<RequestSender>();
  return (sender) => {
    if (watched.has(sender)) return;
    watched.add(sender);
    const senderId = sender.id;
    const gone = () => onGone(senderId);
    const navigated = (details: { isMainFrame: boolean; isSameDocument: boolean }) => {
      if (details.isMainFrame && !details.isSameDocument) gone();
    };
    sender.on("render-process-gone", gone);
    sender.on("did-start-navigation", navigated);
    sender.once("destroyed", () => {
      gone();
      sender.removeListener("render-process-gone", gone);
      sender.removeListener("did-start-navigation", navigated);
    });
  };
}
