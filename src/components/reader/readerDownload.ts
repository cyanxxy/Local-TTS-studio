import type { ReaderAnnotationFile } from "./readerAnnotationExport";

/**
 * Hands a generated text file to the browser's download flow (Electron routes
 * the same anchor download to a save dialog). Kept here rather than imported
 * from the audio exporter so the Reader chunk does not pull in encoders.
 */
export function downloadTextFile({ fileName, mimeType, content }: ReaderAnnotationFile): void {
  const url = URL.createObjectURL(new Blob([content], { type: `${mimeType};charset=utf-8` }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.rel = "noopener";
  anchor.style.display = "none";
  document.body.append(anchor);
  anchor.click();
  window.setTimeout(() => {
    URL.revokeObjectURL(url);
    anchor.remove();
  }, 0);
}
