export const QWEN3_LANGUAGES = [
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
] as const;

export const QWEN3_SPEAKERS = [
  "Vivian",
  "Serena",
  "Uncle_Fu",
  "Dylan",
  "Eric",
  "Ryan",
  "Aiden",
  "Ono_Anna",
  "Sohee",
] as const;

export type Qwen3Language = typeof QWEN3_LANGUAGES[number];
export type Qwen3Speaker = typeof QWEN3_SPEAKERS[number];
export type Qwen3Platform = "darwin" | "win32";
export type Qwen3Provider = "mlx" | "libtorch";
export type Qwen3Mode = "customVoice" | "voiceClone" | "voiceDesign";

export interface Qwen3Profile {
  readonly repo: string;
  readonly revision: string;
  readonly mode: Qwen3Mode;
  readonly parameters: "0.6B" | "1.7B";
  readonly provider: Qwen3Provider;
  readonly platforms: readonly Qwen3Platform[];
  readonly weightFormat: "mlx-6bit" | "safetensors";
  readonly label: string;
  readonly requiredFiles: readonly string[];
}

const REQUIRED_MODEL_FILES = [
  "config.json",
  "model.safetensors",
  "vocab.json",
  "merges.txt",
  "speech_tokenizer/config.json",
  "speech_tokenizer/model.safetensors",
] as const;

// Downloaded when the pinned revision ships them, but never required: model
// readiness and generation must not depend on these, because older revisions
// and previously downloaded model directories may lack them. The resident
// bridge currently applies built-in generation defaults either way; the file
// is captured so model directories stay complete for runtimes that read it.
export const QWEN3_OPTIONAL_MODEL_FILES = [
  "generation_config.json",
] as const;

export const QWEN3_PROFILES = [
  {
    repo: "mlx-community/Qwen3-TTS-12Hz-0.6B-CustomVoice-6bit",
    revision: "7dc92af14613355896fcab13b268c19ede233139",
    mode: "customVoice",
    parameters: "0.6B",
    provider: "mlx",
    platforms: ["darwin"],
    weightFormat: "mlx-6bit",
    label: "CustomVoice · 0.6B · MLX 6-bit",
    requiredFiles: REQUIRED_MODEL_FILES,
  },
  {
    repo: "mlx-community/Qwen3-TTS-12Hz-1.7B-CustomVoice-6bit",
    revision: "1c6c0ff58c43afa8df571facde2efa077efd85e2",
    mode: "customVoice",
    parameters: "1.7B",
    provider: "mlx",
    platforms: ["darwin"],
    weightFormat: "mlx-6bit",
    label: "CustomVoice · 1.7B · MLX 6-bit",
    requiredFiles: REQUIRED_MODEL_FILES,
  },
  {
    repo: "mlx-community/Qwen3-TTS-12Hz-0.6B-Base-6bit",
    revision: "4e44ed4bcee28a0f89a493e07bde16e6dccd43eb",
    mode: "voiceClone",
    parameters: "0.6B",
    provider: "mlx",
    platforms: ["darwin"],
    weightFormat: "mlx-6bit",
    label: "Voice clone · 0.6B · MLX 6-bit",
    requiredFiles: REQUIRED_MODEL_FILES,
  },
  {
    repo: "mlx-community/Qwen3-TTS-12Hz-1.7B-Base-6bit",
    revision: "34ff5318365b59cba9c03ff729f2eee0814caf72",
    mode: "voiceClone",
    parameters: "1.7B",
    provider: "mlx",
    platforms: ["darwin"],
    weightFormat: "mlx-6bit",
    label: "Voice clone · 1.7B · MLX 6-bit",
    requiredFiles: REQUIRED_MODEL_FILES,
  },
  {
    repo: "mlx-community/Qwen3-TTS-12Hz-1.7B-VoiceDesign-6bit",
    revision: "ffc6545dc9cb086950aa46c6cd3db490e6ece3e1",
    mode: "voiceDesign",
    parameters: "1.7B",
    provider: "mlx",
    platforms: ["darwin"],
    weightFormat: "mlx-6bit",
    label: "VoiceDesign · 1.7B · MLX 6-bit",
    requiredFiles: REQUIRED_MODEL_FILES,
  },
  {
    repo: "Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice",
    revision: "85e237c12c027371202489a0ec509ded67b5e4b5",
    mode: "customVoice",
    parameters: "0.6B",
    provider: "libtorch",
    platforms: ["win32"],
    weightFormat: "safetensors",
    label: "CustomVoice · 0.6B · CUDA/CPU",
    requiredFiles: REQUIRED_MODEL_FILES,
  },
  {
    repo: "Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice",
    revision: "0c0e3051f131929182e2c023b9537f8b1c68adfe",
    mode: "customVoice",
    parameters: "1.7B",
    provider: "libtorch",
    platforms: ["win32"],
    weightFormat: "safetensors",
    label: "CustomVoice · 1.7B · CUDA/CPU",
    requiredFiles: REQUIRED_MODEL_FILES,
  },
  {
    repo: "Qwen/Qwen3-TTS-12Hz-0.6B-Base",
    revision: "5d83992436eae1d760afd27aff78a71d676296fc",
    mode: "voiceClone",
    parameters: "0.6B",
    provider: "libtorch",
    platforms: ["win32"],
    weightFormat: "safetensors",
    label: "Voice clone · 0.6B · CUDA/CPU",
    requiredFiles: REQUIRED_MODEL_FILES,
  },
  {
    repo: "Qwen/Qwen3-TTS-12Hz-1.7B-Base",
    revision: "fd4b254389122332181a7c3db7f27e918eec64e3",
    mode: "voiceClone",
    parameters: "1.7B",
    provider: "libtorch",
    platforms: ["win32"],
    weightFormat: "safetensors",
    label: "Voice clone · 1.7B · CUDA/CPU",
    requiredFiles: REQUIRED_MODEL_FILES,
  },
  {
    repo: "Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign",
    revision: "5ecdb67327fd37bb2e042aab12ff7391903235d3",
    mode: "voiceDesign",
    parameters: "1.7B",
    provider: "libtorch",
    platforms: ["win32"],
    weightFormat: "safetensors",
    label: "VoiceDesign · 1.7B · CUDA/CPU",
    requiredFiles: REQUIRED_MODEL_FILES,
  },
] as const satisfies readonly Qwen3Profile[];

export function qwen3ProfileSupportsRuntime(
  profile: Qwen3Profile,
  platform: string | undefined,
  arch: string | undefined,
): boolean {
  if (!(profile.platforms as readonly string[]).includes(platform ?? "")) return false;
  // The MLX backend and bundled Metal library are Apple-Silicon-only.
  if (platform === "darwin") return arch === "arm64";
  // The pinned LibTorch distribution/toolchain is Windows x64-only.
  if (platform === "win32") return arch === "x64";
  return false;
}

export function getQwen3Profiles(
  platform: string | undefined,
  arch: string | undefined,
): readonly Qwen3Profile[] {
  return QWEN3_PROFILES.filter((profile) => (
    qwen3ProfileSupportsRuntime(profile, platform, arch)
  ));
}

export function getDefaultQwen3Profile(
  platform: string | undefined,
  arch: string | undefined,
): Qwen3Profile {
  const profile = getQwen3Profiles(platform, arch)[0];
  if (!profile) {
    throw new Error(`Qwen3 is unavailable on platform: ${platform ?? "unknown"}/${arch ?? "unknown"}`);
  }
  return profile;
}

export function getQwen3Profile(repo: string): Qwen3Profile | undefined {
  return QWEN3_PROFILES.find((profile) => profile.repo === repo);
}
