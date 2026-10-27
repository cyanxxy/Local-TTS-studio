// @vitest-environment node

import { EventEmitter } from "events";
import { describe, expect, it, vi } from "vitest";
import { BridgeRequestRegistry, type RequestSender } from "./requestRegistry";

class FakeSender extends EventEmitter {
  constructor(readonly id: number) {
    super();
  }
}

function asSender(sender: FakeSender): RequestSender {
  return sender as unknown as RequestSender;
}

function setup() {
  const stop = vi.fn();
  return { registry: new BridgeRequestRegistry(stop), stop };
}

describe("BridgeRequestRegistry", () => {
  it("claims an id for its sender and refuses a second claim while it runs", () => {
    const { registry } = setup();
    const sender = new FakeSender(7);

    const owner = registry.register("r1", "qwen3", "generate", asSender(sender));

    expect(owner).toEqual({ model: "qwen3", senderId: 7, kind: "generate" });
    expect(registry.owner("r1")).toBe(owner);
    expect(() => registry.register("r1", "neutts", "probe")).toThrow("A request with id r1 is already running.");
  });

  it("records a cancellation before handing the request to stop", () => {
    const { registry, stop } = setup();
    registry.register("r1", "qwen3", "generate");
    stop.mockImplementation(() => {
      // Code still between await points must already see the cancellation.
      expect(registry.isCancelled("r1")).toBe(true);
    });

    registry.cancel("r1");

    expect(stop).toHaveBeenCalledWith("r1");
  });

  it("marks cancellations without stopping when the caller stops the request itself", () => {
    const { registry, stop } = setup();
    registry.register("r1", "qwen3", "warm");
    registry.register("r2", "neutts", "generate");

    registry.markCancelled("r1");
    expect(registry.isCancelled("r1")).toBe(true);
    expect(registry.isCancelled("r2")).toBe(false);

    registry.markAllCancelled();
    expect(registry.isCancelled("r2")).toBe(true);
    expect(stop).not.toHaveBeenCalled();
  });

  it("releases only the owner it was given and always forgets the cancellation", () => {
    const { registry } = setup();
    const first = registry.register("r1", "qwen3", "generate");
    registry.cancel("r1");
    registry.release("r1", first);
    expect(registry.owner("r1")).toBeUndefined();
    expect(registry.isCancelled("r1")).toBe(false);

    const second = registry.register("r1", "qwen3", "generate");
    registry.release("r1", first);
    expect(registry.owner("r1")).toBe(second);
  });

  it("cancels every request a crashed renderer owns, and only those", () => {
    const { registry, stop } = setup();
    const crashed = new FakeSender(1);
    const healthy = new FakeSender(2);
    registry.register("a", "qwen3", "generate", asSender(crashed));
    registry.register("b", "neutts", "probe", asSender(crashed));
    registry.register("c", "qwen3", "warm", asSender(healthy));

    crashed.emit("render-process-gone");

    expect(stop.mock.calls.map(([requestId]) => requestId)).toEqual(["a", "b"]);
    expect(registry.isCancelled("c")).toBe(false);
  });

  it("cancels when the main frame commits a new document, not on a navigation that was blocked", () => {
    const { registry, stop } = setup();
    const sender = new FakeSender(1);
    registry.register("r1", "qwen3", "generate", asSender(sender));

    // will-navigate blocked it (e.g. a file dropped on the window): the page that
    // owns the generation is still there.
    sender.emit("did-start-navigation", { isMainFrame: true, isSameDocument: false });
    expect(stop).not.toHaveBeenCalled();

    sender.emit("did-navigate", {}, "app://-/studio", 200, "OK");
    expect(stop).toHaveBeenCalledWith("r1");
  });

  it("cancels on destruction and stops watching the destroyed renderer", () => {
    const { registry, stop } = setup();
    const sender = new FakeSender(1);
    registry.register("r1", "qwen3", "generate", asSender(sender));

    sender.emit("destroyed");

    expect(stop).toHaveBeenCalledWith("r1");
    expect(sender.listenerCount("render-process-gone")).toBe(0);
    expect(sender.listenerCount("did-navigate")).toBe(0);
  });

  it("watches each renderer once however many requests it starts", () => {
    const { registry } = setup();
    const sender = new FakeSender(1);
    const first = registry.register("r1", "qwen3", "generate", asSender(sender));
    registry.release("r1", first);
    registry.register("r2", "qwen3", "generate", asSender(sender));

    expect(sender.listenerCount("render-process-gone")).toBe(1);
    expect(sender.listenerCount("destroyed")).toBe(1);
  });

  it("does not let an internal request without a sender be cancelled by any renderer", () => {
    const { registry, stop } = setup();
    const sender = new FakeSender(1);
    registry.register("internal", "qwen3", "warm");
    registry.register("owned", "qwen3", "generate", asSender(sender));

    sender.emit("render-process-gone");

    expect(registry.owner("internal")).toEqual({ model: "qwen3", senderId: -1, kind: "warm" });
    expect(stop).toHaveBeenCalledTimes(1);
    expect(stop).toHaveBeenCalledWith("owned");
  });
});
