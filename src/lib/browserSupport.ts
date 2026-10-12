import type { ModelType } from "../types";
import { BROWSER_ENGINE_IDS, engineRequiresWebGPU, getEngine } from "../models/registry";
import type { EngineTarget } from "../models/types";

interface NavigatorLike {
  userAgent?: string;
  platform?: string;
  maxTouchPoints?: number;
}

function browserModelsFor(target: EngineTarget): readonly ModelType[] {
  return BROWSER_ENGINE_IDS.filter((id) => (getEngine(id).targets as readonly EngineTarget[]).includes(target));
}

const ALL_LOCAL_MODELS = browserModelsFor("web");
// Electron replaces the legacy Supertonic 2 browser runtime with Supertonic 3.
const ELECTRON_BROWSER_MODELS = browserModelsFor("desktop");

export interface LocalBrowserSupport {
  isSupported: boolean;
  isIOS: boolean;
  message: string | null;
  supportedModels: readonly ModelType[];
  unsupportedModelMessages: Partial<Record<ModelType, string>>;
}

export const IOS_PARTIAL_SUPPORT_MESSAGE =
  "iPhone and iPad browsers can run Open TTS locally, but this release enables Supertonic only on iOS. Kokoro stays disabled on iOS pending additional validation.";

export const IOS_KOKORO_UNSUPPORTED_MESSAGE =
  "Kokoro is still disabled on iPhone and iPad browsers. Use Supertonic on iOS, or switch to a desktop browser or the desktop app for Kokoro.";

export function isIOSBrowser(navigatorLike?: NavigatorLike): boolean {
  if (!navigatorLike) return false;

  const userAgent = navigatorLike.userAgent ?? "";
  const platform = navigatorLike.platform ?? "";
  const maxTouchPoints = navigatorLike.maxTouchPoints ?? 0;

  if (/iPad|iPhone|iPod/i.test(userAgent) || /iPad|iPhone|iPod/i.test(platform)) {
    return true;
  }

  // iPadOS can identify itself as MacIntel while still exposing touch input.
  return platform === "MacIntel" && maxTouchPoints > 1;
}

export function getLocalBrowserSupport(
  navigatorLike: NavigatorLike | undefined,
  isElectronRuntime: boolean,
): LocalBrowserSupport {
  if (isElectronRuntime) {
    return {
      isSupported: true,
      isIOS: false,
      message: null,
      supportedModels: ELECTRON_BROWSER_MODELS,
      unsupportedModelMessages: {},
    };
  }

  const isIOS = isIOSBrowser(navigatorLike);
  if (!isIOS) {
    return {
      isSupported: true,
      isIOS: false,
      message: null,
      supportedModels: ALL_LOCAL_MODELS,
      unsupportedModelMessages: {},
    };
  }

  return {
    isSupported: true,
    isIOS: true,
    message: IOS_PARTIAL_SUPPORT_MESSAGE,
    supportedModels: ["supertonic"],
    unsupportedModelMessages: {
      kokoro: IOS_KOKORO_UNSUPPORTED_MESSAGE,
    },
  };
}

export function isModelSupportedInBrowser(
  model: ModelType,
  browserSupport: LocalBrowserSupport,
): boolean {
  return browserSupport.supportedModels.includes(model);
}

export function getDefaultSupportedModel(browserSupport: LocalBrowserSupport): ModelType {
  return browserSupport.supportedModels[0] ?? "supertonic";
}

export function getUnsupportedModelMessage(
  model: ModelType,
  browserSupport: LocalBrowserSupport,
): string | null {
  return browserSupport.unsupportedModelMessages[model] ?? null;
}

/**
 * Why a browser model cannot be used on this device, for models that need
 * WebGPU when it is known to be missing. `webgpuAvailable` is null while the
 * check is still running, in which case nothing is ruled out yet.
 */
export function getWebGPUUnavailableModelMessages(
  webgpuAvailable: boolean | null,
): Partial<Record<ModelType, string>> {
  if (webgpuAvailable !== false) return {};
  return Object.fromEntries(
    BROWSER_ENGINE_IDS.filter(engineRequiresWebGPU).map((id) => [
      id,
      `${getEngine(id).label} needs WebGPU, which this device does not provide.`,
    ]),
  );
}

/** `support` without the models in `unavailable`, which this device cannot run. */
export function withoutUnavailableModels(
  support: LocalBrowserSupport,
  unavailable: Partial<Record<ModelType, string>>,
): LocalBrowserSupport {
  const supportedModels = support.supportedModels.filter((model) => !(model in unavailable));
  return supportedModels.length === support.supportedModels.length ? support : { ...support, supportedModels };
}
