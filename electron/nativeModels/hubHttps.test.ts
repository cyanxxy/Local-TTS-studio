// @vitest-environment node

import type { IncomingMessage } from "http";
import { Readable } from "stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isAllowedHuggingFaceDownloadHost, readHubJson, requestUrl, type UrlRequest } from "./hubHttps";

interface FakeClientRequest {
  url: URL;
  options: { headers?: Record<string, string>; timeout?: number };
  respond: (response: IncomingMessage) => void;
  emit: (event: string, ...args: unknown[]) => boolean;
  ended: boolean;
  destroyedWith: Error | undefined;
}

const mocks = vi.hoisted(() => ({ requests: [] as FakeClientRequest[] }));

// The reader's only network dependency. Each call records the request so a
// test can answer it, time it out, or watch it being destroyed.
vi.mock("https", async () => {
  const { EventEmitter } = await import("node:events");
  return {
    request: (url: URL, options: FakeClientRequest["options"], onResponse: (response: IncomingMessage) => void) => {
      const request = Object.assign(new EventEmitter(), {
        url,
        options,
        respond: onResponse,
        ended: false,
        destroyedWith: undefined as Error | undefined,
        end() {
          request.ended = true;
        },
        destroy(error?: Error) {
          request.destroyedWith = error;
          if (error) request.emit("error", error);
        },
      });
      mocks.requests.push(request);
      return request;
    },
  };
});

function fakeResponse(statusCode: number, headers: Record<string, string> = {}, body = ""): IncomingMessage {
  const response = Readable.from([Buffer.from(body)]) as unknown as IncomingMessage;
  return Object.assign(response, { statusCode, headers, resume: vi.fn(() => response) });
}

function cancelled(): Error {
  return new Error("Example model download cancelled.");
}

