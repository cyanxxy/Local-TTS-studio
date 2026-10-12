import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { WHOLE_SCRIPT_TARGET, type StudioTakeAudio, type UseStudioTakesReturn } from "../hooks/useStudioTakes";
import { createTakeStack, addTake } from "../lib/takes";
import { StudioTakesPanel } from "./StudioTakesPanel";

function audio(): StudioTakeAudio {
  return { samples: new Float32Array(200).fill(0.25), sampleRate: 100 };
}

function makeTakes(overrides: Partial<UseStudioTakesReturn> = {}): UseStudioTakesReturn {
  let stack = createTakeStack<StudioTakeAudio>("segment-1");
  stack = addTake(stack, { id: "t1", seed: 11, createdAt: 1, label: "Seed 11", audio: audio() }, { activate: false });
  stack = addTake(stack, { id: "t2", seed: 12, createdAt: 2, label: "Seed 12", audio: audio() }, { activate: false });
  return {
    targets: [
      { id: WHOLE_SCRIPT_TARGET, label: "Whole script", text: "Hello world." },
      { id: "segment-1", label: "Passage 1: Hello world.", text: "Hello world." },
    ],
    stacks: { "segment-1": stack },
    applied: { "segment-1": "t1" },
    seedControl: true,
    unavailableReason: null,
    rendering: null,
    error: null,
    auditioningTakeId: null,
    renderVariations: vi.fn(async () => undefined),
    cancel: vi.fn(),
    pickTake: vi.fn(),
    audition: vi.fn(),
    stopAudition: vi.fn(),
    removeTake: vi.fn(),
    pinTake: vi.fn(),
    ...overrides,
  };
}

function setup(takes: UseStudioTakesReturn, props: Partial<React.ComponentProps<typeof StudioTakesPanel>> = {}) {
  render(<StudioTakesPanel takes={takes} activeSegmentId="segment-1" {...props} />);
  fireEvent.click(screen.getByRole("button", { name: /Variations$/ }));
}

describe("StudioTakesPanel", () => {
  it("renders three variations of the selected passage", () => {
    const takes = makeTakes();
    setup(takes);
    expect(screen.getByRole("combobox", { name: "Passage" })).toHaveValue("segment-1");
    fireEvent.click(screen.getByRole("button", { name: "Variations ×3" }));
    expect(takes.renderVariations).toHaveBeenCalledWith("segment-1", 3);
  });

  it("lets the user pick the whole script instead", () => {
    const takes = makeTakes();
    setup(takes);
    fireEvent.change(screen.getByRole("combobox", { name: "Passage" }), { target: { value: WHOLE_SCRIPT_TARGET } });
    fireEvent.click(screen.getByRole("button", { name: "Variations ×3" }));
    expect(takes.renderVariations).toHaveBeenCalledWith(WHOLE_SCRIPT_TARGET, 3);
  });

  it("auditions, picks, pins and removes takes and marks the one in the timeline", () => {
    const takes = makeTakes();
    setup(takes);
    expect(screen.getByText("In timeline")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Listen to Seed 12" }));
    expect(takes.audition).toHaveBeenCalledWith("segment-1", "t2");
    fireEvent.click(screen.getByRole("button", { name: "Use Seed 12" }));
    expect(takes.pickTake).toHaveBeenCalledWith("segment-1", "t2");
    fireEvent.click(screen.getByRole("button", { name: "Pin Seed 12" }));
    expect(takes.pinTake).toHaveBeenCalledWith("segment-1", "t2", true);
    fireEvent.click(screen.getByRole("button", { name: "Remove Seed 12" }));
    expect(takes.removeTake).toHaveBeenCalledWith("segment-1", "t2");
  });

  it("offers Stop for the take being auditioned", () => {
    const takes = makeTakes({ auditioningTakeId: "t1" });
    setup(takes);
    fireEvent.click(screen.getByRole("button", { name: "Stop Seed 11" }));
    expect(takes.stopAudition).toHaveBeenCalled();
  });

  it("shows progress with a cancel while rendering and disables the passage picker", () => {
    const takes = makeTakes({ rendering: { targetId: "segment-1", done: 1, total: 3 } });
    setup(takes);
    expect(screen.getByRole("combobox", { name: "Passage" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: /Cancel \(1\/3\)/ }));
    expect(takes.cancel).toHaveBeenCalled();
  });

  it("explains an engine without a seed, an unavailable engine, errors and a busy studio", () => {
    setup(makeTakes({ seedControl: false, error: "Render failed." }));
    expect(screen.getByText(/no seed; takes differ by a small change/)).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("Render failed.");
  });

  it("disables rendering when the engine cannot vary or Studio is generating", () => {
    setup(makeTakes({ unavailableReason: "Audio8 has no seed or speed control to vary takes with." }));
    expect(screen.getByRole("button", { name: "Variations ×3" })).toBeDisabled();
    expect(screen.getByText(/Audio8 has no seed/)).toBeInTheDocument();
  });

  it("disables rendering while Studio generates", () => {
    setup(makeTakes(), { disabled: true });
    expect(screen.getByRole("button", { name: "Variations ×3" })).toBeDisabled();
  });
});
