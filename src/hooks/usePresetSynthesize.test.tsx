import { renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { SynthesisSessionContext } from "../shared/synthesisSessionContext";
import type { SynthesisSession } from "../shared/useSynthesisSessionState";
import { usePresetSynthesize } from "./usePresetSynthesize";

vi.mock("../contexts/Qwen3RuntimeContext", () => ({
  useQwen3Runtime: () => ({ profiles: [], setup: null }),
}));

function sessionWith(synthesize: ReturnType<typeof vi.fn>, speed: number): SynthesisSession {
  return {
    engines: {
      runtimes: { kokoro: { synthesize } },
      surfaceEngineSettings: { kokoro: { voice: "af_heart" } },
    },
    creator: { generationSettings: { speed, quality: 5 } },
  } as unknown as SynthesisSession;
}

describe("usePresetSynthesize", () => {
  it("keeps one identity while always rendering with the latest session settings", async () => {
    const synthesize = vi.fn(async function* () {
      yield { audio: new Float32Array([0.5]), samplingRate: 24000 };
    });
    let current = sessionWith(synthesize, 1);
    const wrapper = ({ children }: { children: ReactNode }) => (
      <SynthesisSessionContext.Provider value={current}>{children}</SynthesisSessionContext.Provider>
    );
    const { result, rerender } = renderHook(() => usePresetSynthesize(), { wrapper });
    const first = result.current;

    current = sessionWith(synthesize, 1.4);
    rerender();
    expect(result.current).toBe(first);

    const chunks = [];
    for await (const chunk of first("Hi.", { engineId: "kokoro", voiceId: "bm_george", settings: {} }, new AbortController().signal)) {
      chunks.push(chunk);
    }
    expect(chunks).toHaveLength(1);
    expect(synthesize).toHaveBeenCalledWith(expect.objectContaining({ tuning: { speed: 1.4, quality: 5 } }));
  });
});
