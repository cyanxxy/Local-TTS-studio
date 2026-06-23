// @vitest-environment node

import fs from "fs";
import os from "os";
import path from "path";
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "child_process";
import { randomBytes } from "crypto";
import { fileURLToPath } from "url";
import net from "net";
import { beforeAll, describe, expect, it } from "vitest";

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MANIFEST_PATH = path.join(ROOT_DIR, "rust", "local-tts-bridge", "Cargo.toml");
const BRIDGE_BINARY = path.join(
  ROOT_DIR,
  "rust",
  "local-tts-bridge",
  "target",
  "debug",
  process.platform === "win32" ? "open-tts-local-bridge.exe" : "open-tts-local-bridge",
);
const RESULT_PREFIX = "__RESULT__";
const PORT_PREFIX = "__PORT__";

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "open-tts-rust-bridge-"));
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function waitForBridgePort(child: ChildProcessWithoutNullStreams, readStderr: () => string): Promise<number> {
  return new Promise((resolve, reject) => {
    let stdoutLineBuffer = "";
    let settled = false;
    const timeout = setTimeout(() => {
      finish(new Error(`Timed out waiting for bridge port. ${readStderr()}`));
    }, 5_000);

    const finish = (error?: Error, port?: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      child.stdout.off("data", handleStdout);
      child.off("close", handleClose);
      child.off("error", handleError);
      if (error) {
        reject(error);
      } else {
        resolve(port!);
      }
    };

    const handleStdout = (chunk: Buffer) => {
      stdoutLineBuffer += chunk.toString("utf-8");
      const lines = stdoutLineBuffer.split(/\r?\n/);
      stdoutLineBuffer = lines.pop() ?? "";
      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line.startsWith(PORT_PREFIX)) continue;
        const port = Number(line.slice(PORT_PREFIX.length));
        if (!Number.isInteger(port) || port <= 0 || port > 65535) {
          finish(new Error(`Bridge announced invalid port: ${line}`));
          return;
        }
        finish(undefined, port);
        return;
      }
    };

    const handleClose = () => finish(new Error(`Bridge exited before announcing port. ${readStderr()}`));
    const handleError = (error: Error) => finish(error);

    child.stdout.on("data", handleStdout);
    child.on("close", handleClose);
    child.on("error", handleError);
  });
}

function openWebSocketOnce(url: string, timeoutMs: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    let settled = false;
    const timeout = setTimeout(() => finish(new Error(`Timed out connecting to ${url}.`)), timeoutMs);

    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      socket.removeEventListener("open", handleOpen);
      socket.removeEventListener("error", handleError);
      socket.removeEventListener("close", handleClose);
      if (error) {
        try {
          socket.close();
        } catch {
          // Ignore cleanup after a failed connection attempt.
        }
        reject(error);
        return;
      }
      resolve(socket);
    };

    const handleOpen = () => finish();
    const handleError = () => finish(new Error(`Failed connecting to ${url}.`));
    const handleClose = () => finish(new Error(`Closed before connecting to ${url}.`));
    socket.addEventListener("open", handleOpen);
    socket.addEventListener("error", handleError);
    socket.addEventListener("close", handleClose);
  });
}

async function openWebSocketWithRetry(url: string, child: ChildProcessWithoutNullStreams): Promise<WebSocket> {
  const deadline = Date.now() + 5_000;
  let lastError: Error | null = null;
  while (Date.now() < deadline && child.exitCode == null) {
    try {
      return await openWebSocketOnce(url, 250);
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      await delay(50);
    }
  }
  throw lastError ?? new Error(`Timed out connecting to ${url}.`);
}

function buildMaskedTextFrame(text: string): Buffer {
  const payload = Buffer.from(text, "utf-8");
  const mask = randomBytes(4);
  const masked = Buffer.alloc(payload.length);
  for (let index = 0; index < payload.length; index += 1) {
    masked[index] = payload[index] ^ mask[index % 4];
  }

  const header = payload.length < 126
    ? Buffer.from([0x81, 0x80 | payload.length])
    : payload.length <= 0xFFFF
      ? Buffer.concat([Buffer.from([0x81, 0x80 | 126]), Buffer.from([(payload.length >> 8) & 0xFF, payload.length & 0xFF])])
      : (() => {
          const extended = Buffer.alloc(8);
          extended.writeBigUInt64BE(BigInt(payload.length), 0);
          return Buffer.concat([Buffer.from([0x81, 0x80 | 127]), extended]);
        })();
  return Buffer.concat([header, mask, masked]);
}

function readRawSocketResponse(
  port: number,
  request: Buffer | string,
  predicate: (data: Buffer) => boolean,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    let buffer = Buffer.alloc(0);
    const timeout = setTimeout(() => {
      socket.destroy();
      reject(new Error(`Timed out waiting for raw socket response. Received: ${buffer.toString("latin1")}`));
    }, 5_000);

    const finish = (error?: Error) => {
      clearTimeout(timeout);
      socket.removeAllListeners();
      socket.destroy();
      if (error) reject(error);
      else resolve(buffer);
    };

    socket.on("connect", () => socket.write(request));
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (predicate(buffer)) finish();
    });
    socket.on("error", finish);
    socket.on("close", () => {
      if (predicate(buffer)) finish();
    });
  });
}

async function withServeWsBridge<T>(
  model: "qwen3" | "neutts",
  run: (context: { port: number; child: ChildProcessWithoutNullStreams; readStderr: () => string }) => Promise<T>,
): Promise<T> {
  const cacheDir = makeTempDir();
  const child = spawn(BRIDGE_BINARY, [
    "--action", "serve-ws",
    "--model", model,
    "--cache-dir", cacheDir,
    "--host", "127.0.0.1",
    "--port", "0",
    "--auth-token", "test-token",
  ], {
    cwd: ROOT_DIR,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf-8");
  });

  try {
    const port = await waitForBridgePort(child, () => stderr);
    return await run({ port, child, readStderr: () => stderr });
  } finally {
    child.kill();
    fs.rmSync(cacheDir, { recursive: true, force: true });
  }
}

