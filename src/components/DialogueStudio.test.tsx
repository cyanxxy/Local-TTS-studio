import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { UseDialogueSessionReturn } from "../hooks/useDialogueSession";
import { parseDialogueScript } from "../lib/dialogue/script";
import { autoCastSpeakers, planDialogueRender } from "../lib/dialogue/plan";
import type { DialogueRenderStep } from "../lib/dialogue/plan";
import type { VoicePreset } from "../lib/voiceLibrary/types";
import { DialogueStudioView } from "./DialogueStudio";

const POOL: VoicePreset[] = [
  { engineId: "kokoro", voiceId: "af_heart", settings: {} },
  { engineId: "kokoro", voiceId: "bf_emma", settings: {} },
];
const VOICES = {
  kokoro: [{ id: "af_heart", label: "Heart" }, { id: "bf_emma", label: "Emma" }],
  audio8: [{ id: "narrator", label: "Narrator" }],
};

function makeDialogue(source: string, overrides: Partial<UseDialogueSessionReturn> = {}): UseDialogueSessionReturn {
  const script = parseDialogueScript(source);
  const casting = autoCastSpeakers(script, {}, POOL);
  return {
    source,
    setSource: vi.fn(),
    script,
    issues: script.issues,
    speakers: script.speakers,
    casting,
    uncastSpeakers: [],
    castSpeaker: vi.fn(),
    autoCast: vi.fn(),
    gaps: { speakerChangeGapSec: 0.35, sameSpeakerGapSec: 0.2 },
    setGaps: vi.fn(),
    plan: script.turns.length ? planDialogueRender(script, casting) : null,
    status: "idle",
    progress: null,
    error: null,
    turns: new Map(),
    outdatedTurns: new Set(),
    regeneratingTurn: null,
    stitched: null,
    playing: false,
    render: vi.fn(async () => undefined),
    cancel: vi.fn(),
    regenerateTurn: vi.fn(async () => undefined),
    play: vi.fn(),
    stopPlayback: vi.fn(),
    exportAudio: vi.fn(async () => undefined),
    downloadCaptions: vi.fn(),
    ...overrides,
  };
}

function view(dialogue: UseDialogueSessionReturn) {
  return render(
    <DialogueStudioView
      dialogue={dialogue}
      castableEngines={[{ id: "kokoro", label: "Kokoro" }, { id: "audio8", label: "Audio8" }]}
      voicesFor={(engineId) => VOICES[engineId as keyof typeof VOICES] ?? []}
    />,
  );
}

const SCRIPT = "Anna: Hello there.\nBen: Hi Anna.";

describe("DialogueStudioView", () => {
  it("edits the script and lists detected speakers with their line counts", () => {
    const dialogue = makeDialogue(SCRIPT);
    view(dialogue);
    fireEvent.change(screen.getByRole("textbox", { name: "Dialogue script" }), { target: { value: "Anna: Hi." } });
    expect(dialogue.setSource).toHaveBeenCalledWith("Anna: Hi.");
    expect(screen.getByText("Anna")).toBeInTheDocument();
    expect(screen.getAllByText("1 line")).toHaveLength(2);
  });

  it("shows parser issues inline with their line", () => {
    const dialogue = makeDialogue("Anna:\nBen: Hi.");
    view(dialogue);
    const issues = within(screen.getByRole("list", { name: "Script issues" }));
    expect(issues.getAllByRole("listitem")[0]).toHaveTextContent(/Line 1:/);
  });

  it("casts a speaker by engine and voice", () => {
    const dialogue = makeDialogue(SCRIPT);
    view(dialogue);
    fireEvent.change(screen.getByLabelText("Voice for Ben"), { target: { value: "af_heart" } });
    expect(dialogue.castSpeaker).toHaveBeenCalledWith("ben", { engineId: "kokoro", voiceId: "af_heart", settings: {}, label: "Heart" });

    fireEvent.change(screen.getByLabelText("Engine for Anna"), { target: { value: "audio8" } });
    expect(dialogue.castSpeaker).toHaveBeenCalledWith("anna", { engineId: "audio8", voiceId: "narrator", settings: {}, label: "Narrator" });

    fireEvent.click(screen.getByRole("button", { name: "Auto-cast" }));
    expect(dialogue.autoCast).toHaveBeenCalled();
  });

  it("renders, and shows progress with cancel while running", () => {
    const idle = makeDialogue(SCRIPT);
    const { unmount } = view(idle);
    fireEvent.click(screen.getByRole("button", { name: "Render dialogue" }));
    expect(idle.render).toHaveBeenCalled();
    unmount();

    const running = makeDialogue(SCRIPT, { status: "rendering", progress: { position: 2, total: 2 } });
    view(running);
    expect(screen.queryByRole("button", { name: "Render dialogue" })).not.toBeInTheDocument();
    expect(screen.getByRole("progressbar", { name: "Dialogue render progress" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Cancel \(turn 2 of 2\)/ }));
    expect(running.cancel).toHaveBeenCalled();
  });

  it("will not render without a plan and names the speakers that lack a voice", () => {
    const script = parseDialogueScript(SCRIPT);
    view(makeDialogue(SCRIPT, { plan: null, uncastSpeakers: script.speakers }));
    expect(screen.getByRole("button", { name: "Render dialogue" })).toBeDisabled();
    expect(screen.getByText(/Choose a voice for Anna, Ben/)).toBeInTheDocument();
  });

  it("regenerates one line, flags edited lines and exposes playback, export and captions", () => {
    const script = parseDialogueScript(SCRIPT);
    const plan = planDialogueRender(script, autoCastSpeakers(script, {}, POOL));
    const turns = new Map(plan.steps.map((step: DialogueRenderStep) => [step.turnIndex, { step, samples: new Float32Array(48), sampleRate: 24 }]));
    const dialogue = makeDialogue(SCRIPT, {
      status: "done",
      turns,
      outdatedTurns: new Set([1]),
      stitched: { samples: new Float32Array(100), sampleRate: 24, durationSec: 4, cues: [] },
    });
    view(dialogue);

    expect(screen.getByText(/edited since rendering/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Regenerate line 2" }));
    expect(dialogue.regenerateTurn).toHaveBeenCalledWith(1);
    fireEvent.click(screen.getByRole("button", { name: "Play" }));
    expect(dialogue.play).toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Export audio" }));
    expect(dialogue.exportAudio).toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "VTT" }));
    fireEvent.click(screen.getByRole("button", { name: "SRT" }));
    expect(dialogue.downloadCaptions).toHaveBeenNthCalledWith(1, "vtt");
    expect(dialogue.downloadCaptions).toHaveBeenNthCalledWith(2, "srt");
  });

  it("keeps finished lines after a cancel and says so", () => {
    const script = parseDialogueScript(SCRIPT);
    const plan = planDialogueRender(script, autoCastSpeakers(script, {}, POOL));
    const turns = new Map([[0, { step: plan.steps[0], samples: new Float32Array(24), sampleRate: 24 }]]);
    view(makeDialogue(SCRIPT, { status: "cancelled", turns }));
    expect(screen.getByText(/Cancelled after 1 of 2 lines/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Render line 2" })).toBeInTheDocument();
  });

  it("shows a render error", () => {
    view(makeDialogue(SCRIPT, { status: "error", error: "Engine crashed." }));
    expect(screen.getByRole("alert")).toHaveTextContent("Engine crashed.");
  });
});
