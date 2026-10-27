// @vitest-environment node

import { EventEmitter } from "events";
import { describe, expect, it, vi } from "vitest";
import { KeepWarmLeases, MAX_KEEP_WARM_LEASES_PER_SENDER } from "./keepWarmLeases";
import type { RequestSender } from "./senderLifecycle";

class FakeSender extends EventEmitter {
  constructor(readonly id: number) {
    super();
  }
}

function asSender(sender: FakeSender): RequestSender {
  return sender as unknown as RequestSender;
}

function setup() {
  const onChange = vi.fn();
  return { leases: new KeepWarmLeases(onChange), onChange };
}

describe("KeepWarmLeases", () => {
  it("covers exactly the model target a lease names", () => {
    const { leases, onChange } = setup();
    leases.acquire(asSender(new FakeSender(1)), "lease-1", "qwen3", "target-a");

    expect(onChange).toHaveBeenCalledWith("qwen3");
    expect(leases.covers("qwen3", "target-a")).toBe(true);
    expect(leases.covers("qwen3", "target-b")).toBe(false);
    expect(leases.covers("neutts", "target-a")).toBe(false);
    // A worker that has nothing loaded is never covered.
    expect(leases.covers("qwen3", null)).toBe(false);
  });

  it("stops covering a target once its last lease is released", () => {
    const { leases, onChange } = setup();
    const first = new FakeSender(1);
    const second = new FakeSender(2);
    leases.acquire(asSender(first), "lease", "qwen3", "target");
    leases.acquire(asSender(second), "lease", "qwen3", "target");
    onChange.mockClear();

    expect(leases.release(1, "lease")).toBe(true);
    expect(onChange).toHaveBeenCalledWith("qwen3");
    expect(leases.covers("qwen3", "target")).toBe(true);

    expect(leases.release(2, "lease")).toBe(true);
    expect(leases.covers("qwen3", "target")).toBe(false);
  });

  it("keeps a window's other leases when it releases one", () => {
    const { leases } = setup();
    const sender = new FakeSender(1);
    leases.acquire(asSender(sender), "a", "qwen3", "target-a");
    leases.acquire(asSender(sender), "b", "qwen3", "target-b");

    expect(leases.release(1, "a")).toBe(true);

    expect(leases.covers("qwen3", "target-a")).toBe(false);
    expect(leases.covers("qwen3", "target-b")).toBe(true);
    expect(leases.release(1, "b")).toBe(true);
  });

  it("scopes lease ids to their window, so one window cannot release another's lease", () => {
    const { leases, onChange } = setup();
    leases.acquire(asSender(new FakeSender(1)), "lease", "qwen3", "target");
    onChange.mockClear();

    expect(leases.release(2, "lease")).toBe(false);
    expect(leases.release(1, "other")).toBe(false);
    expect(onChange).not.toHaveBeenCalled();
    expect(leases.covers("qwen3", "target")).toBe(true);
  });

  it("moves a renewed lease to its new target", () => {
    const { leases } = setup();
    const sender = asSender(new FakeSender(1));
    leases.acquire(sender, "lease", "qwen3", "target-a");
    leases.acquire(sender, "lease", "qwen3", "target-b");

    expect(leases.covers("qwen3", "target-a")).toBe(false);
    expect(leases.covers("qwen3", "target-b")).toBe(true);
  });

  it("re-times both models when a renewed lease changes model", () => {
    const { leases, onChange } = setup();
    const sender = asSender(new FakeSender(1));
    leases.acquire(sender, "lease", "neutts", "target-a");
    onChange.mockClear();

    leases.acquire(sender, "lease", "qwen3", "target-b");

    expect(onChange.mock.calls).toEqual([["neutts"], ["qwen3"]]);
  });

  it("caps the leases one window may hold, but still lets it renew one", () => {
    const { leases } = setup();
    const sender = asSender(new FakeSender(1));
    for (let index = 0; index < MAX_KEEP_WARM_LEASES_PER_SENDER; index += 1) {
      leases.acquire(sender, `lease-${index}`, "qwen3", "target");
    }

    expect(() => leases.acquire(sender, "one-too-many", "qwen3", "target"))
      .toThrow(`A window can hold at most ${MAX_KEEP_WARM_LEASES_PER_SENDER} keep-warm leases.`);
    expect(() => leases.acquire(sender, "lease-0", "qwen3", "other")).not.toThrow();
    expect(() => leases.acquire(asSender(new FakeSender(2)), "lease", "qwen3", "target")).not.toThrow();
  });

  it.each([
    ["crashes", (sender: FakeSender) => sender.emit("render-process-gone")],
    ["reloads", (sender: FakeSender) => sender.emit("did-navigate", {}, "app://-/studio", 200, "OK")],
    ["closes", (sender: FakeSender) => sender.emit("destroyed")],
  ])("drops every lease of a window that %s, and only those", (_name, leave) => {
    const { leases, onChange } = setup();
    const leaving = new FakeSender(1);
    const staying = new FakeSender(2);
    leases.acquire(asSender(leaving), "a", "qwen3", "target-a");
    leases.acquire(asSender(leaving), "b", "qwen3", "target-b");
    leases.acquire(asSender(staying), "c", "qwen3", "target-c");
    onChange.mockClear();

    leave(leaving);

    expect(leases.covers("qwen3", "target-a")).toBe(false);
    expect(leases.covers("qwen3", "target-b")).toBe(false);
    expect(leases.covers("qwen3", "target-c")).toBe(true);
    // One re-time per model, however many leases the window held on it.
    expect(onChange.mock.calls).toEqual([["qwen3"]]);
    expect(leases.release(1, "a")).toBe(false);
  });

  it("ignores a window going away when it holds no leases", () => {
    const { leases, onChange } = setup();
    const sender = new FakeSender(1);
    leases.acquire(asSender(sender), "lease", "qwen3", "target");
    leases.release(1, "lease");
    onChange.mockClear();

    sender.emit("render-process-gone");

    expect(onChange).not.toHaveBeenCalled();
  });
});
