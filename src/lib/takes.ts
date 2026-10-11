import { QWEN3_MAX_SEED } from "../../electron/localTtsLimits";
import { SPEED_MAX, SPEED_MIN } from "../constants";

/**
 * Takes and variations: for one segment or short script, a stack of
 * alternative renders the user can audition, compare and choose between.
 * Engines with a seed (Qwen3) vary by seed and reproduce a take exactly from
 * it; engines without one (Kokoro) vary prosody through small speed changes.
 * Everything here is immutable data plus pure functions, so it works the same
 * in a reducer, a store or a test.
 */

export interface TakeAudio {
  samples: Float32Array;
  sampleRate: number;
}

export interface Take<TAudio = TakeAudio> {
  id: string;
  /** The seed that reproduces this take, or null for engines without one. */
  seed: number | null;
  createdAt: number;
  label: string;
  audio: TAudio;
  /** Setting overrides this take was rendered with, such as a speed nudge. */
  overrides?: TakeOverrides;
  /** Pinned takes survive eviction when the stack is full. */
  pinned?: boolean;
}

export interface TakeOverrides {
  speed?: number;
}

export interface TakeStack<TAudio = TakeAudio> {
  /** The segment id or script id these takes belong to. */
  targetId: string;
  /** Oldest first. */
  takes: Take<TAudio>[];
  activeTakeId: string | null;
  maxTakes: number;
}

export const DEFAULT_MAX_TAKES = 8;
export const MAX_VARIATIONS_PER_REQUEST = 8;
const DEFAULT_SPEED_STEP = 0.04;

export function createTakeStack<TAudio = TakeAudio>(
  targetId: string,
  options: { maxTakes?: number } = {},
): TakeStack<TAudio> {
  const maxTakes = options.maxTakes ?? DEFAULT_MAX_TAKES;
  if (!Number.isInteger(maxTakes) || maxTakes < 1) throw new Error("A take stack must hold at least one take.");
  return { targetId, takes: [], activeTakeId: null, maxTakes };
}

export function getActiveTake<TAudio>(stack: TakeStack<TAudio>): Take<TAudio> | null {
  return stack.takes.find((take) => take.id === stack.activeTakeId) ?? null;
}

/**
 * Drop the oldest takes that are neither active, pinned nor just added until
 * the stack fits. Only adding a take evicts, so switching or unpinning never
 * deletes a take out from under the user. When everything left is active or
 * pinned the stack may stay over its limit: the user's explicit choices win
 * over the bound.
 */
function evictToFit<TAudio>(stack: TakeStack<TAudio>, protectedId: string): TakeStack<TAudio> {
  let takes = stack.takes;
  while (takes.length > stack.maxTakes) {
    const victim = takes.find((take) => !take.pinned && take.id !== stack.activeTakeId && take.id !== protectedId);
    if (!victim) break;
    takes = takes.filter((take) => take !== victim);
  }
  return takes === stack.takes ? stack : { ...stack, takes };
}

/** Append a take, by default making it the active one. Ids must be unique. */
export function addTake<TAudio>(
  stack: TakeStack<TAudio>,
  take: Take<TAudio>,
  options: { activate?: boolean } = {},
): TakeStack<TAudio> {
  if (stack.takes.some((existing) => existing.id === take.id)) {
    throw new Error(`Take ${take.id} is already in this stack.`);
  }
  const activate = options.activate ?? true;
  return evictToFit({
    ...stack,
    takes: [...stack.takes, take],
    activeTakeId: activate || stack.activeTakeId === null ? take.id : stack.activeTakeId,
  }, take.id);
}

export function setActiveTake<TAudio>(stack: TakeStack<TAudio>, takeId: string): TakeStack<TAudio> {
  if (!stack.takes.some((take) => take.id === takeId)) throw new Error(`Take ${takeId} is not in this stack.`);
  return stack.activeTakeId === takeId ? stack : { ...stack, activeTakeId: takeId };
}

