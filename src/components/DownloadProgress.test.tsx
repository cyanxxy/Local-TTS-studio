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
        kokoroState={{ ...idleState, loading: true, downloadProgress: 42 }}
        supertonicState={idleState}
      />,
    );

    expect(screen.getByText("Preparing Model")).toBeInTheDocument();
    expect(
      screen.getByText("Downloads once, then loads from local cache"),
    ).toBeInTheDocument();
    expect(screen.getByText("Kokoro")).toBeInTheDocument();
  });

  it("stays hidden when nothing is loading", () => {
    const { container } = render(
      <DownloadProgress
        kokoroState={idleState}
        supertonicState={idleState}
      />,
    );

    expect(container).toBeEmptyDOMElement();
  });

  it("renders a zero-width bar when progress is zero", () => {
    const { container } = render(
      <DownloadProgress
        kokoroState={{ ...idleState, loading: true, downloadProgress: 0 }}
        supertonicState={idleState}
      />,
    );

    const bar = container.querySelector(".progress-animated");
    expect(bar).toHaveStyle({ width: "0%" });
  });
});
