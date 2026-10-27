import { useMemo, type ReactNode } from "react";
import { AudioExportContext } from "../components/AudioExportContext";
import { SynthesisSessionContext, SynthesisShellContext, type SynthesisShellState } from "./synthesisSessionContext";
import { useSynthesisSessionState, type SynthesisSessionOptions } from "./useSynthesisSessionState";

/**
 * Creates the session every surface shares. Consumers of the whole session
 * re-render as the player and the engines change, exactly as the single
 * component that used to own all of it did. The app shell reads its own
 * slice, which changes only when the page, the settings or the header's
 * notices do.
 */
export function SynthesisSessionProvider({
  children,
  ...options
}: SynthesisSessionOptions & { children: ReactNode }) {
  const session = useSynthesisSessionState(options);
  const { appSettings, chrome, environment, preferences, routing } = session;
  const studioDesktopModel = session.studio.desktopModel;
  const shell = useMemo<SynthesisShellState>(
    () => ({ appSettings, chrome, environment, preferences, routing, studioDesktopModel }),
    [appSettings, chrome, environment, preferences, routing, studioDesktopModel],
  );
  return (
    <SynthesisSessionContext.Provider value={session}>
      <SynthesisShellContext.Provider value={shell}>
        <AudioExportContext.Provider value={session.player.audioExport}>{children}</AudioExportContext.Provider>
      </SynthesisShellContext.Provider>
    </SynthesisSessionContext.Provider>
  );
}
