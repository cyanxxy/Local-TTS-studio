import type { TextChunk } from "../lib/chunking";
import { audio8Engine } from "./audio8";
import { kokoroEngine } from "./kokoro";
import { neuttsEngine } from "./neutts";
import { qwen3Engine } from "./qwen3";
import { supertonicEngine } from "./supertonic";
import { supertonic3Engine } from "./supertonic3";
import type {
  AnyEngineDescriptor,
  EngineDescriptor,
  EnginePreviewContext,
  EngineSetupPage,
  EngineSignatureContext,
  EngineSignatureParts,
  EngineVoice,
  EngineVoiceContext,
} from "./types";

/**
 * Every engine Open TTS knows about, in picker order.
 *
 * Adding an engine:
 * - a browser model is a descriptor file in this folder, its worker, and one
 *   line below; the id unions, pickers, labels, persistence and Reader cache
 *   signatures all derive from the descriptor;
 * - a native model is the same plus its Electron or Rust transport.
 *
 * Each key must equal its descriptor's `id`; `defineEngineRegistry` enforces it.
 */
export const ENGINES = defineEngineRegistry({
  kokoro: kokoroEngine,
  supertonic: supertonicEngine,
  audio8: audio8Engine,
  supertonic3: supertonic3Engine,
  neutts: neuttsEngine,
  qwen3: qwen3Engine,
});

function defineEngineRegistry<const Engines extends Record<string, AnyEngineDescriptor>>(
  engines: Engines & { readonly [Id in keyof Engines]: { readonly id: Id } },
): Engines {
  return engines;
}

type RegisteredEngine = (typeof ENGINES)[keyof typeof ENGINES];

export type EngineId = keyof typeof ENGINES;
export type EngineDescriptorFor<Id extends EngineId> = (typeof ENGINES)[Id];
/** Engines whose module workers every build can host; one is resident for both surfaces. */
export type BrowserEngineId = Extract<RegisteredEngine, { readonly picker: "browser" }>["id"];
/** Engines a desktop surface can select in place of the browser model. */
export type DesktopInlineEngineId = Extract<RegisteredEngine, { readonly picker: "desktop" }>["id"];
/** Engines Studio or the Reader can drive. */
export type SurfaceEngineId = BrowserEngineId | DesktopInlineEngineId;
/** Engines with a dedicated desktop setup page. */
export type SetupPageEngineId = Extract<RegisteredEngine, { readonly setupPage: EngineSetupPage }>["id"];
/** Engines that run on the loopback Rust bridge. */
export type RustBridgeEngineId = Extract<RegisteredEngine, { readonly runtime: "rust-bridge" }>["id"];

export type EngineSettings<Id extends EngineId> = ReturnType<EngineDescriptorFor<Id>["parseSettings"]>;
export type EngineLiveSettings<Id extends EngineId> = Parameters<EngineDescriptorFor<Id>["voiceLabel"]>[0];
/** The live settings of every engine a surface can select, keyed by engine. */
export type SurfaceEngineSettings = { readonly [Id in SurfaceEngineId]: EngineLiveSettings<Id> };

// Written as a mapped type so indexing it with a generic id keeps the
// descriptor and its settings correlated.
type TypedEngineMap = {
  readonly [Id in EngineId]: EngineDescriptor<EngineSettings<Id>, EngineLiveSettings<Id>>;
};
const TYPED_ENGINES: TypedEngineMap = ENGINES;

export const ENGINE_REGISTRY: readonly RegisteredEngine[] = Object.values(ENGINES);
export const ENGINE_IDS: readonly EngineId[] = ENGINE_REGISTRY.map((engine) => engine.id);

function isBrowserEngine(engine: RegisteredEngine): engine is Extract<RegisteredEngine, { readonly picker: "browser" }> {
  return engine.picker === "browser";
}

