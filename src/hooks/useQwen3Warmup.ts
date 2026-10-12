import { useEffect, useRef } from "react";
import { useQwen3Runtime } from "../contexts/Qwen3RuntimeContext";

type Qwen3Settings = ReturnType<typeof useQwen3Runtime>;

/**
 * Loads the selected Qwen3 model into the main process's resident worker ahead
 * of the first generation. `active` says whether this surface drives Qwen3 at
 * all, and `busy` holds the warm-up off while a generation is running (it
 * would only queue behind it). Each model folder and profile is warmed once.
 */
export function useQwen3Warmup(
  active: boolean,
  busy: boolean,
  settings: Pick<Qwen3Settings, "modelPath" | "profile" | "readiness">,
): void {
  const warmedKeyRef = useRef<string | null>(null);
  const warmingKeyRef = useRef<string | null>(null);
  const warm = window.electron?.localTts?.warm;
  const { modelPath, profile, readiness } = settings;

  useEffect(() => {
    if (!active || busy || !warm) return;
    const path = modelPath.trim();
    if (!path || readiness === "missing") return;
    const key = `${profile.repo}:${path}`;
    if (warmedKeyRef.current === key || warmingKeyRef.current === key) return;
    warmingKeyRef.current = key;
    let current = true;
    void warm({
      model: "qwen3",
      mode: profile.mode,
      modelPath: path,
      modelRepo: profile.repo,
    }).then((result) => {
      if (current && result.warmed) warmedKeyRef.current = key;
    }).catch(() => undefined).finally(() => {
      if (warmingKeyRef.current === key) warmingKeyRef.current = null;
    });
    return () => { current = false; };
  }, [active, busy, modelPath, profile, readiness, warm]);
}
