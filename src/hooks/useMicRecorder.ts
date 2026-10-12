import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  createMicRecorder,
  toMicRecorderError,
  type MicLevel,
  type MicRecorder,
  type MicRecorderError,
  type MicRecorderOptions,
  type MicRecorderState,
  type MicRecording,
} from "../lib/micRecorder";

export interface UseMicRecorderOptions {
  deviceId?: string;
  maxDurationSec?: number;
  preferMediaRecorder?: boolean;
  /** Recorder factory; must be stable (a module-level function). Tests pass fakes. */
  createRecorder?: (options: MicRecorderOptions) => MicRecorder;
}

export interface UseMicRecorderReturn {
  state: MicRecorderState;
  /** Latest input level while recording, for a meter. */
  level: MicLevel | null;
  /** The last finished recording, whether stopped by the user or automatically. */
  recording: MicRecording | null;
  error: MicRecorderError | null;
  start: () => Promise<void>;
  /** Resolves with the recording, or null when stopping failed (see `error`). */
  stop: () => Promise<MicRecording | null>;
  cancel: () => void;
  /** Forget the last recording and error. */
  reset: () => void;
}

/**
 * React state around one mic recorder. The recorder is rebuilt when the
 * device or limits change, and cancelled on unmount so the microphone is
 * always released.
 */
export function useMicRecorder(options: UseMicRecorderOptions = {}): UseMicRecorderReturn {
  const { deviceId, maxDurationSec, preferMediaRecorder, createRecorder = createMicRecorder } = options;
  const [state, setState] = useState<MicRecorderState>("idle");
  const [level, setLevel] = useState<MicLevel | null>(null);
  const [recording, setRecording] = useState<MicRecording | null>(null);
  const [error, setError] = useState<MicRecorderError | null>(null);
  const recorderRef = useRef<MicRecorder | null>(null);

  useEffect(() => {
    const recorder = createRecorder({
      deviceId,
      maxDurationSec,
      preferMediaRecorder,
      onStateChange: setState,
      onLevel: setLevel,
      onAutoStop: (result) => {
        setLevel(null);
        if ("recording" in result) setRecording(result.recording);
        else setError(result.error);
      },
    });
    recorderRef.current = recorder;
    return () => {
      recorder.cancel();
      if (recorderRef.current === recorder) recorderRef.current = null;
    };
  }, [createRecorder, deviceId, maxDurationSec, preferMediaRecorder]);

  const start = useCallback(async () => {
    const recorder = recorderRef.current;
    if (!recorder) return;
    setError(null);
    setRecording(null);
    setLevel(null);
    try {
      await recorder.start();
    } catch (cause) {
      const failure = toMicRecorderError(cause);
      // Cancelling a pending start is the user's own choice, not an error.
      if (failure.code !== "cancelled") setError(failure);
    }
  }, []);

  const stop = useCallback(async () => {
    const recorder = recorderRef.current;
    if (!recorder) return null;
    try {
      const result = await recorder.stop();
      setRecording(result);
      return result;
    } catch (cause) {
      const failure = toMicRecorderError(cause);
      if (failure.code !== "cancelled") setError(failure);
      return null;
    } finally {
      setLevel(null);
    }
  }, []);

  const cancel = useCallback(() => {
    recorderRef.current?.cancel();
    setLevel(null);
  }, []);

  const reset = useCallback(() => {
    setRecording(null);
    setError(null);
  }, []);

  return useMemo(
    () => ({ state, level, recording, error, start, stop, cancel, reset }),
    [cancel, error, level, recording, reset, start, state, stop],
  );
}
