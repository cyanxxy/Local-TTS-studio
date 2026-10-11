import type { CSSProperties } from "react";
import type { ReaderHighlightColor } from "../../lib/readerDocument";

interface HighlightSwatch {
  label: string;
  /** Solid colour for pickers and list markers. */
  swatch: string;
  /** Translucent wash behind highlighted text, legible on paper, sepia and night. */
  wash: CSSProperties;
}

export const READER_HIGHLIGHT_SWATCHES: Readonly<Record<ReaderHighlightColor, HighlightSwatch>> = {
  yellow: { label: "Yellow", swatch: "#f5c400", wash: { backgroundColor: "rgba(245, 196, 0, 0.32)" } },
  green: { label: "Green", swatch: "#34c759", wash: { backgroundColor: "rgba(52, 199, 89, 0.26)" } },
  blue: { label: "Blue", swatch: "#0a84ff", wash: { backgroundColor: "rgba(10, 132, 255, 0.22)" } },
  pink: { label: "Pink", swatch: "#ff375f", wash: { backgroundColor: "rgba(255, 55, 95, 0.22)" } },
  purple: { label: "Purple", swatch: "#bf5af2", wash: { backgroundColor: "rgba(191, 90, 242, 0.24)" } },
};
