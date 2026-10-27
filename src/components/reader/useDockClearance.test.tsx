import { render } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DOCK_CLEARANCE_PROPERTY, useDockClearance } from "./useDockClearance";

function Page({ enabled = true }: { enabled?: boolean }) {
  const pageRef = useRef<HTMLDivElement>(null);
  const dockHostRef = useRef<HTMLDivElement>(null);
  useDockClearance(pageRef, dockHostRef, enabled);
  return (
    <div ref={pageRef} data-testid="page">
      <div ref={dockHostRef} className="contents">
        <div data-testid="dock" />
      </div>
    </div>
  );
}

describe("useDockClearance", () => {
  afterEach(() => vi.restoreAllMocks());

  it("publishes how much of the viewport bottom the dock covers", () => {
    vi.spyOn(document.documentElement, "clientHeight", "get").mockReturnValue(600);
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      top: 397, bottom: 576, left: 48, right: 752, width: 704, height: 179, x: 48, y: 397, toJSON: () => ({}),
    });
    const { getByTestId } = render(<Page />);

    // 179px of dock plus its 24px bottom offset.
    expect(getByTestId("page").style.getPropertyValue(DOCK_CLEARANCE_PROPERTY)).toBe("203px");
  });

  it("publishes nothing when the dock sits in the page flow", () => {
    const { getByTestId } = render(<Page enabled={false} />);
    expect(getByTestId("page").style.getPropertyValue(DOCK_CLEARANCE_PROPERTY)).toBe("");
  });
});
