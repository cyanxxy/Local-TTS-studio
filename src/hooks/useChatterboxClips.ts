import { useSyncExternalStore } from "react";
import { getChatterboxClips, subscribeChatterboxClips } from "../lib/chatterboxClips";

/** The reference clips loaded this session, newest last. */
export function useChatterboxClips() {
  return useSyncExternalStore(subscribeChatterboxClips, getChatterboxClips, getChatterboxClips);
}
