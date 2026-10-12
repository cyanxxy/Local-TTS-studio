import { describe, expect, it, vi } from "vitest";
import { abortable, createAbortError, createAsyncChannel, isAbortError } from "./asyncChannel";

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = [];
  for await (const value of iterable) values.push(value);
  return values;
}

describe("createAsyncChannel", () => {
  it("delivers values pushed before and after the consumer asks, then ends on close", async () => {
    const channel = createAsyncChannel<number>();
    channel.push(1);
    const pending = collect(channel);
    channel.push(2);
    channel.close();
    channel.push(3);

    await expect(pending).resolves.toEqual([1, 2]);
    expect(channel.settled).toBe(true);
    await expect(channel.next()).resolves.toEqual({ value: undefined, done: true });
  });

  it("drops buffered values on failure and rejects the next pull once", async () => {
    const channel = createAsyncChannel<number>();
    channel.push(1);
    const error = new Error("broken");
    channel.fail(error);
    channel.fail(new Error("ignored"));
    channel.close();

    await expect(channel.next()).rejects.toBe(error);
    await expect(channel.next()).resolves.toEqual({ value: undefined, done: true });
  });

  it("rejects the waiting pull on failure and ends any other waiter", async () => {
    const channel = createAsyncChannel<number>();
    const first = channel.next();
    const second = channel.next();
    const error = new Error("broken");
    channel.fail(error);

    await expect(first).rejects.toBe(error);
    await expect(second).resolves.toEqual({ value: undefined, done: true });
    await expect(channel.next()).resolves.toEqual({ value: undefined, done: true });
  });

  it("resolves waiting pulls in order and ends them on close", async () => {
    const channel = createAsyncChannel<string>();
    const first = channel.next();
    const second = channel.next();
    channel.push("a");
    channel.close();

    await expect(first).resolves.toEqual({ value: "a", done: false });
    await expect(second).resolves.toEqual({ value: undefined, done: true });
  });

  it("reports an early stop once and ignores later pushes", async () => {
    const onReturn = vi.fn();
    const channel = createAsyncChannel<number>({ onReturn });
    channel.push(1);
    channel.push(2);
    const waiting = createAsyncChannel<number>({ onReturn });
    const pull = waiting.next();

    for await (const value of channel) {
      expect(value).toBe(1);
      break;
    }
    await waiting.return();
    await channel.return();

    expect(onReturn).toHaveBeenCalledTimes(2);
    await expect(pull).resolves.toEqual({ value: undefined, done: true });
    channel.push(3);
    await expect(channel.next()).resolves.toEqual({ value: undefined, done: true });
  });

  it("does not report a stop after the producer already finished", async () => {
    const onReturn = vi.fn();
    const channel = createAsyncChannel<number>({ onReturn });
    channel.close();
    await channel.return();

    expect(onReturn).not.toHaveBeenCalled();
  });
});

describe("abort helpers", () => {
  it("recognizes abort errors", () => {
    expect(isAbortError(createAbortError())).toBe(true);
    expect(createAbortError("Stopped.").message).toBe("Stopped.");
    expect(isAbortError(new Error("no"))).toBe(false);
    expect(isAbortError(null)).toBe(false);
    expect(isAbortError("AbortError")).toBe(false);
  });

  it("settles with the promise while the signal stays live", async () => {
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    await expect(abortable(Promise.resolve(7), controller.signal)).resolves.toBe(7);
    const error = new Error("failed");
    await expect(abortable(Promise.reject(error), controller.signal)).rejects.toBe(error);
    expect(remove).toHaveBeenCalledTimes(2);
  });

  it("rejects with the signal's reason when it aborts first or already has", async () => {
    const controller = new AbortController();
    const pending = abortable(new Promise(() => undefined), controller.signal);
    const reason = createAbortError("Stopped.");
    controller.abort(reason);

    await expect(pending).rejects.toBe(reason);
    await expect(abortable(Promise.resolve(1), controller.signal)).rejects.toBe(reason);
  });
});
