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
  it("reports a crash and every main-frame navigation to a new document", () => {
    const onGone = vi.fn();
    const watch = createSenderWatcher(onGone);
    const sender = new FakeSender(4);
    watch(asSender(sender));

    sender.emit("did-start-navigation", { isMainFrame: true, isSameDocument: true });
    sender.emit("did-start-navigation", { isMainFrame: false, isSameDocument: false });
    expect(onGone).not.toHaveBeenCalled();

    sender.emit("did-start-navigation", { isMainFrame: true, isSameDocument: false });
    sender.emit("render-process-gone");
    // The renderer is still the same web contents afterwards, so it stays watched.
    sender.emit("did-start-navigation", { isMainFrame: true, isSameDocument: false });
    expect(onGone.mock.calls).toEqual([[4], [4], [4]]);
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
    expect(sender.listenerCount("did-start-navigation")).toBe(0);
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