async function nextRequest(index: number): Promise<FakeClientRequest> {
  for (let attempt = 0; attempt < 100 && !mocks.requests[index]; attempt += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  const request = mocks.requests[index];
  if (!request) throw new Error(`request ${index} was never issued`);
  return request;
}

afterEach(() => {
  mocks.requests.length = 0;
});

describe("isAllowedHuggingFaceDownloadHost", () => {
  it.each(["huggingface.co", "hf.co", "cdn-lfs.huggingface.co", "cas-bridge.xethub.hf.co", "HuggingFace.CO"])(
    "allows %s",
    (host) => {
      expect(isAllowedHuggingFaceDownloadHost(host)).toBe(true);
    },
  );

  it.each(["evilhuggingface.co", "huggingface.co.example.com", "hf.co.evil", "169.254.169.254", "localhost", ""])(
    "refuses %s",
    (host) => {
      expect(isAllowedHuggingFaceDownloadHost(host)).toBe(false);
    },
  );
});

describe("requestUrl", () => {
  it("speaks only TLS to the allow-list before opening a connection", async () => {
    await expect(requestUrl("http://huggingface.co/model")).rejects.toThrow(/insecure protocol/);
    await expect(requestUrl("https://127.0.0.1/model")).rejects.toThrow("non-HuggingFace host: 127.0.0.1");
    expect(mocks.requests).toHaveLength(0);
  });

  it("identifies itself, bounds connection idle time, and resolves the final response", async () => {
    const pending = requestUrl("https://huggingface.co/repo/resolve/abc/config.json");
    const request = await nextRequest(0);
    const response = fakeResponse(200);

    expect(request.ended).toBe(true);
    expect(request.options).toMatchObject({ headers: { "User-Agent": "Open-TTS/1.0" }, timeout: 30_000 });
    request.respond(response);

    await expect(pending).resolves.toBe(response);
  });

  it("follows a redirect to another Hugging Face host", async () => {
    const pending = requestUrl("https://huggingface.co/repo/resolve/abc/model.onnx");
    const redirect = fakeResponse(302, { location: "https://cdn-lfs.hf.co/blob?sig=1" });
    (await nextRequest(0)).respond(redirect);
    const final = fakeResponse(200);
    const second = await nextRequest(1);
    second.respond(final);

    await expect(pending).resolves.toBe(final);
    expect(second.url.toString()).toBe("https://cdn-lfs.hf.co/blob?sig=1");
    // The redirect body is drained rather than left holding the socket.
    expect(redirect.resume).toHaveBeenCalled();
  });

  it("re-checks every redirect hop against the same rules", async () => {
    const offHost = requestUrl("https://huggingface.co/a");
    (await nextRequest(0)).respond(fakeResponse(302, { location: "https://evil.example/payload" }));
    await expect(offHost).rejects.toThrow("non-HuggingFace host: evil.example");

    const downgraded = requestUrl("https://huggingface.co/b");
    (await nextRequest(1)).respond(fakeResponse(301, { location: "http://huggingface.co/b" }));
    await expect(downgraded).rejects.toThrow(/insecure protocol/);
    expect(mocks.requests).toHaveLength(2);
  });

  it("gives up on a redirect loop", async () => {
    const pending = requestUrl("https://huggingface.co/loop");
    for (let hop = 0; hop <= 8; hop += 1) {
      (await nextRequest(hop)).respond(fakeResponse(302, { location: `https://huggingface.co/loop/${hop}` }));
    }

    await expect(pending).rejects.toThrow("Too many redirects while downloading https://huggingface.co/loop/8");
    expect(mocks.requests).toHaveLength(9);
  });

  it("destroys a connection that stays idle", async () => {
    const pending = requestUrl("https://huggingface.co/slow");
    (await nextRequest(0)).emit("timeout");

    await expect(pending).rejects.toThrow("Timed out connecting to https://huggingface.co/slow");
  });

  it("abandons the request when the caller aborts before the headers arrive", async () => {
    const controller = new AbortController();
    const pending = requestUrl("https://huggingface.co/model", controller.signal);
    const request = await nextRequest(0);
    controller.abort();

    await expect(pending).rejects.toThrow("Hugging Face request cancelled.");
    expect(request.destroyedWith?.message).toBe("Hugging Face request cancelled.");
  });

  it("never opens a connection for an already-aborted caller", async () => {
    await expect(requestUrl("https://huggingface.co/model", AbortSignal.abort())).rejects.toThrow("cancelled");
    expect(mocks.requests).toHaveLength(0);
  });

  it("destroys a request whose caller aborted while its listener was being registered", async () => {
    let checks = 0;
    const signal = {
      get aborted() {
        checks += 1;
        return checks > 1;
      },
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    } as unknown as AbortSignal;

    await expect(requestUrl("https://huggingface.co/model", signal)).rejects.toThrow("Hugging Face request cancelled.");
    expect(mocks.requests[0].ended).toBe(false);
    expect(signal.addEventListener).toHaveBeenCalledWith("abort", expect.any(Function), { once: true });
  });
});

describe("readHubJson", () => {
  const url = "https://huggingface.co/api/models/example/revision/abc";

  function serve(response: IncomingMessage): UrlRequest {
    return () => Promise.resolve(response);
  }

  it("parses a metadata document", async () => {
    await expect(readHubJson(url, { request: serve(fakeResponse(200, {}, '{"siblings":[]}')), cancelledError: cancelled }))
      .resolves.toEqual({ siblings: [] });
  });

  it("reports an error status and drains the body", async () => {
    const response = fakeResponse(404, {}, "missing");

    await expect(readHubJson(url, { request: serve(response), cancelledError: cancelled }))
      .rejects.toThrow("Hugging Face request failed with status 404.");
    expect(response.resume).toHaveBeenCalled();
  });

  it("refuses a response too large to be metadata", async () => {
    const megabyte = Buffer.alloc(1024 * 1024, 0x20);
    const response = Object.assign(Readable.from(Array.from({ length: 25 }, () => megabyte)), {
      statusCode: 200,
      headers: {},
    }) as unknown as IncomingMessage;

    await expect(readHubJson(url, { request: serve(response), cancelledError: cancelled }))
      .rejects.toThrow("Hugging Face model metadata response was too large.");
  });

  it("reports every abort as the model's own cancellation", async () => {
    await expect(readHubJson(url, { request: vi.fn(), signal: AbortSignal.abort(), cancelledError: cancelled }))
      .rejects.toThrow("Example model download cancelled.");

    // The reader rejected in its own words while the caller was aborting.
    const controller = new AbortController();
    const racing: UrlRequest = () => {
      controller.abort();
      return Promise.reject(new Error("Hugging Face request cancelled."));
    };
    await expect(readHubJson(url, { request: racing, signal: controller.signal, cancelledError: cancelled }))
      .rejects.toThrow("Example model download cancelled.");

    // Aborted once the headers arrived: the body is torn down unread.
    const late = new AbortController();
    const response = fakeResponse(200, {}, "{}");
    const destroy = vi.spyOn(response, "destroy");
    const afterHeaders: UrlRequest = () => {
      late.abort();
      return Promise.resolve(response);
    };
    await expect(readHubJson(url, { request: afterHeaders, signal: late.signal, cancelledError: cancelled }))
      .rejects.toThrow("Example model download cancelled.");
    expect(destroy).toHaveBeenCalled();
  });

  it("stops reading a body when the caller aborts mid-stream", async () => {
    const controller = new AbortController();
    const body = new Readable({ read() {} });
    const response = Object.assign(body, { statusCode: 200, headers: {} }) as unknown as IncomingMessage;
    const pending = readHubJson(url, { request: serve(response), signal: controller.signal, cancelledError: cancelled });
    body.push('{"siblings":');
    await new Promise((resolve) => setImmediate(resolve));
    controller.abort();

    await expect(pending).rejects.toThrow("Example model download cancelled.");
    expect(body.destroyed).toBe(true);
  });
});
