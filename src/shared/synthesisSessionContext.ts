import { createContext, useContext } from "react";
import type { SynthesisSession } from "./useSynthesisSessionState";

export const SynthesisSessionContext = createContext<SynthesisSession | null>(null);

/** The session the surfaces share; only valid under `SynthesisSessionProvider`. */
export function useSynthesisSession(): SynthesisSession {
  const session = useContext(SynthesisSessionContext);
  if (!session) throw new Error("useSynthesisSession must be used inside SynthesisSessionProvider.");
  return session;
}

/** The part of the session the app shell (header, page tabs, footer, settings) reads. */
export interface SynthesisShellState extends Pick<SynthesisSession, "appSettings" | "chrome" | "environment" | "preferences" | "routing"> {
  /** Studio's desktop engine, which the header's subtitle names. */
  studioDesktopModel: SynthesisSession["studio"]["desktopModel"];
}

export const SynthesisShellContext = createContext<SynthesisShellState | null>(null);

/**
 * The shell's slice of the session; only valid under `SynthesisSessionProvider`.
 * Unlike `useSynthesisSession`, it does not change with the player, the
 * engines' progress or the Studio script, so the shell does not re-render with
 * them.
 */
export function useSynthesisShell(): SynthesisShellState {
  const shell = useContext(SynthesisShellContext);
  if (!shell) throw new Error("useSynthesisShell must be used inside SynthesisSessionProvider.");
  return shell;
}
