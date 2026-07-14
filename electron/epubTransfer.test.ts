import { describe, expect, it } from "vitest";
import { EpubTransferAssembler, parseEpubTransferDescriptor } from "./epubTransfer";

describe("EPUB transfer assembly", () => {
  it("recognizes a staged zero-byte EPUB instead of treating it as no transfer", () => {
    expect(parseEpubTransferDescriptor("transfer-0", 0)).toEqual({
      transferId: "transfer-0",
      byteLength: 0,
    });
    const assembler = new EpubTransferAssembler(0);
    expect(assembler.accept({ done: true })).toBe(true);
    expect(assembler.output).toHaveLength(0);
  });

  it("accepts ArrayBuffer chunks and verifies all bytes before completion", () => {
    const assembler = new EpubTransferAssembler(4);
    expect(assembler.accept({ offset: 0, chunk: new Uint8Array([1, 2]).buffer })).toBe(false);
    expect(assembler.accept({ offset: 2, chunk: new Uint8Array([3, 4]) })).toBe(false);
    expect(assembler.accept({ done: true })).toBe(true);
    expect([...assembler.output]).toEqual([1, 2, 3, 4]);
  });

  it("rejects done before the declared byte length arrives", () => {
    const assembler = new EpubTransferAssembler(4);
    assembler.accept({ offset: 0, chunk: new Uint8Array([1, 2]) });
    expect(() => assembler.accept({ done: true })).toThrow("incomplete (2 of 4 bytes)");
  });

  it("rejects missing, overlapping, and malformed chunks immediately", () => {
    const assembler = new EpubTransferAssembler(4);
    expect(() => assembler.accept({ offset: 1, chunk: new Uint8Array([1]) })).toThrow("missing or out-of-order");
    expect(() => assembler.accept({ offset: 0, chunk: "not bytes" })).toThrow("invalid chunk");
  });

  it("rejects partial or invalid transfer descriptors", () => {
    expect(parseEpubTransferDescriptor(undefined, undefined)).toBeNull();
    expect(() => parseEpubTransferDescriptor("transfer", undefined)).toThrow("metadata was invalid");
    expect(() => parseEpubTransferDescriptor("", 10)).toThrow("metadata was invalid");
  });
});
