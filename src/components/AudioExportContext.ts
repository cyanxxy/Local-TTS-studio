import { createContext } from "react";
import type { UseAudioExportReturn } from "../hooks/useAudioExport";

/**
 * The running audio export, so any download button can show its progress and
 * turn into Cancel without the state being passed through every page between
 * the session and the player. Absent outside the session provider.
 */
export const AudioExportContext = createContext<UseAudioExportReturn | null>(null);