beforeAll(() => {
  const completed = spawnSync("cargo", ["build", "--quiet", "--manifest-path", MANIFEST_PATH], {
    cwd: ROOT_DIR,
    encoding: "utf-8",
  });
  expect(completed.status, completed.stderr || completed.stdout).toBe(0);

  if (process.platform === "darwin") {
    spawnSync("install_name_tool", ["-add_rpath", "@executable_path", BRIDGE_BINARY], {
      cwd: ROOT_DIR,
      encoding: "utf-8",
    });
  }
}, 120_000);

describe("open-tts-local-bridge", () => {
  it("emits Rust-only probe metadata", () => {
    const cacheDir = makeTempDir();

    try {
      const completed = spawnSync(BRIDGE_BINARY, [
        "--action", "probe",
        "--model", "qwen3",
        "--cache-dir", cacheDir,
      ], {
        cwd: ROOT_DIR,
        encoding: "utf-8",
      });

      expect(completed.status, completed.stderr || completed.stdout).toBe(0);
      const resultLine = completed.stdout.split(/\r?\n/).find((line) => line.startsWith(RESULT_PREFIX));
      expect(resultLine).toBeTruthy();
      const parsed = JSON.parse(resultLine!.slice(RESULT_PREFIX.length)) as Record<string, unknown>;
      expect(parsed).toMatchObject({
        ok: true,
        result: {
          ready: true,
          runtime: "rust",
          package: "qwen_tts",
          packageVersion: "0.1.1",
          recommendedDeviceMap: "auto",
          recommendedDtype: "auto",
          recommendedAttention: "eager",
        },
      });
    } finally {
      fs.rmSync(cacheDir, { recursive: true, force: true });
    }
  });

  it("rejects unsupported CLI arguments", () => {
    const cacheDir = makeTempDir();

    try {
      const completed = spawnSync(BRIDGE_BINARY, [
        "--action", "probe",
        "--model", "qwen3",
        "--cache-dir", cacheDir,
        "--unsupported-adapter", process.execPath,
      ], {
        cwd: ROOT_DIR,
        encoding: "utf-8",
      });

      expect(completed.status).not.toBe(0);
      expect(completed.stderr).toContain("unexpected argument");
    } finally {
      fs.rmSync(cacheDir, { recursive: true, force: true });
    }
  });

  it("serves WebSocket requests directly from Rust and reports invalid payloads without model downloads", async () => {
    await withServeWsBridge("qwen3", async ({ port, child, readStderr }) => {
      const socket = await openWebSocketWithRetry(`ws://127.0.0.1:${port}/test-token`, child);
      const result = await new Promise<Record<string, unknown>>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error(`Timed out waiting for result. ${readStderr()}`)), 5_000);
        socket.addEventListener("message", (event) => {
          if (event.data instanceof ArrayBuffer) return;
          const parsed = JSON.parse(String(event.data)) as Record<string, unknown>;
          if (parsed.type === "result") {
            clearTimeout(timeout);
            resolve(parsed);
          }
        });
        socket.addEventListener("error", () => {
          clearTimeout(timeout);
          reject(new Error(`WebSocket error. ${readStderr()}`));
        });
        socket.send(JSON.stringify({ requestId: "rust-ws-invalid", payload: {} }));
      });

      expect(result).toMatchObject({
        type: "result",
        requestId: "rust-ws-invalid",
        ok: false,
      });
      expect(String(result.error)).toMatch(/Invalid Qwen3 payload/i);
      socket.send(JSON.stringify({ command: "shutdown" }));
      socket.close();
    });
  });

  it("rejects unauthorized WebSocket upgrades with an HTTP error response", async () => {
    await withServeWsBridge("qwen3", async ({ port }) => {
      const response = await readRawSocketResponse(
        port,
        [
          "GET /wrong-token HTTP/1.1",
          "Host: 127.0.0.1",
          "Upgrade: websocket",
          "Connection: Upgrade",
          "Sec-WebSocket-Version: 13",
          `Sec-WebSocket-Key: ${randomBytes(16).toString("base64")}`,
          "",
          "",
        ].join("\r\n"),
        (buffer) => buffer.includes(Buffer.from("\r\n\r\n")),
      );

      expect(response.toString("latin1")).toMatch(/^HTTP\/1\.1 401 Unauthorized/i);
    });
  });

  it("handles a request frame sent in the same packet as the upgrade", async () => {
    await withServeWsBridge("qwen3", async ({ port }) => {
      const request = Buffer.concat([
        Buffer.from([
          "GET /test-token HTTP/1.1",
          "Host: 127.0.0.1",
          "Upgrade: websocket",
          "Connection: Upgrade",
          "Sec-WebSocket-Version: 13",
          `Sec-WebSocket-Key: ${randomBytes(16).toString("base64")}`,
          "",
          "",
        ].join("\r\n"), "utf-8"),
        buildMaskedTextFrame(JSON.stringify({ requestId: "pipelined-invalid", payload: {} })),
      ]);

      const response = await readRawSocketResponse(
        port,
        request,
        (buffer) => buffer.includes(Buffer.from("pipelined-invalid")),
      );

      expect(response.toString("latin1")).toContain("HTTP/1.1 101 Switching Protocols");
      expect(response.toString("utf-8")).toContain("pipelined-invalid");
    });
  });
});
