import type { ReactNode } from "react";
import { AudioExportContext } from "../components/AudioExportContext";
import { SynthesisSessionContext } from "./synthesisSessionContext";
import { useSynthesisSessionState, type SynthesisSessionOptions } from "./useSynthesisSessionState";

/**
 * Creates the session every surface shares. Consumers re-render as the player
 * and the engines change, exactly as the single component that used to own all
 * of it did.
 */
export function SynthesisSessionProvider({
  children,
  ...options
}: SynthesisSessionOptions & { children: ReactNode }) {
  const session = useSynthesisSessionState(options);
  return (
    <SynthesisSessionContext.Provider value={session}>
      <AudioExportContext.Provider value={session.player.audioExport}>{children}</AudioExportContext.Provider>
    </SynthesisSessionContext.Provider>
  );
}
