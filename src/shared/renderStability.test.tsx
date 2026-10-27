/**
 * Render counts on the hot paths of the real web app: the session, the engine
 * orchestrator, the model loader, the player and the Reader library all run
 * for real; only the browser boundaries (Worker, AudioContext,
 * requestAnimationFrame) are faked. Key subtrees are wrapped so the test can
 * count their renders and see which of their props changed identity.
 *
 * What it guards: a model's load progress, a streamed chunk, a keystroke or a
 * Reader progress sample must not hand memoised controls new handlers, and
 * must not re-render the app shell (header, footer) or the Reader's text pane
 * and player dock when nothing they show has changed.
 */
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkerInMessage, WorkerOutMessage } from "../types";

const probe = vi.hoisted(() => {
  const renders = new Map<string, number>();
  const lastProps = new Map<string, Record<string, unknown>>();
  // Per component, how many renders each prop arrived with a new identity.
  const changedProps = new Map<string, Map<string, number>>();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function instrument(React: any, name: string, Component: any): any {
    const isMemo = Component?.$$typeof === Symbol.for("react.memo");
    const Inner = isMemo ? Component.type : Component;
    const Counted = (props: Record<string, unknown>) => {
      renders.set(name, (renders.get(name) ?? 0) + 1);
      const previous = lastProps.get(name);
      if (previous) {
        const tally = changedProps.get(name) ?? new Map<string, number>();
        for (const key of new Set([...Object.keys(previous), ...Object.keys(props)])) {
          if (key !== "children" && !Object.is(previous[key], props[key])) tally.set(key, (tally.get(key) ?? 0) + 1);
        }
        changedProps.set(name, tally);
      }
      lastProps.set(name, props);
      return React.createElement(Inner, props);
    };
    Counted.displayName = `Counted(${name})`;
    // A memoised component stays memoised, with its own comparison.
    return isMemo ? React.memo(Counted, Component.compare ?? undefined) : Counted;
  }

  function wrapModule(names: string[]) {
    return async (importOriginal: () => Promise<Record<string, unknown>>) => {
      const actual = await importOriginal();
      const React = await import("react");
      const wrapped: Record<string, unknown> = { ...actual };
      for (const name of names) wrapped[name] = instrument(React, name, actual[name]);
      return wrapped;
    };
  }

  return {
    wrapModule,
    renderCount: (name: string) => renders.get(name) ?? 0,
    changes: (name: string) => Object.fromEntries(changedProps.get(name) ?? []),
    resetChanges: () => changedProps.clear(),
    reset: () => {
      renders.clear();
      lastProps.clear();
      changedProps.clear();
    },
  };
});

vi.mock("../components/AppHeader", probe.wrapModule(["AppHeader"]));
vi.mock("../components/AppFooter", probe.wrapModule(["AppFooter"]));
vi.mock("../components/TextInput", probe.wrapModule(["TextInput"]));
vi.mock("../components/ModelToggle", probe.wrapModule(["ModelToggle"]));
vi.mock("../components/VoiceSelector", probe.wrapModule(["VoiceSelector"]));
vi.mock("../components/CreatorToolsPanel", probe.wrapModule(["CreatorToolsPanel"]));
vi.mock("../components/StudioTakesPanel", probe.wrapModule(["StudioTakesPanel"]));
vi.mock("../components/StudioHistoryPanel", probe.wrapModule(["StudioHistoryPanel"]));
vi.mock("../components/SettingsPanel", probe.wrapModule(["SettingsPanel"]));
vi.mock("../components/AdvancedReaderPage", probe.wrapModule(["AdvancedReaderPage"]));
vi.mock("../components/reader/ReaderTextPane", probe.wrapModule(["ReaderTextPane"]));
vi.mock("../components/reader/ReaderPlayerDock", probe.wrapModule(["ReaderPlayerDock"]));
vi.mock("../components/reader/ReaderParagraph", probe.wrapModule(["ReaderParagraph"]));
// The OS media session has its own tests; jsdom has no mediaSession.
vi.mock("../hooks/useReaderMediaSession", () => ({ useReaderMediaSession: vi.fn() }));

import WebApp from "../apps/web/WebApp";

