// @vitest-environment node

import { describe, expect, it } from "vitest";
import {
  NativeOutputTail,
  nativeOutputExcerpt,
  redactSecret,
  sanitizeNativeOutput,
  withNativeOutput,
} from "./nativeOutput";

describe("NativeOutputTail", () => {
  it("keeps only the most recent characters", () => {
    const tail = new NativeOutputTail(8);
    tail.append(Buffer.from("first line\n"));
    tail.append("second");

    expect(tail.text).toBe("e\nsecond");
  });

  it("decodes a UTF-8 character split across chunks", () => {
    const tail = new NativeOutputTail();
    const bytes = Buffer.from("naïve 🎧", "utf-8");

    tail.append(bytes.subarray(0, 3));
    tail.append(bytes.subarray(3, bytes.length - 2));
    tail.append(bytes.subarray(bytes.length - 2));

    expect(tail.text).toBe("naïve 🎧");
  });

  it("ignores a chunk that only starts a character", () => {
    const tail = new NativeOutputTail();
    tail.append(Buffer.from([0xf0, 0x9f]));

    expect(tail.text).toBe("");
  });
});

describe("sanitizeNativeOutput", () => {
  it("removes terminal escape sequences", () => {
    expect(sanitizeNativeOutput("\x1b[1;31merror\x1b[0m: failed")).toBe("error: failed");
    expect(sanitizeNativeOutput("\x1b]0;window title\x07ready")).toBe("ready");
    expect(sanitizeNativeOutput("\x1b]8;;https://example.com\x1b\\link\x1b]8;;\x1b\\")).toBe("link");
    expect(sanitizeNativeOutput("\x1b7saved\x1b8")).toBe("saved");
    expect(sanitizeNativeOutput("dangling\x1b")).toBe("dangling");
  });

  it("reduces carriage-return redraws to what the terminal would finally show", () => {
    expect(sanitizeNativeOutput("loading 10%\rloading 50%\rloading 100%\ndone\r\n"))
      .toBe("loading 100%\ndone\n");
    expect(sanitizeNativeOutput("progress\r")).toBe("progress");
  });

  it("replaces other control characters but keeps tabs and newlines", () => {
    expect(sanitizeNativeOutput("a\x00b\x08c\td\ne\x7ff\x9bg")).toBe("a b c\td\ne f g");
  });

  it("drops lone surrogates left by a tail that was cut mid-character", () => {
    expect(sanitizeNativeOutput("\udc8ehead and tail\ud83c")).toBe("head and tail");
    expect(sanitizeNativeOutput("pair 🎧 kept")).toBe("pair 🎧 kept");
  });
});

describe("nativeOutputExcerpt", () => {
  it("keeps the last lines and drops blank ones, such as heartbeats", () => {
    const output = ["one", "two", " ", "", "three", "four"].join("\n");

    expect(nativeOutputExcerpt(output, { maxLines: 3 })).toBe("two\nthree\nfour");
  });

  it("caps the length from the end, where a panic lands", () => {
    expect(nativeOutputExcerpt("aaaa\nbbbb\ncccc", { maxChars: 9 })).toBe("bbbb\ncccc");
  });

  it("keeps the end of a single over-long last line", () => {
    expect(nativeOutputExcerpt(`start ${"x".repeat(20)} end`, { maxChars: 8 })).toBe("…xxx end");
  });

  it("is empty when there is nothing but whitespace", () => {
    expect(nativeOutputExcerpt("  \n\t\n")).toBe("");
  });
});

describe("withNativeOutput", () => {
  it("appends a sanitized excerpt to the failure message", () => {
    expect(withNativeOutput("Bridge exited.", "\x1b[31mpanicked\x1b[0m at main.rs\n"))
      .toBe("Bridge exited.\nNative output:\npanicked at main.rs");
  });

  it("leaves the message alone when the process printed nothing useful", () => {
    expect(withNativeOutput("Bridge exited.", " \n \n")).toBe("Bridge exited.");
  });

  it("leaves out an excerpt the renderer would mistake for a deliberate stop", () => {
    expect(withNativeOutput("Bridge exited.", "inference CANCELLED by allocator")).toBe("Bridge exited.");
  });
});

describe("redactSecret", () => {
  it("replaces every occurrence of the secret", () => {
    expect(redactSecret("GET /tok123 then /tok123/x", "tok123")).toBe("GET /[redacted] then /[redacted]/x");
  });

  it("returns the text unchanged for an empty secret", () => {
    expect(redactSecret("unchanged", "")).toBe("unchanged");
  });
});
