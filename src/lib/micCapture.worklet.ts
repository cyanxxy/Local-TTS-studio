import {
  MIC_CAPTURE_BATCH_FRAMES,
  MIC_CAPTURE_PROCESSOR_NAME,
  type MicCaptureFlushMessage,
  type MicCaptureOutboundMessage,
} from "./micCaptureProtocol";

/**
 * AudioWorklet processor for the mic recorder: downmixes each render quantum
 * to mono and posts it to the main thread in batches, so the audio thread
 * never allocates per quantum and the main thread is not woken 375 times a
 * second. It runs in AudioWorkletGlobalScope, which the DOM typings do not
 * describe, hence the local declarations.
 */

declare class AudioWorkletProcessor {
  readonly port: MessagePort;
}

declare function registerProcessor(name: string, processor: new () => AudioWorkletProcessor): void;

export class MicCaptureProcessor extends AudioWorkletProcessor {
  private buffer = new Float32Array(MIC_CAPTURE_BATCH_FRAMES);
  private filled = 0;
  private active = true;

  constructor() {
    super();
    this.port.onmessage = (event: MessageEvent<MicCaptureFlushMessage>) => {
      if (event.data?.type !== "flush") return;
      this.postBuffered();
      this.active = false;
      this.post({ type: "flushed" });
    };
  }

  private post(message: MicCaptureOutboundMessage, transfer: Transferable[] = []): void {
    this.port.postMessage(message, transfer);
  }

  private postBuffered(): void {
    if (this.filled === 0) return;
    const samples = this.buffer.slice(0, this.filled);
    this.post({ type: "samples", samples }, [samples.buffer]);
    this.filled = 0;
  }

  process(inputs: Float32Array[][]): boolean {
    if (!this.active) return false;
    const channels = inputs[0] ?? [];
    const frames = channels[0]?.length ?? 0;
    const scale = channels.length > 0 ? 1 / channels.length : 0;
    for (let frame = 0; frame < frames; frame += 1) {
      let sum = 0;
      for (const channel of channels) sum += channel[frame];
      this.buffer[this.filled] = sum * scale;
      this.filled += 1;
      if (this.filled === this.buffer.length) {
        // Transferring hands the buffer to the main thread; start a new one.
        const samples = this.buffer;
        this.buffer = new Float32Array(MIC_CAPTURE_BATCH_FRAMES);
        this.filled = 0;
        this.post({ type: "samples", samples }, [samples.buffer]);
      }
    }
    return true;
  }
}

registerProcessor(MIC_CAPTURE_PROCESSOR_NAME, MicCaptureProcessor);