class MockWorker extends EventTarget {
  static instances: MockWorker[] = [];
  posted: WorkerInMessage[] = [];
  onmessage: ((event: MessageEvent<WorkerOutMessage>) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onmessageerror: ((event: Event) => void) | null = null;
  terminated = false;
  readonly url: string;

  constructor(url: URL | string) {
    super();
    this.url = String(url);
    MockWorker.instances.push(this);
  }

  postMessage(message: WorkerInMessage) {
    this.posted.push(message);
    if (message.type === "ABORT") {
      queueMicrotask(() => this.emit({ type: "ABORTED", generationId: message.generationId }));
    }
  }

  terminate() {
    this.terminated = true;
  }

  emit(message: WorkerOutMessage) {
    const event = new MessageEvent("message", { data: message });
    this.onmessage?.(event as MessageEvent<WorkerOutMessage>);
    this.dispatchEvent(event);
  }

  get model() {
    return /\/(\w+)\.worker\.ts/.exec(this.url)?.[1];
  }
}

class MockAudioBuffer {
  readonly duration: number;
  readonly numberOfChannels = 1;
  readonly length: number;
  readonly sampleRate: number;
  private readonly data: Float32Array;

  constructor(length: number, sampleRate: number) {
    this.length = length;
    this.sampleRate = sampleRate;
    this.duration = length / sampleRate;
    this.data = new Float32Array(length);
  }

  getChannelData() {
    return this.data;
  }

  copyToChannel(source: Float32Array) {
    this.data.set(source.subarray(0, this.length));
  }
}

class MockAudioContext {
  static instances: MockAudioContext[] = [];
  currentTime = 0;
  state: "running" | "suspended" | "closed" = "suspended";
  readonly sampleRate = 24_000;
  readonly destination = {};

  constructor() {
    MockAudioContext.instances.push(this);
  }

  async resume() {
    this.state = "running";
  }

  async suspend() {
    this.state = "suspended";
  }

  async close() {
    this.state = "closed";
  }

  addEventListener() {}
  removeEventListener() {}

  createBuffer(_channels: number, length: number, rate: number) {
    return new MockAudioBuffer(length, rate);
  }

  createBufferSource() {
    return {
      buffer: null,
      playbackRate: { value: 1 },
      onended: null,
      connect() {},
      disconnect() {},
      start() {},
      stop() {},
    };
  }

  createGain() {
    return { gain: { value: 1, setValueAtTime() {}, linearRampToValueAtTime() {} }, connect() {}, disconnect() {} };
  }
}

let frameQueue: FrameRequestCallback[] = [];

function flushFrames(rounds = 3) {
  for (let round = 0; round < rounds; round += 1) {
    const queue = frameQueue;
    frameQueue = [];
    if (queue.length === 0) return;
    act(() => {
      for (const callback of queue) callback(performance.now());
    });
  }
}

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  flushFrames();
}

function kokoroWorker(): MockWorker {
  const worker = MockWorker.instances.filter((entry) => entry.model === "kokoro" && !entry.terminated).at(-1);
  if (!worker) throw new Error("No Kokoro worker was started.");
  return worker;
}

async function mountApp() {
  render(<WebApp />);
  await waitFor(() => expect(kokoroWorker().posted.some((message) => message.type === "LOAD")).toBe(true));
}

function modelReady() {
  act(() => kokoroWorker().emit({ type: "READY", voices: ["af_heart", "af_bella"], backend: "wasm" }));
}

function loadProgressTicks(count: number) {
  const worker = kokoroWorker();
  for (let tick = 0; tick < count; tick += 1) {
    act(() => worker.emit({ type: "LOAD_PROGRESS", percent: tick / 10 }));
  }
}

function latestGenerate(): Extract<WorkerInMessage, { type: "GENERATE" }> {
  const generate = kokoroWorker().posted.filter((message) => message.type === "GENERATE").at(-1);
  if (!generate || generate.type !== "GENERATE") throw new Error("Nothing was generated.");
  return generate;
}

