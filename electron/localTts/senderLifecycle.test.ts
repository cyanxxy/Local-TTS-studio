// @vitest-environment node

import { EventEmitter } from "events";
import { describe, expect, it, vi } from "vitest";
import { createSenderWatcher, type RequestSender } from "./senderLifecycle";

class FakeSender extends EventEmitter {
  constructor(readonly id: number) {
    super();
  }
}

function asSender(sender: FakeSender): RequestSender {
  return sender as unknown as RequestSender;
}

describe("createSenderWatcher", () => {
  it("reports a crash and every committed main-frame document (a reload or an error page included)", () => {
    const onGone = vi.fn();
    const watch = createSenderWatcher(onGone);
    const sender = new FakeSender(4);
    watch(asSender(sender));

    sender.emit("did-navigate", {}, "app://-/studio", 200, "OK");
    sender.emit("render-process-gone");
    // The renderer is still the same web contents afterwards, so it stays watched.
    sender.emit("did-navigate", {}, "app://-/studio", 200, "OK");
    // A failed navigation that replaced the page with Chromium's error page.
    sender.emit("did-fail-provisional-load", {}, -105, "ERR_NAME_NOT_RESOLVED", "app://-/", true);
    expect(onGone.mock.calls).toEqual([[4], [4], [4], [4]]);
  });

  it("ignores a navigation that never commits, and subframe error pages", () => {
    const onGone = vi.fn();
    const watch = createSenderWatcher(onGone);
    const sender = new FakeSender(4);
    watch(asSender(sender));

    // A file dropped on the window, or a link to another site: Electron 45
    // emits did-start-navigation, will-navigate blocks it, and nothing else
    // follows. The page that started it is still running.
    sender.emit("did-start-navigation", { url: "file:///tmp/notes.txt", isMainFrame: true, isSameDocument: false });
    sender.emit("did-fail-provisional-load", {}, -3, "ERR_ABORTED", "app://-/", true);
    sender.emit("did-fail-provisional-load", {}, -105, "ERR_NAME_NOT_RESOLVED", "https://example.com/", false);

    expect(onGone).not.toHaveBeenCalled();
  });

  it("reports destruction once and removes its listeners", () => {
    const onGone = vi.fn();
    const watch = createSenderWatcher(onGone);
    const sender = new FakeSender(4);
    watch(asSender(sender));

    sender.emit("destroyed");
    sender.emit("destroyed");

    expect(onGone).toHaveBeenCalledOnce();
    expect(sender.listenerCount("render-process-gone")).toBe(0);
    expect(sender.listenerCount("did-navigate")).toBe(0);
    expect(sender.listenerCount("did-fail-provisional-load")).toBe(0);
  });

  it("watches a sender once however often it is passed in, separately per watcher", () => {
    const sender = new FakeSender(4);
    const watch = createSenderWatcher(vi.fn());
    watch(asSender(sender));
    watch(asSender(sender));
    expect(sender.listenerCount("render-process-gone")).toBe(1);

    createSenderWatcher(vi.fn())(asSender(sender));
    expect(sender.listenerCount("render-process-gone")).toBe(2);
  });
});
