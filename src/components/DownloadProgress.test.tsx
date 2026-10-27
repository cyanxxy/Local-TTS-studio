import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DownloadProgress } from "./DownloadProgress";
import type { ModelState } from "../types";

const idleState: ModelState = {
  ready: false,
  loading: false,
  downloadProgress: 0,
  error: null,
  backend: null,
};

describe("DownloadProgress", () => {
  it("explains that reloads reuse the local cache", () => {
    render(
      <DownloadProgress
        states={{
          kokoro: { ...idleState, loading: true, downloadProgress: 42 },
          supertonic: idleState,
        }}
      />,
    );

    expect(screen.getByText("Preparing Model")).toBeInTheDocument();
    expect(
      screen.getByText("Downloads once"),
    ).toBeInTheDocument();
    expect(screen.getByText("Kokoro")).toBeInTheDocument();
  });

  it("stays hidden when nothing is loading", () => {
    const { container } = render(
      <DownloadProgress states={{ kokoro: idleState, supertonic: idleState }} />,
    );

    expect(container).toBeEmptyDOMElement();
  });

  it("renders a zero-width bar when progress is zero", () => {
    const { container } = render(
      <DownloadProgress
        states={{ kokoro: { ...idleState, loading: true, downloadProgress: 0 }, supertonic: idleState }}
      />,
    );

    // The fill slides in by transform (no layout per tick); empty means fully off the track.
    const bar = container.querySelector(".bg-accent");
    expect(bar).toHaveStyle({ transform: "translateX(-100%)" });
  });

  it("shows Electron-only Supertonic 3 preparation", () => {
    render(
      <DownloadProgress
        states={{
          kokoro: idleState,
          supertonic: idleState,
          supertonic3: { ...idleState, loading: true, downloadProgress: 25 },
        }}
      />,
    );

    expect(screen.getByText("Supertonic 3")).toBeInTheDocument();
    expect(screen.getByText("25%")).toBeInTheDocument();
  });

  it("names every preparing engine from the registry, in picker order, and keeps failures visible", () => {
    render(
      <DownloadProgress
        states={{
          supertonic3: { ...idleState, error: "Worker crashed" },
          kokoro: { ...idleState, loading: true, downloadProgress: 60 },
          supertonic: { ...idleState, ready: true, error: "stale" },
        }}
      />,
    );

    const names = screen.getAllByText(/^(Kokoro|Supertonic|Supertonic 3)$/).map((node) => node.textContent);
    expect(names).toEqual(["Kokoro", "Supertonic 3"]);
    expect(screen.getByText("Failed")).toBeInTheDocument();
  });
});
