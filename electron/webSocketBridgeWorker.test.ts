// @vitest-environment node

import type { ChildProcessWithoutNullStreams } from "child_process";
import { createHash } from "crypto";
import { EventEmitter } from "events";
import net from "net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BRIDGE_RESULT_PREFIX } from "./localTtsIpc";
import {
  createWebSocketBridgeWorkerPool,
  type WebSocketWorkerSpawnConfig,
  type WebSocketWorkerSpawnRuntimeConfig,
} from "./webSocketBridgeWorker";

class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  killed = false;
  killSignals: Array<string | undefined> = [];
  onKill: (() => void) | null = null;
  stdin = {
    write: () => true,
    end: () => {},
  };

  kill = (signal?: string) => {
    this.killed = true;
    this.killSignals.push(signal);
    this.onKill?.();
    return true;
  };

  emitStdout(text: string) {
    this.stdout.emit("data", Buffer.from(text, "utf-8"));
  }

  emitStderr(text: string) {
    this.stderr.emit("data", Buffer.from(text, "utf-8"));
  }

  exit(code = 0) {
    this.emit("exit", code);
    this.emit("close", code);
  }
}

class FakeWebSocketServer {
  readonly messages: Array<Record<string, unknown>> = [];
  private readonly server = net.createServer((socket) => this.handleConnection(socket));
  private socket: net.Socket | null = null;
  private buffer = Buffer.alloc(0);
  private handshaken = false;

  constructor(
    private readonly host: string,
    private readonly port: number,
    private readonly expectedPath: string,
    private readonly onListening: (port: number) => void,
    private readonly onMessage?: (message: Record<string, unknown>, server: FakeWebSocketServer) => void,
  ) {
    this.server.on("listening", () => {
      const address = this.server.address();
      if (typeof address === "object" && address?.port) {
        this.onListening(address.port);
      } else {
        this.onListening(port);
      }
    });
    this.server.listen(port, host);
  }

  close() {
    this.socket?.destroy();
    this.server.close();
  }

  sendJson(payload: Record<string, unknown>) {
    const socket = this.socket;
    if (!socket) throw new Error("No WebSocket client connected.");
    const body = Buffer.from(JSON.stringify(payload), "utf-8");
    const header = body.length < 126
      ? Buffer.from([0x81, body.length])
      : body.length <= 0xFFFF
        ? Buffer.concat([Buffer.from([0x81, 126]), Buffer.from([(body.length >> 8) & 0xFF, body.length & 0xFF])])
        : (() => {
            const extended = Buffer.alloc(8);
            extended.writeBigUInt64BE(BigInt(body.length), 0);
            return Buffer.concat([Buffer.from([0x81, 127]), extended]);
          })();
    socket.write(Buffer.concat([header, body]));
  }

  sendBinary(payload: Buffer) {
    const socket = this.socket;
    if (!socket) throw new Error("No WebSocket client connected.");
    const header = payload.length < 126
      ? Buffer.from([0x82, payload.length])
      : payload.length <= 0xFFFF
        ? Buffer.concat([Buffer.from([0x82, 126]), Buffer.from([(payload.length >> 8) & 0xFF, payload.length & 0xFF])])
        : (() => {
            const extended = Buffer.alloc(8);
            extended.writeBigUInt64BE(BigInt(payload.length), 0);
            return Buffer.concat([Buffer.from([0x82, 127]), extended]);
          })();
    socket.write(Buffer.concat([header, payload]));
  }

  private handleConnection(socket: net.Socket) {
    this.socket = socket;
    socket.on("data", (chunk) => this.handleData(chunk));
  }

