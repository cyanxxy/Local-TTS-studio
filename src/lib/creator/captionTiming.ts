import { postProcessChunks, type PostProcessingOptions } from "../audio/postProcess";
import type { StoredAudioChunk } from "../audioTimeline";

/**
 * The chunks with their times moved to where an export with these finishing
 * options puts them (trimmed edges, padding, fades), so captions line up with
 * the exported file. Chunks at different sample rates, or no options, keep the
 * times they were generated with.
 */
export function retimeChunksForExport(
  chunks: readonly StoredAudioChunk[],
  post: PostProcessingOptions | undefined,
): readonly StoredAudioChunk[] {
  if (!post || chunks.length === 0) return chunks;
  const sampleRate = chunks[0].samplingRate;
  if (chunks.some((chunk) => chunk.samplingRate !== sampleRate)) return chunks;

  const { timings } = postProcessChunks(
    chunks.map((chunk) => ({ audio: chunk.audio, pauseAfterSec: chunk.pauseAfterSec })),
    sampleRate,
    post,
  );
  return chunks.map((chunk, index) => {
    const timing = timings[index];
    return {
      ...chunk,
      startSec: timing.speechStartSec,
      endSec: timing.endSec,
      pauseAfterSec: timing.endSec - timing.speechEndSec,
    };
  });
}