/** Remove a take; an active take hands over to its newer neighbour, else the older one. */
export function removeTake<TAudio>(stack: TakeStack<TAudio>, takeId: string): TakeStack<TAudio> {
  const index = stack.takes.findIndex((take) => take.id === takeId);
  if (index < 0) return stack;
  const takes = stack.takes.filter((take) => take.id !== takeId);
  let activeTakeId = stack.activeTakeId;
  if (activeTakeId === takeId) activeTakeId = (takes[index] ?? takes[index - 1])?.id ?? null;
  return { ...stack, takes, activeTakeId };
}

export function pinTake<TAudio>(stack: TakeStack<TAudio>, takeId: string, pinned: boolean): TakeStack<TAudio> {
  if (!stack.takes.some((take) => take.id === takeId)) throw new Error(`Take ${takeId} is not in this stack.`);
  // Unpinning never evicts on the spot; the take becomes eligible on the next add.
  return { ...stack, takes: stack.takes.map((take) => (take.id === takeId ? { ...take, pinned } : take)) };
}

/** A uniformly random seed in the bridge's u32 range. */
export function randomSeed(
  fillRandom: (array: Uint32Array<ArrayBuffer>) => void = (array) => {
    globalThis.crypto.getRandomValues(array);
  },
): number {
  const value = new Uint32Array(1);
  fillRandom(value);
  return value[0] % (QWEN3_MAX_SEED + 1);
}

/**
 * `count` distinct seeds starting at `baseSeed` and counting up, wrapping at
 * the u32 limit and skipping seeds already used, so "generate 3 more" never
 * repeats a take and the same request always yields the same seeds.
 */
export function planVariationSeeds(
  baseSeed: number,
  count: number,
  existingSeeds: Iterable<number | null> = [],
): number[] {
  if (!Number.isInteger(baseSeed) || baseSeed < 0 || baseSeed > QWEN3_MAX_SEED) {
    throw new Error(`Seeds must be whole numbers from 0 to ${QWEN3_MAX_SEED}.`);
  }
  assertVariationCount(count);
  const used = new Set<number>();
  for (const seed of existingSeeds) if (seed !== null) used.add(seed);
  const seeds: number[] = [];
  for (let candidate = baseSeed; seeds.length < count; candidate = candidate === QWEN3_MAX_SEED ? 0 : candidate + 1) {
    if (!used.has(candidate)) {
      seeds.push(candidate);
      used.add(candidate);
    }
  }
  return seeds;
}

function assertVariationCount(count: number): void {
  if (!Number.isInteger(count) || count < 1 || count > MAX_VARIATIONS_PER_REQUEST) {
    throw new Error(`Request between 1 and ${MAX_VARIATIONS_PER_REQUEST} variations.`);
  }
}

export interface TakeVariation {
  seed: number | null;
  label: string;
  overrides?: TakeOverrides;
}

function roundSpeed(speed: number): number {
  return Math.round(speed * 100) / 100;
}

/**
 * Plan a batch of variations. Seeded engines get consecutive unused seeds.
 * Engines without a seed get prosody variations instead: speeds fanned out
 * around the base (base, +step, -step, +2 step, ...) inside the app's stable
 * speed range, skipping duplicates, and labelled as such rather than as seeds.
 */
export function planTakeVariations(options: {
  count: number;
  seedControl: boolean;
  baseSeed?: number;
  existing?: readonly Pick<Take<unknown>, "seed" | "overrides">[];
  baseSpeed?: number;
  speedStep?: number;
}): TakeVariation[] {
  assertVariationCount(options.count);
  const existing = options.existing ?? [];
  if (options.seedControl) {
    const seeds = planVariationSeeds(options.baseSeed ?? randomSeed(), options.count, existing.map((take) => take.seed));
    return seeds.map((seed) => ({ seed, label: `Seed ${seed}` }));
  }

  const base = roundSpeed(Math.min(SPEED_MAX, Math.max(SPEED_MIN, options.baseSpeed ?? 1)));
  const step = options.speedStep ?? DEFAULT_SPEED_STEP;
  if (!(step > 0)) throw new Error("The speed step must be positive.");
  const used = new Set(existing.map((take) => take.overrides?.speed).filter((speed): speed is number => speed !== undefined));
  const variations: TakeVariation[] = [];
  const maxOffsets = Math.ceil((SPEED_MAX - SPEED_MIN) / step) + 1;
  for (let offset = 0; offset <= maxOffsets && variations.length < options.count; offset += 1) {
    for (const direction of offset === 0 ? [0] : [1, -1]) {
      const speed = roundSpeed(base + direction * offset * step);
      if (speed < SPEED_MIN || speed > SPEED_MAX || used.has(speed) || variations.length >= options.count) continue;
      used.add(speed);
      variations.push({ seed: null, label: `Speed ${speed.toFixed(2)}×`, overrides: { speed } });
    }
  }
  return variations;
}

