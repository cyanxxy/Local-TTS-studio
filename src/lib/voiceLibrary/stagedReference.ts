import { useSyncExternalStore } from "react";
import type { VoiceCloneTarget } from "./types";

/**
 * A clone reference handed from the Voice Library to an engine page. Qwen3's
 * reference lives in its runtime context and is set directly; NeuTTS and
 * Chatterbox keep theirs in page or worker state, so the library stages the
 * reference here and the engine takes it when it mounts or when it changes.
 */
export interface StagedReference {
  voiceId: string;
  name: string;
  target: VoiceCloneTarget;
  wavBase64: string;
  /** Exactly what the clip says; empty for a reference that needs no transcript. */
  transcript: string;
  language: string;
  durationSec: number;
  sha256: string;
}

const staged = new Map<VoiceCloneTarget, StagedReference>();
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of [...listeners]) listener();
}

export function stageReference(reference: StagedReference): void {
  staged.set(reference.target, reference);
  notify();
}

export function getStagedReference(target: VoiceCloneTarget): StagedReference | null {
  return staged.get(target) ?? null;
}

export function clearStagedReference(target: VoiceCloneTarget): void {
  if (staged.delete(target)) notify();
}

export function subscribeStagedReferences(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** The reference staged for `target`; it changes identity only when a new one is staged. */
export function useStagedReference(target: VoiceCloneTarget): StagedReference | null {
  return useSyncExternalStore(
    subscribeStagedReferences,
    () => getStagedReference(target),
    () => null,
  );
}

/** Test seam: forget everything staged. */
export function resetStagedReferences(): void {
  staged.clear();
  notify();
}

/** Standard base64 of WAV bytes, in slices that stay under the argument limit. */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const slice = 0x8000;
  for (let index = 0; index < bytes.length; index += slice) {
    binary += String.fromCharCode(...bytes.subarray(index, index + slice));
  }
  return btoa(binary);
}
