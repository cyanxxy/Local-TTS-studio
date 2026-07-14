export interface EpubTransferDescriptor {
  transferId: string;
  byteLength: number;
}

export function parseEpubTransferDescriptor(
  transferId: unknown,
  byteLength: unknown,
): EpubTransferDescriptor | null {
  if (transferId === undefined && byteLength === undefined) return null;
  if (
    typeof transferId !== "string"
    || transferId.length === 0
    || typeof byteLength !== "number"
    || !Number.isSafeInteger(byteLength)
    || byteLength < 0
  ) {
    throw new Error("The EPUB transfer metadata was invalid. Import the file again.");
  }
  return { transferId, byteLength };
}

function toUint8Array(value: unknown): Uint8Array | null {
  if (value instanceof Uint8Array) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  return null;
}

export class EpubTransferAssembler {
  readonly output: Uint8Array;
  private receivedBytes = 0;
  private complete = false;

  constructor(byteLength: number) {
    if (!Number.isSafeInteger(byteLength) || byteLength < 0) {
      throw new Error("The EPUB transfer length was invalid.");
    }
    this.output = new Uint8Array(byteLength);
  }

  accept(message: unknown): boolean {
    if (this.complete) throw new Error("The EPUB transfer sent data after completion.");
    if (!message || typeof message !== "object" || Array.isArray(message)) {
      throw new Error("The EPUB transfer sent an invalid message. Import the file again.");
    }
    const record = message as Record<string, unknown>;
    if (typeof record.error === "string") throw new Error(record.error);

    if (record.done === true) {
      if (this.receivedBytes !== this.output.byteLength) {
        throw new Error(
          `The EPUB transfer was incomplete (${this.receivedBytes} of ${this.output.byteLength} bytes). Import the file again.`,
        );
      }
      this.complete = true;
      return true;
    }

    const offset = record.offset;
    const chunk = toUint8Array(record.chunk);
    if (!Number.isSafeInteger(offset) || typeof offset !== "number" || !chunk) {
      throw new Error("The EPUB transfer sent an invalid chunk. Import the file again.");
    }
    if (offset !== this.receivedBytes) {
      throw new Error("The EPUB transfer contained missing or out-of-order bytes. Import the file again.");
    }
    if (chunk.byteLength === 0 || offset + chunk.byteLength > this.output.byteLength) {
      throw new Error("The EPUB transfer chunk exceeded the expected file size. Import the file again.");
    }

    this.output.set(chunk, offset);
    this.receivedBytes += chunk.byteLength;
    return false;
  }
}
