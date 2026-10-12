import { createContext, useContext } from "react";
import type { SynthesisSession } from "./useSynthesisSessionState";

export const SynthesisSessionContext = createContext<SynthesisSession | null>(null);

/** The session the surfaces share; only valid under `SynthesisSessionProvider`. */
export function useSynthesisSession(): SynthesisSession {
  const session = useContext(SynthesisSessionContext);
  if (!session) throw new Error("useSynthesisSession must be used inside SynthesisSessionProvider.");
  return session;
}
