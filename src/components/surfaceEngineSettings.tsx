import type { ReactNode } from "react";
import type { DesktopInlineEngineId } from "../models/registry";
import type { SynthesisSession } from "../shared/useSynthesisSessionState";
import { Audio8InlineSettings } from "./Audio8InlineSettings";
import { ChatterboxInlineSettings } from "./ChatterboxInlineSettings";
import { Qwen3InlineSettings } from "./Qwen3InlineSettings";
import { Supertonic3InlineSettings } from "./Supertonic3InlineSettings";
import { SupertonicLanguageSettings } from "./SupertonicLanguageSettings";

/**
 * The settings control for the engine a surface runs, or undefined when the
 * engine has none beside the voice menu. Studio and the Reader show the same
 * control for the same engine; only the surface's own selection differs.
 */
export function renderSurfaceEngineSettings(
  session: SynthesisSession,
  desktopModel: DesktopInlineEngineId | null,
  /** Lets an engine's controls add text to the script on screen; Studio supplies it. */
  onInsertTag?: (tag: string) => void,
): ReactNode {
  const { engines, routing } = session;
  switch (desktopModel) {
    case "audio8":
      return (
        <Audio8InlineSettings
          voice={engines.audio8Voice}
          onVoiceChange={engines.changeAudio8Voice}
          settings={engines.audio8Settings}
          onSamplingChange={engines.changeAudio8Sampling}
          cacheInfo={engines.audio8.cacheInfo}
          cacheBusy={engines.audio8.cacheBusy}
          cacheStatus={engines.audio8.cacheStatus}
          onClearCache={engines.audio8.clearCache}
        />
      );
    case "qwen3":
      return <Qwen3InlineSettings onOpenSetup={() => routing.navigate("qwen3")} />;
    case "supertonic3":
      return (
        <Supertonic3InlineSettings
          voice={engines.supertonic3Voice}
          language={engines.supertonic3Language}
          onVoiceChange={engines.changeSupertonic3Voice}
          onLanguageChange={engines.changeSupertonic3Language}
          seed={engines.supertonic3Seed}
          onSeedChange={engines.changeSupertonic3Seed}
        />
      );
    default:
      if (engines.activeModel === "chatterbox") {
        return (
          <ChatterboxInlineSettings
            settings={engines.chatterbox}
            onChange={engines.changeChatterbox}
            modelState={engines.currentModelState}
            onInsertTag={onInsertTag}
          />
        );
      }
      return engines.activeModel === "supertonic"
        ? (
          <SupertonicLanguageSettings
            language={engines.supertonicLanguage}
            onChange={engines.changeSupertonicLanguage}
          />
        )
        : undefined;
  }
}
