// @vitest-environment node

import { describe, expect, it } from "vitest";
import {
  QWEN3_LANGUAGES,
  QWEN3_PROFILES,
  QWEN3_SPEAKERS,
  getDefaultQwen3Profile,
  getQwen3Profiles,
} from "./qwen3Profiles";

describe("Qwen3 profiles", () => {
  it("pins every approved repository to an immutable revision", () => {
    expect(QWEN3_PROFILES.map(({ repo, revision }) => [repo, revision])).toEqual([
      ["mlx-community/Qwen3-TTS-12Hz-0.6B-CustomVoice-6bit", "7dc92af14613355896fcab13b268c19ede233139"],
      ["mlx-community/Qwen3-TTS-12Hz-1.7B-CustomVoice-6bit", "1c6c0ff58c43afa8df571facde2efa077efd85e2"],
      ["mlx-community/Qwen3-TTS-12Hz-0.6B-Base-6bit", "4e44ed4bcee28a0f89a493e07bde16e6dccd43eb"],
      ["mlx-community/Qwen3-TTS-12Hz-1.7B-Base-6bit", "34ff5318365b59cba9c03ff729f2eee0814caf72"],
      ["Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice", "85e237c12c027371202489a0ec509ded67b5e4b5"],
      ["Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice", "0c0e3051f131929182e2c023b9537f8b1c68adfe"],
      ["Qwen/Qwen3-TTS-12Hz-0.6B-Base", "5d83992436eae1d760afd27aff78a71d676296fc"],
      ["Qwen/Qwen3-TTS-12Hz-1.7B-Base", "fd4b254389122332181a7c3db7f27e918eec64e3"],
    ]);
  });

  it("selects MLX profiles on macOS and LibTorch profiles on Windows", () => {
    expect(getQwen3Profiles("darwin", "arm64")).toHaveLength(4);
    expect(getQwen3Profiles("darwin", "arm64").every((profile) => profile.provider === "mlx")).toBe(true);
    expect(getQwen3Profiles("darwin", "x64")).toHaveLength(0);
    expect(getQwen3Profiles("win32", "x64")).toHaveLength(4);
    expect(getQwen3Profiles("win32", "x64").every((profile) => profile.provider === "libtorch")).toBe(true);
    expect(getQwen3Profiles("win32", "arm64")).toHaveLength(0);
    expect(getQwen3Profiles("linux", "x64")).toHaveLength(0);
    expect(getDefaultQwen3Profile("darwin", "arm64").repo).toBe(
      "mlx-community/Qwen3-TTS-12Hz-0.6B-CustomVoice-6bit",
    );
    expect(getDefaultQwen3Profile("win32", "x64").repo).toBe("Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice");
    expect(() => getDefaultQwen3Profile("darwin", "x64")).toThrow("darwin/x64");
  });

  it("exposes the complete official language and speaker choices", () => {
    expect(QWEN3_LANGUAGES).toEqual([
      "Auto",
      "Chinese",
      "English",
      "Japanese",
      "Korean",
      "German",
      "French",
      "Russian",
      "Portuguese",
      "Spanish",
      "Italian",
    ]);
    expect(QWEN3_SPEAKERS).toEqual([
      "Vivian",
      "Serena",
      "Uncle_Fu",
      "Dylan",
      "Eric",
      "Ryan",
      "Aiden",
      "Ono_Anna",
      "Sohee",
    ]);
  });
});
