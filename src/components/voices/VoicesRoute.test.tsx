import { fireEvent, render, screen } from "@testing-library/react";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getQwen3Profiles } from "../../../electron/qwen3Profiles";
import { SynthesisSessionContext } from "../../shared/synthesisSessionContext";
import type { SynthesisSession } from "../../shared/useSynthesisSessionState";
import { getVoiceLibraryStore } from "../../lib/voiceLibrary/store";
import { VoicesRoute } from "./VoicesRoute";

const qwen3 = vi.hoisted(() => ({
  value: { available: false, profiles: [] as readonly unknown[], setup: null as unknown },
}));

vi.mock("../../contexts/Qwen3RuntimeContext", () => ({
  useQwen3Runtime: () => qwen3.value,
}));

function session(): SynthesisSession {
  return {
    engines: {
      kokoroVoices: ["af_heart"],
      runtimes: {},
      surfaceEngineSettings: {},
    },
    creator: { generationSettings: { speed: 1, quality: 5 } },
    voices: { apply: vi.fn(async () => ({ ok: true, message: "ok" })) },
  } as unknown as SynthesisSession;
}

describe("VoicesRoute", () => {
  beforeEach(() => {
    vi.stubGlobal("indexedDB", new IDBFactory());
    vi.stubGlobal("IDBKeyRange", IDBKeyRange);
    localStorage.clear();
  });
  afterEach(async () => {
    await getVoiceLibraryStore().destroy();
    vi.unstubAllGlobals();
  });

  it("lists the loaded Kokoro voices and says design needs the desktop Qwen3 model", async () => {
    render(
      <SynthesisSessionContext.Provider value={session()}>
        <VoicesRoute />
      </SynthesisSessionContext.Provider>,
    );
    expect(await screen.findByText("Heart")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: "Design a voice" }));
    expect(screen.getByText(/needs the desktop app and its model/)).toBeInTheDocument();
  });

  it("enables design once a VoiceDesign model is installed", () => {
    const profiles = getQwen3Profiles("darwin", "arm64");
    const design = profiles.find((profile) => profile.mode === "voiceDesign")!;
    qwen3.value = { available: true, profiles, setup: { profiles: [{ repo: design.repo, readiness: "verified" }] } };
    render(
      <SynthesisSessionContext.Provider value={session()}>
        <VoicesRoute />
      </SynthesisSessionContext.Provider>,
    );
    fireEvent.click(screen.getByRole("tab", { name: "Design a voice" }));
    fireEvent.change(screen.getByLabelText("Voice description"), { target: { value: "A voice" } });
    expect(screen.getByRole("button", { name: "Generate 3 previews" })).toBeEnabled();
    qwen3.value = { available: false, profiles: [], setup: null };
  });
});
