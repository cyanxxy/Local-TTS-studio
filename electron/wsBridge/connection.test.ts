// @vitest-environment node

import net from "net";
import { describe, expect, it } from "vitest";
import { closeQuietly, isOpen, openWebSocketWithRetry } from "./connection";

// A port that was free a moment ago refuses connections outright.
async function unusedPort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as net.AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

describe("openWebSocketWithRetry", () => {
  it("keeps retrying a refused connection until the budget runs out, then reports why", async () => {
    const port = await unusedPort();
    let attempts = 0;
    const started = Date.now();

    await expect(openWebSocketWithRetry(`ws://127.0.0.1:${port}/token`, 300, () => {
      attempts += 1;
      return true;
    })).rejects.toThrow("Failed connecting to Rust local bridge WebSocket.");

    expect(attempts).toBeGreaterThan(1);
    expect(Date.now() - started).toBeGreaterThanOrEqual(300);
  });

  it("stops at once when the process is already gone", async () => {
    await expect(openWebSocketWithRetry("ws://127.0.0.1:1/token", 5_000, () => false))
      .rejects.toThrow("Rust local bridge process exited during startup.");
  });

  it("times out a server that accepts the connection but never answers the upgrade", async () => {
    const server = net.createServer(() => undefined);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as net.AddressInfo;
    try {
      await expect(openWebSocketWithRetry(`ws://127.0.0.1:${port}/token`, 200, () => true))
        .rejects.toThrow("Timed out connecting to Rust local bridge WebSocket.");
    } finally {
      server.close();
    }
  });
});

describe("socket helpers", () => {
  it("treats only an open socket as open and closes any socket quietly", () => {
    expect(isOpen(null)).toBe(false);
    expect(isOpen({ readyState: WebSocket.CLOSED } as WebSocket)).toBe(false);
    expect(isOpen({ readyState: WebSocket.OPEN } as WebSocket)).toBe(true);

    expect(() => closeQuietly(null)).not.toThrow();
    expect(() => closeQuietly({ close: () => { throw new Error("closed"); } } as unknown as WebSocket)).not.toThrow();
  });
});