/** Renders of each of `names` during `run`; prop changes are tallied from its start. */
async function rendersDuring(names: string[], run: () => void | Promise<void>) {
  const before = Object.fromEntries(names.map((name) => [name, probe.renderCount(name)]));
  probe.resetChanges();
  await run();
  return Object.fromEntries(names.map((name) => [name, probe.renderCount(name) - before[name]]));
}

/** The app shell and the memoised Studio panels. */
const STUDIO_PANELS = [
  "AppHeader",
  "AppFooter",
  "TextInput",
  "CreatorToolsPanel",
  "StudioTakesPanel",
  "StudioHistoryPanel",
  "SettingsPanel",
];

const PARAGRAPHS = Array.from({ length: 12 }, (_, paragraph) => (
  Array.from({ length: 3 }, (_, sentence) => (
    `Paragraph ${paragraph + 1} sentence ${sentence + 1} carries a little narrative weight here.`
  )).join(" ")
));
const BOOK = PARAGRAPHS.join("\n\n");
const CHUNK_SEC = 3;

beforeEach(() => {
  probe.reset();
  localStorage.clear();
  MockWorker.instances = [];
  MockAudioContext.instances = [];
  frameQueue = [];
  vi.stubGlobal("Worker", MockWorker);
  vi.stubGlobal("AudioContext", MockAudioContext);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frameQueue.push(callback);
    return frameQueue.length;
  });
  vi.stubGlobal("cancelAnimationFrame", () => {});
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent: () => false,
  }));
  window.history.replaceState(null, "", "/");
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("render stability: Studio", () => {
  it("keeps the controls' handlers and the app shell through a model's load progress", async () => {
    await mountApp();
    await settle();

    const renders = await rendersDuring(STUDIO_PANELS, () => loadProgressTicks(100));

    // The model picker shows the progress; nothing the surface hands its other
    // controls changes, and the shell shows none of it.
    expect(renders).toEqual(Object.fromEntries(STUDIO_PANELS.map((name) => [name, 0])));
    expect(probe.changes("ModelToggle")).not.toHaveProperty("onModelChange");
    expect(probe.changes("ModelToggle")).not.toHaveProperty("desktopModelOptions");
    expect(probe.changes("VoiceSelector")).not.toHaveProperty("onVoiceChange");
    expect(probe.changes("CreatorToolsPanel")).toEqual({});
    expect(probe.changes("StudioTakesPanel")).toEqual({});
  });

  it("keeps the script's change handler while typing", async () => {
    await mountApp();
    modelReady();
    await settle();
    const textarea = screen.getByRole("textbox", { name: "Text to synthesize" }) as HTMLTextAreaElement;

    const renders = await rendersDuring(STUDIO_PANELS, () => {
      let value = textarea.value;
      for (const character of "abcdefghij") {
        value += character;
        fireEvent.change(textarea, { target: { value } });
      }
    });

    // The editor and the Creator tools show the script; nothing else does.
    expect(renders).toMatchObject({ TextInput: 10, CreatorToolsPanel: 10, StudioHistoryPanel: 0, SettingsPanel: 0 });
    expect(probe.changes("TextInput")).not.toHaveProperty("onTextChange");
    expect(probe.changes("CreatorToolsPanel")).not.toHaveProperty("onScriptChange");
    expect(renders.AppHeader).toBe(0);
    expect(renders.AppFooter).toBe(0);
  });

  it("keeps the controls' handlers and the app shell while audio streams in", async () => {
    await mountApp();
    modelReady();
    await settle();
    fireEvent.click(screen.getByRole("button", { name: /^Generate/ }));
    await settle();
    const { generationId } = latestGenerate();
    const worker = kokoroWorker();

    const renders = await rendersDuring(STUDIO_PANELS, async () => {
      for (let index = 0; index < 10; index += 1) {
        await act(async () => {
          worker.emit({
            type: "AUDIO_CHUNK",
            generationId,
            audio: new Float32Array(2_400),
            samplingRate: 24_000,
            text: `Chunk ${index}.`,
            index,
            total: 10,
            textStart: index * 9,
            textEnd: index * 9 + 8,
          });
        });
        flushFrames();
      }
    });

    expect(renders).toMatchObject({ AppHeader: 0, AppFooter: 0, TextInput: 0, StudioHistoryPanel: 0, SettingsPanel: 0 });
    expect(probe.changes("ModelToggle")).toEqual({});
    expect(probe.changes("VoiceSelector")).toEqual({});
    expect(probe.changes("CreatorToolsPanel")).not.toHaveProperty("onScriptChange");
  });
});