  private handleData(chunk: Buffer) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    if (!this.handshaken) {
      const headerEnd = this.buffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) return;
      const header = this.buffer.subarray(0, headerEnd).toString("latin1");
      const requestPath = /^GET\s+(\S+)\s+HTTP\/1\.1$/im.exec(header)?.[1];
      if (requestPath !== this.expectedPath) {
        this.socket?.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
        this.socket?.destroy();
        return;
      }
      const key = /^Sec-WebSocket-Key:\s*(.+)$/im.exec(header)?.[1]?.trim();
      if (!key || !this.socket) throw new Error("Missing WebSocket key.");
      const accept = createHash("sha1")
        .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
        .digest("base64");
      this.socket.write(
        "HTTP/1.1 101 Switching Protocols\r\n"
        + "Upgrade: websocket\r\n"
        + "Connection: Upgrade\r\n"
        + `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
      );
      this.buffer = this.buffer.subarray(headerEnd + 4);
      this.handshaken = true;
    }
    this.readFrames();
  }

  private readFrames() {
    while (this.buffer.length >= 2) {
      const first = this.buffer[0];
      const second = this.buffer[1];
      const opcode = first & 0x0F;
      const masked = (second & 0x80) !== 0;
      let length = second & 0x7F;
      let offset = 2;

      if (length === 126) {
        if (this.buffer.length < offset + 2) return;
        length = this.buffer.readUInt16BE(offset);
        offset += 2;
      } else if (length === 127) {
        if (this.buffer.length < offset + 8) return;
        length = Number(this.buffer.readBigUInt64BE(offset));
        offset += 8;
      }

      const maskOffset = offset;
      if (masked) offset += 4;
      if (this.buffer.length < offset + length) return;

      let payload = this.buffer.subarray(offset, offset + length);
      if (masked) {
        const mask = this.buffer.subarray(maskOffset, maskOffset + 4);
        payload = Buffer.from(payload.map((byte, index) => byte ^ mask[index % 4]));
      }
      this.buffer = this.buffer.subarray(offset + length);

      if (opcode !== 0x1) continue;
      const parsed = JSON.parse(payload.toString("utf-8")) as Record<string, unknown>;
      this.messages.push(parsed);
      this.onMessage?.(parsed, this);
    }
  }
}

// The pool is generic over its model literal; Rust local runtimes share the
// exact same WebSocket transport, so the harness is parametrized too.
type TestModel = "neutts" | "qwen3";

const SPAWN_CONFIG: WebSocketWorkerSpawnConfig = {
  bridgeBinary: "/app/dist-rust/open-tts-local-bridge",
  cacheDir: "/cache/qwen3",
  env: { PATH: "/usr/bin" },
};

const RUN_DEFAULTS = {
  idleTimeoutMs: 30_000,
  maxStdoutBytes: 1_000_000,
  maxStderrBytes: 1_000_000,
  onProgress: () => {},
  onAudioChunk: () => {},
};

function makePool(
  onMessage?: (message: Record<string, unknown>, server: FakeWebSocketServer) => void,
) {
  const children: FakeChild[] = [];
  const servers: FakeWebSocketServer[] = [];
  const spawnModels: TestModel[] = [];
  const spawn = vi.fn((model: TestModel, config: WebSocketWorkerSpawnRuntimeConfig) => {
    const child = new FakeChild();
    const server = new FakeWebSocketServer(
      config.host,
      config.port,
      `/${config.authToken}`,
      (port) => child.emitStdout(`__PORT__${port}\n`),
      onMessage,
    );
    child.onKill = () => server.close();
    children.push(child);
    servers.push(server);
    spawnModels.push(model);
    return child as unknown as ChildProcessWithoutNullStreams;
  });
  const pool = createWebSocketBridgeWorkerPool<TestModel>({
    spawn,
    idleEvictMs: 60_000,
    killGraceMs: 2_000,
    connectTimeoutMs: 5_000,
  });
  return { pool, spawn, children, servers, spawnModels };
}

async function waitFor(assertion: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    if (assertion()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for condition.");
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sendAudioChunk(
  server: FakeWebSocketServer,
  requestId: unknown,
  options: {
    index?: number;
    total?: number;
    sampleRate?: number;
    sampleCount?: number;
  } = {},
) {
  const sampleCount = options.sampleCount ?? 2;
  server.sendJson({
    type: "audio_chunk",
    requestId,
    index: options.index ?? 0,
    total: options.total ?? 1,
    sampleRate: options.sampleRate ?? 24000,
    sampleCount,
    silenceAfterSamples: 0,
  });
  server.sendBinary(Buffer.alloc(sampleCount * Float32Array.BYTES_PER_ELEMENT));
}

afterEach(() => {
  vi.useRealTimers();
});

describe("createWebSocketBridgeWorkerPool", () => {
  it("sends generation requests and progress over a resident WebSocket", async () => {
    const { pool, spawn } = makePool((message, server) => {
      server.sendJson({ type: "progress", requestId: message.requestId, phase: "inference", message: "working" });
      server.sendJson({
        type: "audio_chunk",
        requestId: message.requestId,
        index: 0,
        total: 1,
        sampleRate: 24000,
        sampleCount: 2,
        silenceAfterSamples: 0,
      });
      const audio = Buffer.alloc(2 * Float32Array.BYTES_PER_ELEMENT);
      new DataView(audio.buffer, audio.byteOffset, audio.byteLength).setFloat32(0, 0.5, true);
      new DataView(audio.buffer, audio.byteOffset, audio.byteLength).setFloat32(4, -0.25, true);
      server.sendBinary(audio);
      server.sendJson({
        type: "result",
        requestId: message.requestId,
        ok: true,
        result: {
          audioTransport: "websocket-binary",
          audioChunkCount: 1,
          sampleRate: 24000,
          modelRepo: "R",
          durationSec: 1,
          elapsedSec: 2,
          phaseTimingsSec: { modelLoadSec: 0, inferenceSec: 1.9, outputEncodingSec: 0.1 },
        },
      });
    });
    const progress: unknown[] = [];
    const audioChunks: unknown[] = [];

    const first = await pool.run("qwen3", {
      ...RUN_DEFAULTS,
      requestId: "r1",
      payload: { text: "one" },
      spawnConfig: SPAWN_CONFIG,
      onProgress: (payload) => progress.push(payload),
      onAudioChunk: (payload) => audioChunks.push(payload),
    });
    const second = await pool.run("qwen3", {
      ...RUN_DEFAULTS,
      requestId: "r2",
      payload: { text: "two" },
      spawnConfig: SPAWN_CONFIG,
    });

    expect(spawn).toHaveBeenCalledTimes(1);
    expect(progress).toHaveLength(1);
    expect(audioChunks).toHaveLength(1);
    expect(audioChunks[0]).toMatchObject({ requestId: "r1", sampleRate: 24000, sampleCount: 2 });
    expect(first.response).toMatchObject({ ok: true, requestId: "r1" });
    expect(second.response).toMatchObject({ ok: true, requestId: "r2" });
  });

  it("runs warm commands whose results carry no streamed audio and reuses the worker for generation", async () => {
    const { pool, spawn } = makePool((message, server) => {
      if (message.command === "warm") {
        server.sendJson({
          type: "result",
          requestId: message.requestId,
          ok: true,
          result: { warmed: true, message: "resident" },
        });
        return;
      }
      sendAudioChunk(server, message.requestId);
      server.sendJson({
        type: "result",
        requestId: message.requestId,
        ok: true,
        result: {
          audioTransport: "websocket-binary",
          audioChunkCount: 1,
          sampleRate: 24000,
          modelRepo: "R",
          durationSec: 1,
          elapsedSec: 2,
          phaseTimingsSec: {},
        },
      });
    });

    const warm = await pool.run("qwen3", {
      ...RUN_DEFAULTS,
      requestId: "warm-1",
      command: "warm",
      payload: { baseModelPath: "/models/qwen3" },
      spawnConfig: SPAWN_CONFIG,
    });
    expect(warm.response).toMatchObject({
      ok: true,
      requestId: "warm-1",
      result: { warmed: true },
    });

    // The warmed worker stays resident and serves the next generation.
    const generated = await pool.run("qwen3", {
      ...RUN_DEFAULTS,
      requestId: "r1",
      payload: { text: "one" },
      spawnConfig: SPAWN_CONFIG,
    });
    expect(generated.response).toMatchObject({ ok: true, requestId: "r1" });
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it("spawns an independent worker per model and streams binary audio for neutts and qwen3", async () => {
    const { pool, spawn, spawnModels } = makePool((message, server) => {
      const repo = (message.payload as { modelRepo?: string }).modelRepo ?? "R";
      server.sendJson({
        type: "audio_chunk",
        requestId: message.requestId,
        index: 0,
        total: 1,
        sampleRate: 24000,
        sampleCount: 2,
        silenceAfterSamples: 0,
      });
      const audio = Buffer.alloc(2 * Float32Array.BYTES_PER_ELEMENT);
      const view = new DataView(audio.buffer, audio.byteOffset, audio.byteLength);
      view.setFloat32(0, 0.5, true);
      view.setFloat32(4, -0.25, true);
      server.sendBinary(audio);
      server.sendJson({
        type: "result",
        requestId: message.requestId,
        ok: true,
        result: {
          audioTransport: "websocket-binary",
          audioChunkCount: 1,
          sampleRate: 24000,
          modelRepo: repo,
          durationSec: 1,
          elapsedSec: 2,
          phaseTimingsSec: { modelLoadSec: 0, inferenceSec: 1.9, outputEncodingSec: 0.1 },
        },
      });
    });

    const models = ["neutts", "qwen3"] as const;
    const chunksByModel: Record<string, unknown[]> = { neutts: [], qwen3: [] };
    const results = await Promise.all(
      models.map((model, index) =>
        pool.run(model, {
          ...RUN_DEFAULTS,
          requestId: `${model}-r${index}`,
          payload: { text: model, modelRepo: model },
          spawnConfig: SPAWN_CONFIG,
          onAudioChunk: (payload) => chunksByModel[model].push(payload),
        }),
      ),
    );

    // Each model gets its own resident worker (keyed independently in the pool).
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(new Set(spawnModels)).toEqual(new Set(models));
    expect(chunksByModel.neutts).toHaveLength(1);
    expect(chunksByModel.qwen3).toHaveLength(1);
    expect(chunksByModel.neutts[0]).toMatchObject({ requestId: "neutts-r0", sampleRate: 24000, sampleCount: 2 });
    expect(chunksByModel.qwen3[0]).toMatchObject({ requestId: "qwen3-r1", sampleRate: 24000, sampleCount: 2 });
    expect(results[0].response).toMatchObject({ ok: true, result: { modelRepo: "neutts" } });
    expect(results[1].response).toMatchObject({ ok: true, result: { modelRepo: "qwen3" } });
  });

  it("accepts streamed audio chunks with an unknown total and validates the final result count", async () => {
    const { pool } = makePool((message, server) => {
      sendAudioChunk(server, message.requestId, { index: 0, total: 0 });
      sendAudioChunk(server, message.requestId, { index: 1, total: 0 });
      server.sendJson({
        type: "result",
        requestId: message.requestId,
        ok: true,
        result: {
          audioTransport: "websocket-binary",
          audioChunkCount: 2,
          sampleRate: 24000,
          modelRepo: "mlx-community/Qwen3-TTS-12Hz-0.6B-Base-6bit",
          durationSec: 1,
          elapsedSec: 2,
          phaseTimingsSec: { modelLoadSec: 0, inferenceSec: 2 },
        },
      });
    });
    const audioChunks: unknown[] = [];

    await expect(pool.run("qwen3", {
      ...RUN_DEFAULTS,
      requestId: "r-stream",
      payload: { text: "stream" },
      spawnConfig: SPAWN_CONFIG,
      onAudioChunk: (payload) => audioChunks.push(payload),
    })).resolves.toMatchObject({
      response: { ok: true, result: { audioChunkCount: 2 } },
    });
    expect(audioChunks).toHaveLength(2);
    expect(audioChunks[0]).toMatchObject({ index: 0, total: 0 });
    expect(audioChunks[1]).toMatchObject({ index: 1, total: 0 });
  });

  it("does not resolve Qwen3 generation from legacy stdout result lines", async () => {
    const { pool, children, servers } = makePool();
    const run = pool.run("qwen3", {
      ...RUN_DEFAULTS,
      requestId: "r1",
      payload: { text: "hello" },
      spawnConfig: SPAWN_CONFIG,
    });

    await waitFor(() => servers[0]?.messages.length === 1);
    children[0].emitStdout(`${BRIDGE_RESULT_PREFIX}${JSON.stringify({
      ok: true,
      result: { wavBase64: "STDOUT", sampleRate: 24000, modelRepo: "R", durationSec: 1, elapsedSec: 1 },
    })}\n`);

    await expect(Promise.race([
      run.then(() => "resolved"),
      new Promise((resolve) => setTimeout(() => resolve("pending"), 25)),
    ])).resolves.toBe("pending");

    sendAudioChunk(servers[0], "r1");
    servers[0].sendJson({
      type: "result",
      requestId: "r1",
      ok: true,
      result: {
        audioTransport: "websocket-binary",
        audioChunkCount: 1,
        sampleRate: 24000,
        modelRepo: "R",
        durationSec: 1,
        elapsedSec: 1,
        phaseTimingsSec: { modelLoadSec: 0, inferenceSec: 0.9, outputEncodingSec: 0.1 },
      },
    });
    await expect(run).resolves.toMatchObject({
      response: { ok: true, result: { audioTransport: "websocket-binary" } },
    });
  });

  it("stops a silent worker after the idle timeout with a no-output error", async () => {
    const { pool, servers, children } = makePool();
    const run = pool.run("qwen3", {
      ...RUN_DEFAULTS,
      idleTimeoutMs: 100,
      requestId: "r1",
      payload: { text: "silent" },
      spawnConfig: SPAWN_CONFIG,
    });

    await waitFor(() => servers[0]?.messages.length === 1);
    // The worker connects and receives the request but never emits output or a
    // socket frame, so the inactivity watchdog must fire and kill it.
    await expect(run).rejects.toThrow(/no output/i);
    expect(children[0].killed).toBe(true);
  });

  it("keeps a long-running request alive while the bridge emits a stderr heartbeat", async () => {
    const { pool, children, servers } = makePool();
    const run = pool.run("qwen3", {
      ...RUN_DEFAULTS,
      idleTimeoutMs: 200,
      requestId: "r1",
      payload: { text: "long" },
      spawnConfig: SPAWN_CONFIG,
    });

    await waitFor(() => servers[0]?.messages.length === 1);

    // Emit the bridge's stderr heartbeat before the original 200ms deadline; it
    // must re-arm the watchdog so the request survives past that deadline.
    await delay(120);
    children[0].emitStderr(" ");
    await delay(120); // now well past the original 200ms deadline measured from start

    await expect(Promise.race([
      run.then(() => "resolved"),
      delay(0).then(() => "pending"),
    ])).resolves.toBe("pending");
    expect(children[0].killed).toBe(false);

    // A real result still completes the request normally.
    sendAudioChunk(servers[0], "r1");
    servers[0].sendJson({
      type: "result",
      requestId: "r1",
      ok: true,
      result: {
        audioTransport: "websocket-binary",
        audioChunkCount: 1,
        sampleRate: 24000,
        modelRepo: "R",
        durationSec: 1,
        elapsedSec: 1,
        phaseTimingsSec: { modelLoadSec: 0, inferenceSec: 0.9, outputEncodingSec: 0.1 },
      },
    });
    await expect(run).resolves.toMatchObject({ response: { ok: true, requestId: "r1" } });
  });

  it("rejects successful results when the streamed audio chunk count is incomplete", async () => {
    const { pool, children, servers } = makePool((message, server) => {
      sendAudioChunk(server, message.requestId, { index: 0, total: 2 });
      server.sendJson({
        type: "result",
        requestId: message.requestId,
        ok: true,
        result: {
          audioTransport: "websocket-binary",
          audioChunkCount: 2,
          sampleRate: 24000,
          modelRepo: "R",
          durationSec: 1,
          elapsedSec: 1,
          phaseTimingsSec: { modelLoadSec: 0, inferenceSec: 1 },
        },
      });
    });

    await expect(pool.run("qwen3", {
      ...RUN_DEFAULTS,
      requestId: "r1",
      payload: { text: "partial" },
      spawnConfig: SPAWN_CONFIG,
    })).rejects.toThrow("chunk count");
    expect(children[0].killed).toBe(true);
    servers[0].close();
  });

  it("rejects out-of-sequence audio chunk metadata before accepting binary audio", async () => {
    const { pool, children, servers } = makePool((message, server) => {
      server.sendJson({
        type: "audio_chunk",
        requestId: message.requestId,
        index: 1,
        total: 2,
        sampleRate: 24000,
        sampleCount: 2,
        silenceAfterSamples: 0,
      });
    });

    await expect(pool.run("qwen3", {
      ...RUN_DEFAULTS,
      requestId: "r1",
      payload: { text: "bad order" },
      spawnConfig: SPAWN_CONFIG,
    })).rejects.toThrow("out of sequence");
    expect(children[0].killed).toBe(true);
    servers[0].close();
  });

  it("rejects audio chunks that change sample rate mid-stream", async () => {
    const { pool, children, servers } = makePool((message, server) => {
      sendAudioChunk(server, message.requestId, { index: 0, total: 2, sampleRate: 24000 });
      server.sendJson({
        type: "audio_chunk",
        requestId: message.requestId,
        index: 1,
        total: 2,
        sampleRate: 44100,
        sampleCount: 2,
        silenceAfterSamples: 0,
      });
    });

    await expect(pool.run("qwen3", {
      ...RUN_DEFAULTS,
      requestId: "r1",
      payload: { text: "bad rate" },
      spawnConfig: SPAWN_CONFIG,
    })).rejects.toThrow(/sample rate/i);
    expect(children[0].killed).toBe(true);
    servers[0].close();
  });

  it("rejects a final result whose sample rate does not match streamed audio", async () => {
    const { pool, children, servers } = makePool((message, server) => {
      sendAudioChunk(server, message.requestId, { sampleRate: 24000 });
      server.sendJson({
        type: "result",
        requestId: message.requestId,
        ok: true,
        result: {
          audioTransport: "websocket-binary",
          audioChunkCount: 1,
          sampleRate: 44100,
          modelRepo: "R",
          durationSec: 1,
          elapsedSec: 1,
          phaseTimingsSec: {},
        },
      });
    });

    await expect(pool.run("qwen3", {
      ...RUN_DEFAULTS,
      requestId: "r1",
      payload: { text: "bad final rate" },
      spawnConfig: SPAWN_CONFIG,
    })).rejects.toThrow(/sample rate/i);
    expect(children[0].killed).toBe(true);
    servers[0].close();
  });

  it("rejects audio chunk metadata with excessive trailing silence", async () => {
    const { pool, children, servers } = makePool((message, server) => {
      server.sendJson({
        type: "audio_chunk",
        requestId: message.requestId,
        index: 0,
        total: 1,
        sampleRate: 24000,
        sampleCount: 2,
        silenceAfterSamples: 48_000 * 60 + 1,
      });
    });

    await expect(pool.run("qwen3", {
      ...RUN_DEFAULTS,
      requestId: "r1",
      payload: { text: "bad silence" },
      spawnConfig: SPAWN_CONFIG,
    })).rejects.toThrow(/silence/i);
    expect(children[0].killed).toBe(true);
    servers[0].close();
  });

  it("cancels a request while its worker is still spawning", async () => {
    // The bridge never announces its port, so the run stays in the spawn phase.
    const children: FakeChild[] = [];
    const spawn = vi.fn(() => {
      const child = new FakeChild();
      children.push(child);
      return child as unknown as ChildProcessWithoutNullStreams;
    });
    const pool = createWebSocketBridgeWorkerPool<TestModel>({
      spawn,
      idleEvictMs: 60_000,
      killGraceMs: 2_000,
      connectTimeoutMs: 5_000,
    });

    const run = pool.run("qwen3", {
      ...RUN_DEFAULTS,
      requestId: "r1",
      payload: {},
      spawnConfig: SPAWN_CONFIG,
    });
    run.catch(() => {});

    expect(spawn).toHaveBeenCalledTimes(1);
    expect(pool.cancel("r1")).toBe(true);
    expect(children[0].killed).toBe(true);
    children[0].exit(null as unknown as number);
    await expect(run).rejects.toThrow(/cancelled/i);
    // The request id is released for reuse after the cancelled run settles.
    expect(pool.isRunning("r1")).toBe(false);
  });

  it("rejects a duplicate request id while the original request is still spawning", async () => {
    const children: FakeChild[] = [];
    const spawn = vi.fn(() => {
      const child = new FakeChild();
      children.push(child);
      return child as unknown as ChildProcessWithoutNullStreams;
    });
    const pool = createWebSocketBridgeWorkerPool<TestModel>({
      spawn,
      idleEvictMs: 60_000,
      killGraceMs: 2_000,
      connectTimeoutMs: 5_000,
    });

    const run = pool.run("neutts", {
      ...RUN_DEFAULTS,
      requestId: "r1",
      payload: {},
      spawnConfig: SPAWN_CONFIG,
    });
    run.catch(() => {});

    // The duplicate-id guard must see ids registered before the spawn await,
    // even when the duplicate arrives for a different model.
    await expect(pool.run("qwen3", {
      ...RUN_DEFAULTS,
      requestId: "r1",
      payload: {},
      spawnConfig: SPAWN_CONFIG,
    })).rejects.toThrow(/already running/i);
    expect(spawn).toHaveBeenCalledTimes(1);

    expect(pool.cancel("r1")).toBe(true);
    children[0].exit(null as unknown as number);
    await expect(run).rejects.toThrow(/cancelled/i);
  });

  it("kills workers that are still spawning when the pool shuts down", async () => {
    const children: FakeChild[] = [];
    const spawn = vi.fn(() => {
      const child = new FakeChild();
      children.push(child);
      return child as unknown as ChildProcessWithoutNullStreams;
    });
    const pool = createWebSocketBridgeWorkerPool<TestModel>({
      spawn,
      idleEvictMs: 60_000,
      killGraceMs: 2_000,
      connectTimeoutMs: 5_000,
    });

    const run = pool.run("qwen3", {
      ...RUN_DEFAULTS,
      requestId: "r1",
      payload: {},
      spawnConfig: SPAWN_CONFIG,
    });
    run.catch(() => {});

    expect(spawn).toHaveBeenCalledTimes(1);
    const shutdown = pool.shutdownAll();
    expect(children[0].killed).toBe(true);
    children[0].exit(null as unknown as number);
    await shutdown;
    await expect(run).rejects.toThrow(/Failed to start Rust local bridge worker/);
  });

  it("kills a single model's spawning worker via shutdown(model)", async () => {
    const children: FakeChild[] = [];
    const spawn = vi.fn(() => {
      const child = new FakeChild();
      children.push(child);
      return child as unknown as ChildProcessWithoutNullStreams;
    });
    const pool = createWebSocketBridgeWorkerPool<TestModel>({
      spawn,
      idleEvictMs: 60_000,
      killGraceMs: 2_000,
      connectTimeoutMs: 5_000,
    });

    const run = pool.run("neutts", {
      ...RUN_DEFAULTS,
      requestId: "r1",
      payload: {},
      spawnConfig: SPAWN_CONFIG,
    });
    run.catch(() => {});

    const shutdown = pool.shutdown("neutts");
    expect(children[0].killed).toBe(true);
    children[0].exit(null as unknown as number);
    await expect(shutdown).resolves.toBe(true);
    await expect(run).rejects.toThrow(/Failed to start Rust local bridge worker/);
  });

  it("reports a startup exit instead of a connect timeout when the bridge dies before connecting", async () => {
    const spawn = vi.fn(() => {
      const child = new FakeChild();
      setTimeout(() => {
        // Announce a port nobody listens on, then exit before the first
        // connection attempt can even fail.
        child.emitStdout("__PORT__1\n");
        child.exit(1);
      }, 0);
      return child as unknown as ChildProcessWithoutNullStreams;
    });
    const pool = createWebSocketBridgeWorkerPool<TestModel>({
      spawn,
      idleEvictMs: 60_000,
      killGraceMs: 2_000,
      connectTimeoutMs: 5_000,
    });

    await expect(pool.run("qwen3", {
      ...RUN_DEFAULTS,
      requestId: "r1",
      payload: {},
      spawnConfig: SPAWN_CONFIG,
    })).rejects.toThrow(/exited during startup|exited before announcing/i);
  });

  it("cancels an in-flight request by killing the WebSocket worker", async () => {
    const { pool, children, servers } = makePool();
    const run = pool.run("qwen3", {
      ...RUN_DEFAULTS,
      requestId: "r1",
      payload: {},
      spawnConfig: SPAWN_CONFIG,
    });

    await waitFor(() => servers[0]?.messages.length === 1);
    expect(pool.cancel("r1")).toBe(true);
    expect(children[0].killed).toBe(true);
    children[0].exit(null as unknown as number);
    await expect(run).rejects.toThrow(/cancelled/i);
  });

  it("rejects a concurrent generate for a model whose worker is already mid-request", async () => {
    // No onMessage, so the first request never receives a result and stays the
    // worker's active request while the second generate arrives.
    const { pool, spawn, servers } = makePool();
    const first = pool.run("qwen3", {
      ...RUN_DEFAULTS,
      requestId: "r1",
      payload: { text: "one" },
      spawnConfig: SPAWN_CONFIG,
    });
    first.catch(() => {});

    // Wait until the worker is fully connected (active set, startingModels
    // cleared) so the second run trips the active-worker guard, not the
    // still-spawning guard.
    await waitFor(() => servers[0]?.messages.length === 1);
    await expect(pool.run("qwen3", {
      ...RUN_DEFAULTS,
      requestId: "r2",
      payload: { text: "two" },
      spawnConfig: SPAWN_CONFIG,
    })).rejects.toThrow(/already running/i);
    expect(spawn).toHaveBeenCalledTimes(1);

    pool.cancel("r1");
    servers[0].close();
    await expect(first).rejects.toThrow();
  });

  it("rejects an audio chunk whose declared sample count exceeds the maximum", async () => {
    const { pool, children, servers } = makePool((message, server) => {
      server.sendJson({
        type: "audio_chunk",
        requestId: message.requestId,
        index: 0,
        total: 1,
        sampleRate: 48000,
        sampleCount: 48_000 * 600 + 1,
        silenceAfterSamples: 0,
      });
    });

    await expect(pool.run("qwen3", {
      ...RUN_DEFAULTS,
      requestId: "r1",
      payload: { text: "huge" },
      spawnConfig: SPAWN_CONFIG,
    })).rejects.toThrow(/maximum sample count/);
    expect(children[0].killed).toBe(true);
    servers[0].close();
  });

  it("rejects a frame stamped with a different request id", async () => {
    const { pool, children, servers } = makePool((_message, server) => {
      server.sendJson({ type: "progress", requestId: "someone-else", phase: "inference", message: "x" });
    });

    await expect(pool.run("qwen3", {
      ...RUN_DEFAULTS,
      requestId: "r1",
      payload: { text: "x" },
      spawnConfig: SPAWN_CONFIG,
    })).rejects.toThrow(/unexpected request/);
    expect(children[0].killed).toBe(true);
    servers[0].close();
  });

  it("rejects request-scoped frames that omit the request id", async () => {
    const { pool, children, servers } = makePool((_message, server) => {
      server.sendJson({
        type: "result",
        ok: true,
        result: {
          audioTransport: "websocket-binary",
          audioChunkCount: 1,
          sampleRate: 24000,
          modelRepo: "R",
          durationSec: 1,
          elapsedSec: 1,
          phaseTimingsSec: {},
        },
      });
    });

    await expect(pool.run("qwen3", {
      ...RUN_DEFAULTS,
      requestId: "r1",
      payload: { text: "x" },
      spawnConfig: SPAWN_CONFIG,
    })).rejects.toThrow(/request id/i);
    expect(children[0].killed).toBe(true);
    servers[0].close();
  });

  it("rejects a second audio chunk metadata frame before the pending binary frame", async () => {
    const { pool, children, servers } = makePool((message, server) => {
      server.sendJson({
        type: "audio_chunk",
        requestId: message.requestId,
        index: 0,
        total: 2,
        sampleRate: 24000,
        sampleCount: 2,
        silenceAfterSamples: 0,
      });
      // Second metadata frame with no binary in between.
      server.sendJson({
        type: "audio_chunk",
        requestId: message.requestId,
        index: 1,
        total: 2,
        sampleRate: 24000,
        sampleCount: 2,
        silenceAfterSamples: 0,
      });
    });

    await expect(pool.run("qwen3", {
      ...RUN_DEFAULTS,
      requestId: "r1",
      payload: { text: "x" },
      spawnConfig: SPAWN_CONFIG,
    })).rejects.toThrow(/metadata before the pending binary frame/);
    expect(children[0].killed).toBe(true);
    servers[0].close();
  });

  it("rejects a result frame that arrives before the pending audio binary frame", async () => {
    const { pool, children, servers } = makePool((message, server) => {
      server.sendJson({
        type: "audio_chunk",
        requestId: message.requestId,
        index: 0,
        total: 1,
        sampleRate: 24000,
        sampleCount: 2,
        silenceAfterSamples: 0,
      });
      // Result before the announced binary frame is delivered.
      server.sendJson({
        type: "result",
        requestId: message.requestId,
        ok: true,
        result: {
          audioTransport: "websocket-binary",
          audioChunkCount: 1,
          sampleRate: 24000,
          modelRepo: "R",
          durationSec: 1,
          elapsedSec: 1,
          phaseTimingsSec: {},
        },
      });
    });

    await expect(pool.run("qwen3", {
      ...RUN_DEFAULTS,
      requestId: "r1",
      payload: { text: "x" },
      spawnConfig: SPAWN_CONFIG,
    })).rejects.toThrow(/result before the pending audio binary frame/);
    expect(children[0].killed).toBe(true);
    servers[0].close();
  });

  it("rejects a binary frame that arrives without preceding metadata", async () => {
    const { pool, children, servers } = makePool((_message, server) => {
      server.sendBinary(Buffer.alloc(2 * Float32Array.BYTES_PER_ELEMENT));
    });

    await expect(pool.run("qwen3", {
      ...RUN_DEFAULTS,
      requestId: "r1",
      payload: { text: "x" },
      spawnConfig: SPAWN_CONFIG,
    })).rejects.toThrow(/binary frame without metadata/);
    expect(children[0].killed).toBe(true);
    servers[0].close();
  });

  it("rejects a binary frame whose length does not match the declared sample count", async () => {
    const { pool, children, servers } = makePool((message, server) => {
      server.sendJson({
        type: "audio_chunk",
        requestId: message.requestId,
        index: 0,
        total: 1,
        sampleRate: 24000,
        sampleCount: 4,
        silenceAfterSamples: 0,
      });
      // Declared 4 samples (16 bytes) but ship 12 bytes.
      server.sendBinary(Buffer.alloc(12));
    });

    await expect(pool.run("qwen3", {
      ...RUN_DEFAULTS,
      requestId: "r1",
      payload: { text: "x" },
      spawnConfig: SPAWN_CONFIG,
    })).rejects.toThrow(/unexpected byte length/);
    expect(children[0].killed).toBe(true);
    servers[0].close();
  });
});
