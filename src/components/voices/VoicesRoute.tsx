import { useMemo } from "react";
import { useQwen3Runtime } from "../../contexts/Qwen3RuntimeContext";
import { useVoiceLibrary } from "../../hooks/useVoiceLibrary";
import { usePresetVoiceEngine } from "../../hooks/usePresetSynthesize";
import { useSynthesisSession } from "../../shared/synthesisSessionContext";
import { VoicesPage } from "./VoicesPage";

/** The Voice Library page wired to the live session: its engines, voices and Qwen3 setup. */
export function VoicesRoute() {
  const { engines, voices } = useSynthesisSession();
  const qwen3 = useQwen3Runtime();
  const library = useVoiceLibrary();
  const { synthesize, renderKey } = usePresetVoiceEngine();
  const kokoroVoices = engines.kokoroVoices;
  const runtimeVoices = useMemo(() => ({ kokoro: kokoroVoices }), [kokoroVoices]);
  const designInstalled = qwen3.available && qwen3.profiles.some((profile) => (
    profile.mode === "voiceDesign"
    && qwen3.setup?.profiles.some((entry) => entry.repo === profile.repo && entry.readiness !== "missing")
  ));

  return (
    <VoicesPage
      library={library}
      runtimeVoices={runtimeVoices}
      synthesize={synthesize}
      renderKey={renderKey}
      apply={voices.apply}
      designAvailable={designInstalled}
      designUnavailableReason={qwen3.available
        ? "Install the Qwen3 VoiceDesign model in Qwen3 model setup to design voices."
        : "Voice design runs on the Qwen3 engine, which needs the desktop app and its model."}
    />
  );
}
