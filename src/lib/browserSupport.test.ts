import { describe, expect, it } from "vitest";
import {
  getDefaultSupportedModel,
  getLocalBrowserSupport,
  IOS_KOKORO_UNSUPPORTED_MESSAGE,
  IOS_PARTIAL_SUPPORT_MESSAGE,
  isIOSBrowser,
  isModelSupportedInBrowser,
} from "./browserSupport";

describe("browserSupport", () => {
  it("enables iPhone browsers with a guarded model set", () => {
    expect(
      getLocalBrowserSupport(
        {
          userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)",
          platform: "iPhone",
          maxTouchPoints: 5,
        },
        false,
      ),
    ).toEqual({
      isSupported: true,
      isIOS: true,
      message: IOS_PARTIAL_SUPPORT_MESSAGE,
      supportedModels: ["supertonic"],
      unsupportedModelMessages: {
        kokoro: IOS_KOKORO_UNSUPPORTED_MESSAGE,
      },
    });
  });

  it("detects iPadOS devices that identify as MacIntel", () => {
    expect(
      isIOSBrowser({
        userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15)",
        platform: "MacIntel",
        maxTouchPoints: 5,
      }),
    ).toBe(true);
  });

  it("keeps Electron runtimes enabled", () => {
    expect(
      getLocalBrowserSupport(
        {
          userAgent: "Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X)",
          platform: "iPad",
          maxTouchPoints: 5,
        },
        true,
      ),
    ).toEqual({
      isSupported: true,
      isIOS: false,
      message: null,
      supportedModels: ["kokoro", "supertonic"],
      unsupportedModelMessages: {},
    });
  });

  it("reports Kokoro as unavailable on iOS", () => {
    const support = getLocalBrowserSupport(
      {
        userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)",
        platform: "iPhone",
        maxTouchPoints: 5,
      },
      false,
    );

    expect(isModelSupportedInBrowser("supertonic", support)).toBe(true);
    expect(isModelSupportedInBrowser("kokoro", support)).toBe(false);
    expect(getDefaultSupportedModel(support)).toBe("supertonic");
  });
});
