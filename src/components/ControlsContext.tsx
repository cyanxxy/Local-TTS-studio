/* eslint-disable react-refresh/only-export-components */
import { createContext, useContext, type ReactNode } from "react";
import type { ModelType } from "../types";

export interface ControlsContextValue {
  activeModel: ModelType;
  quality: number;
  onQualityChange: (quality: number) => void;
  onGenerate: () => void;
  onRetryLoad: () => void;
  onStop: () => void;
  isGenerating: boolean;
  canGenerate: boolean;
  modelReady: boolean;
  modelError: string | null;
  loadingProgress: number;
  generationProgress: number;
}

const ControlsContext = createContext<ControlsContextValue | null>(null);

interface ControlsProviderProps {
  value: ControlsContextValue;
  children: ReactNode;
}

export function ControlsProvider({ value, children }: ControlsProviderProps) {
  return <ControlsContext.Provider value={value}>{children}</ControlsContext.Provider>;
}

export function useControlsContext(): ControlsContextValue {
  const value = useContext(ControlsContext);
  if (!value) {
    throw new Error("Controls must be rendered inside ControlsProvider.");
  }
  return value;
}