describe("render stability: Reader", () => {
  async function openReader() {
    localStorage.setItem("tts-app-state-v2", JSON.stringify({ model: "kokoro", text: BOOK, quality: 5 }));
    window.history.replaceState(null, "", "/reader");
    await mountApp();
    await settle();
    await waitFor(() => expect(document.querySelectorAll("p[data-block-start]").length).toBeGreaterThan(0));
    await settle();
  }

  it("leaves the text pane alone while the model loads", async () => {
    await openReader();

    const renders = await rendersDuring(["ReaderTextPane", "ReaderPlayerDock", "AppHeader"], () => loadProgressTicks(100));

    expect(renders.ReaderTextPane).toBe(0);
    expect(renders.AppHeader).toBe(0);
    // The dock shows the progress; only that prop reaches it changed.
    expect(Object.keys(probe.changes("ReaderPlayerDock"))).toEqual(["loadingProgress"]);
  });

  it("leaves the text pane and the player dock alone on a progress sample", async () => {
    await openReader();
    modelReady();
    await settle();
    fireEvent.click(screen.getAllByRole("button", { name: "Generate speech" })[0]);
    await settle();
    const generate = latestGenerate();
    const worker = kokoroWorker();
    // One passage per sentence, each CHUNK_SEC long.
    const sentences = [...generate.text.matchAll(/[^.]+\./g)].slice(0, 4);
    for (const [index, match] of sentences.entries()) {
      const textStart = match.index + (match[0].length - match[0].trimStart().length);
      await act(async () => {
        worker.emit({
          type: "AUDIO_CHUNK",
          generationId: generate.generationId,
          audio: new Float32Array(24_000 * CHUNK_SEC),
          samplingRate: 24_000,
          text: generate.text.slice(textStart, match.index + match[0].length),
          index,
          total: sentences.length,
          textStart,
          textEnd: match.index + match[0].length,
        });
      });
      flushFrames();
    }
    await act(async () => {
      worker.emit({ type: "GENERATION_COMPLETE", generationId: generate.generationId });
    });
    await settle();

    vi.useFakeTimers({ toFake: ["Date"] });
    if (screen.queryAllByRole("button", { name: "Pause" }).length === 0) {
      await act(async () => {
        fireEvent.click(screen.getAllByRole("button", { name: "Play" })[0]);
        await Promise.resolve();
      });
      await settle();
      frameQueue = frameQueue.slice(-1);
    }
    expect(screen.getAllByRole("button", { name: "Pause" }).length).toBeGreaterThan(0);
    const context = MockAudioContext.instances.at(-1)!;
    const tick = (ms: number) => {
      context.currentTime += ms / 1_000;
      vi.setSystemTime(Date.now() + ms);
      flushFrames(1);
    };
    tick(100);

    // 2.25 s inside the first passage: three progress samples (one every
    // 750 ms), each of which replaces the book's record.
    const renders = await rendersDuring(["ReaderTextPane", "ReaderPlayerDock"], () => {
      for (let frame = 0; frame < 45; frame += 1) tick(50);
    });

    expect(probe.changes("AdvancedReaderPage")).toMatchObject({ activeDocument: 3 });
    expect(renders.ReaderTextPane).toBe(0);
    expect(renders.ReaderPlayerDock).toBe(0);

    // The next passage starts at CHUNK_SEC, in the same paragraph: of the
    // twelve on screen, only the one holding the passage re-renders.
    while (context.currentTime < CHUNK_SEC - 0.06) tick(50);
    const passageChange = await rendersDuring(["ReaderTextPane", "ReaderParagraph"], () => tick(100));
    expect(passageChange.ReaderTextPane).toBe(1);
    expect(document.querySelectorAll("p[data-block-start]")).toHaveLength(12);
    expect(passageChange.ReaderParagraph).toBe(1);
  });
});
