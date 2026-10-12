import type { ReactNode } from "react";
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
  return <SynthesisSessionContext.Provider value={session}>{children}</SynthesisSessionContext.Provider>;
}
