import { useCallback, useMemo, useReducer } from "react";
import {
  addTake,
  createTakeStack,
  pinTake,
  removeTake,
  setActiveTake,
  type Take,
  type TakeAudio,
  type TakeStack,
} from "../lib/takes";

export type TakesState<TAudio = TakeAudio> = Readonly<Record<string, TakeStack<TAudio>>>;

export type TakesAction<TAudio = TakeAudio> =
  | { type: "open"; targetId: string; maxTakes?: number }
  | { type: "add"; targetId: string; take: Take<TAudio>; activate?: boolean }
  | { type: "activate"; targetId: string; takeId: string }
  | { type: "remove"; targetId: string; takeId: string }
  | { type: "pin"; targetId: string; takeId: string; pinned: boolean }
  | { type: "clear"; targetId: string }
  | { type: "reset" };

/**
 * Take stacks keyed by segment or script id. A stack exists only once it is
 * opened; every other action on an unknown target or take is ignored, because
 * a take can finish rendering after the user has cleared its segment, and that
 * late take must not bring the stack back.
 */
export function takesReducer<TAudio>(state: TakesState<TAudio>, action: TakesAction<TAudio>): TakesState<TAudio> {
  switch (action.type) {
    case "open":
      if (Object.hasOwn(state, action.targetId)) return state;
      return { ...state, [action.targetId]: createTakeStack<TAudio>(action.targetId, { maxTakes: action.maxTakes }) };
    case "add": {
      const current = state[action.targetId];
      if (!current || current.takes.some((take) => take.id === action.take.id)) return state;
      return { ...state, [action.targetId]: addTake(current, action.take, { activate: action.activate }) };
    }
    case "activate": {
      const current = state[action.targetId];
      if (!current?.takes.some((take) => take.id === action.takeId)) return state;
      const next = setActiveTake(current, action.takeId);
      return next === current ? state : { ...state, [action.targetId]: next };
    }
    case "remove": {
      const current = state[action.targetId];
      if (!current) return state;
      const next = removeTake(current, action.takeId);
      return next === current ? state : { ...state, [action.targetId]: next };
    }
    case "pin": {
      const current = state[action.targetId];
      if (!current?.takes.some((take) => take.id === action.takeId)) return state;
      return { ...state, [action.targetId]: pinTake(current, action.takeId, action.pinned) };
    }
    case "clear": {
      if (!Object.hasOwn(state, action.targetId)) return state;
      const next = { ...state };
      delete next[action.targetId];
      return next;
    }
    case "reset":
      return Object.keys(state).length === 0 ? state : {};
  }
}

export interface UseTakesReturn<TAudio = TakeAudio> {
  stacks: TakesState<TAudio>;
  /** Create the target's stack if needed; call before rendering its takes. */
  openTakes: (targetId: string) => void;
  /** Ignored unless the target's stack is open. */
  addTake: (targetId: string, take: Take<TAudio>, options?: { activate?: boolean }) => void;
  setActiveTake: (targetId: string, takeId: string) => void;
  removeTake: (targetId: string, takeId: string) => void;
  pinTake: (targetId: string, takeId: string, pinned: boolean) => void;
  clearTakes: (targetId: string) => void;
  resetTakes: () => void;
}

/** In-memory take stacks for the current session, one per segment or script. */
export function useTakes<TAudio = TakeAudio>(options: { maxTakes?: number } = {}): UseTakesReturn<TAudio> {
  const [stacks, dispatch] = useReducer(
    takesReducer as (state: TakesState<TAudio>, action: TakesAction<TAudio>) => TakesState<TAudio>,
    {} as TakesState<TAudio>,
  );
  const { maxTakes } = options;

  const open = useCallback((targetId: string) => {
    dispatch({ type: "open", targetId, maxTakes });
  }, [maxTakes]);

  return useMemo(() => ({
    stacks,
    openTakes: open,
    addTake: (targetId, take, addOptions = {}) => dispatch({ type: "add", targetId, take, activate: addOptions.activate }),
    setActiveTake: (targetId, takeId) => dispatch({ type: "activate", targetId, takeId }),
    removeTake: (targetId, takeId) => dispatch({ type: "remove", targetId, takeId }),
    pinTake: (targetId, takeId, pinned) => dispatch({ type: "pin", targetId, takeId, pinned }),
    clearTakes: (targetId) => dispatch({ type: "clear", targetId }),
    resetTakes: () => dispatch({ type: "reset" }),
  }), [open, stacks]);
}