function isDesktopInlineEngine(
  engine: RegisteredEngine,
): engine is Extract<RegisteredEngine, { readonly picker: "desktop" }> {
  return engine.picker === "desktop";
}

function hasSetupPage(engine: RegisteredEngine): engine is Extract<RegisteredEngine, { readonly setupPage: EngineSetupPage }> {
  return "setupPage" in engine;
}

export const BROWSER_ENGINE_IDS: readonly BrowserEngineId[] = ENGINE_REGISTRY
  .filter(isBrowserEngine)
  .map((engine) => engine.id);
export const DESKTOP_INLINE_ENGINE_IDS: readonly DesktopInlineEngineId[] = ENGINE_REGISTRY
  .filter(isDesktopInlineEngine)
  .map((engine) => engine.id);
export const SETUP_PAGE_ENGINE_IDS: readonly SetupPageEngineId[] = ENGINE_REGISTRY
  .filter(hasSetupPage)
  .map((engine) => engine.id);

export function getEngine<Id extends EngineId>(id: Id): EngineDescriptorFor<Id> {
  return ENGINES[id];
}

export function isEngineId(value: unknown): value is EngineId {
  return typeof value === "string" && (ENGINE_IDS as readonly string[]).includes(value);
}

export function isBrowserEngineId(value: unknown): value is BrowserEngineId {
  return typeof value === "string" && (BROWSER_ENGINE_IDS as readonly string[]).includes(value);
}

export function isDesktopInlineEngineId(value: unknown): value is DesktopInlineEngineId {
  return typeof value === "string" && (DESKTOP_INLINE_ENGINE_IDS as readonly string[]).includes(value);
}

export function engineVoices(id: EngineId, context?: EngineVoiceContext): readonly EngineVoice[] {
  return TYPED_ENGINES[id].voices(context);
}

export function engineVoiceLabel<Id extends EngineId>(id: Id, settings: EngineLiveSettings<Id>): string {
  return TYPED_ENGINES[id].voiceLabel(settings);
}

export function engineDetail<Id extends EngineId>(id: Id, settings: EngineLiveSettings<Id>): string {
  return TYPED_ENGINES[id].detail(settings);
}

export function engineSignatureParts<Id extends EngineId>(
  id: Id,
  context: EngineSignatureContext<EngineLiveSettings<Id>>,
): EngineSignatureParts | null {
  return TYPED_ENGINES[id].signatureParts(context);
}

export function enginePreviewChunks<Id extends EngineId>(
  id: Id,
  text: string,
  context: EnginePreviewContext<EngineLiveSettings<Id>>,
): TextChunk[] {
  return TYPED_ENGINES[id].previewChunks(text, context);
}

/** `engineVoiceLabel` for whichever engine a surface selected. */
export function surfaceEngineVoiceLabel<Id extends SurfaceEngineId>(id: Id, settings: SurfaceEngineSettings): string {
  return engineVoiceLabel(id, settings[id]);
}

/** `engineDetail` for whichever engine a surface selected. */
export function surfaceEngineDetail<Id extends SurfaceEngineId>(id: Id, settings: SurfaceEngineSettings): string {
  return engineDetail(id, settings[id]);
}

/** `engineSignatureParts` for whichever engine a surface selected. */
export function surfaceEngineSignatureParts<Id extends SurfaceEngineId>(
  id: Id,
  settings: SurfaceEngineSettings,
  context: Omit<EngineSignatureContext<unknown>, "settings">,
): EngineSignatureParts | null {
  return engineSignatureParts(id, { ...context, settings: settings[id] });
}

/** `enginePreviewChunks` for whichever engine a surface selected. */
export function surfaceEnginePreviewChunks<Id extends SurfaceEngineId>(
  id: Id,
  text: string,
  settings: SurfaceEngineSettings,
  context: Omit<EnginePreviewContext<unknown>, "settings">,
): TextChunk[] {
  return enginePreviewChunks(id, text, { ...context, settings: settings[id] });
}
