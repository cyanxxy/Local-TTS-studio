/**
 * Messages between the mic recorder and its AudioWorklet processor. This file
 * is imported by both sides, so it must stay free of DOM-only code: the
 * worklet scope has no window, document or timers.
 */

export const MIC_CAPTURE_PROCESSOR_NAME = "open-tts-mic-capture";

/** Frames per batch posted from the audio thread (about 43 ms at 48 kHz). */
export const MIC_CAPTURE_BATCH_FRAMES = 2048;

/** Main thread to processor: send what is buffered, then go idle. */
export interface MicCaptureFlushMessage {
  type: "flush";
}

/** Processor to main thread: a batch of mono samples. */
export interface MicCaptureSamplesMessage {
  type: "samples";
  samples: Float32Array;
}

/** Processor to main thread: everything captured has been posted. */
export interface MicCaptureFlushedMessage {
  type: "flushed";
}

export type MicCaptureOutboundMessage = MicCaptureSamplesMessage | MicCaptureFlushedMessage;
