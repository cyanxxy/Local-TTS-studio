import { useEffect } from "react";
import { attachLibraryChatterboxClips } from "../lib/voiceLibrary/chatterboxLibrary";
import { getVoiceLibraryStore } from "../lib/voiceLibrary/store";

/** Keeps saved Chatterbox clones available to the engine for the life of the app session. */
export function useLibraryChatterboxClips(): void {
  useEffect(() => attachLibraryChatterboxClips(getVoiceLibraryStore()), []);
}