/**
 * Render planned variations one after another (local engines serve one
 * request at a time) and hand each finished take over as soon as it exists.
 * Stops at the first failure or abort; takes already delivered stay valid.
 */
export async function renderTakeVariations<TAudio>(options: {
  variations: readonly TakeVariation[];
  render: (variation: TakeVariation, signal: AbortSignal) => Promise<TAudio>;
  onTake: (take: Take<TAudio>) => void;
  signal?: AbortSignal;
  now?: () => number;
  createId?: () => string;
}): Promise<Take<TAudio>[]> {
  const now = options.now ?? Date.now;
  const createId = options.createId ?? (() => globalThis.crypto.randomUUID());
  const signal = options.signal ?? new AbortController().signal;
  const takes: Take<TAudio>[] = [];
  for (const variation of options.variations) {
    signal.throwIfAborted();
    const audio = await options.render(variation, signal);
    signal.throwIfAborted();
    const take: Take<TAudio> = {
      id: createId(),
      seed: variation.seed,
      createdAt: now(),
      label: variation.label,
      audio,
      ...(variation.overrides ? { overrides: variation.overrides } : {}),
    };
    takes.push(take);
    options.onTake(take);
  }
  return takes;
}

export interface TakeMetrics {
  durationSec: number;
  peakDbfs: number;
  rmsDbfs: number;
}

function toDbfs(linear: number): number {
  return linear > 0 ? Math.max(-120, 20 * Math.log10(linear)) : -120;
}

export function measureTakeAudio(audio: TakeAudio): TakeMetrics {
  let peak = 0;
  let sum = 0;
  for (let index = 0; index < audio.samples.length; index += 1) {
    const value = Number.isFinite(audio.samples[index]) ? audio.samples[index] : 0;
    peak = Math.max(peak, Math.abs(value));
    sum += value * value;
  }
  const rms = audio.samples.length > 0 ? Math.sqrt(sum / audio.samples.length) : 0;
  return {
    durationSec: Math.round((audio.samples.length / audio.sampleRate) * 1000) / 1000,
    peakDbfs: Math.round(toDbfs(peak) * 10) / 10,
    rmsDbfs: Math.round(toDbfs(rms) * 10) / 10,
  };
}

export interface TakeComparisonRow extends TakeMetrics {
  takeId: string;
  label: string;
  seed: number | null;
  isActive: boolean;
  pinned: boolean;
  /** Relative to the active take; 0 for the active take or without one. */
  durationDeltaSec: number;
  rmsDeltaDb: number;
}

/** Side-by-side metrics for every take, relative to the active one. */
export function compareTakes<TAudio>(
  stack: TakeStack<TAudio>,
  measure: (audio: TAudio) => TakeMetrics,
): TakeComparisonRow[] {
  const metrics = stack.takes.map((take) => measure(take.audio));
  const activeIndex = stack.takes.findIndex((take) => take.id === stack.activeTakeId);
  const reference = activeIndex >= 0 ? metrics[activeIndex] : null;
  return stack.takes.map((take, index) => ({
    takeId: take.id,
    label: take.label,
    seed: take.seed,
    isActive: index === activeIndex,
    pinned: take.pinned === true,
    ...metrics[index],
    durationDeltaSec: reference ? Math.round((metrics[index].durationSec - reference.durationSec) * 1000) / 1000 : 0,
    rmsDeltaDb: reference ? Math.round((metrics[index].rmsDbfs - reference.rmsDbfs) * 10) / 10 : 0,
  }));
}
