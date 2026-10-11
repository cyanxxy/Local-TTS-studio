import path from "path";
import type { LocalModel } from "../localTtsIpc";

const FORWARDED_ENV_PREFIXES = [
  "CUDA_",
  "HF_",
  "HUGGINGFACE_",
  "OPEN_TTS_NEUCODEC_",
  "TTS_",
];

const FORWARDED_ENV_KEYS = new Set([
  "HOME",
  "LANG",
  "LC_ALL",
  "LOGNAME",
  "PATH",
  "REQUESTS_CA_BUNDLE",
  "SSL_CERT_FILE",
  "SHELL",
  "SystemRoot",
  "TEMP",
  "TMP",
  "TMPDIR",
  "USER",
  "USERPROFILE",
  "WINDIR",
]);

/** The bridge inherits only an allow-list of the app's environment. */
export function shouldForwardRustBridgeEnv(key: string): boolean {
  return FORWARDED_ENV_PREFIXES.some((prefix) => key.startsWith(prefix)) || FORWARDED_ENV_KEYS.has(key);
}

/**
 * The environment a bridge child runs with: the forwarded allow-list, with the
 * Hugging Face caches pinned inside the model's own cache directory.
 */
export function buildRustBridgeEnv(cacheDir: string, source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const hfHome = path.join(cacheDir, "huggingface");
  const env: NodeJS.ProcessEnv = {};

  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined && shouldForwardRustBridgeEnv(key)) {
      env[key] = value;
    }
  }

  env.HF_HOME = hfHome;
  env.HF_HUB_CACHE = path.join(hfHome, "hub");
  env.HUGGINGFACE_HUB_CACHE = path.join(hfHome, "hub");

  return env;
}

export interface BridgeEnvironmentOptions {
  isDev: boolean;
  userDataPath: () => string;
  /** The app root (`app.getAppPath()`), where development builds keep the binaries. */
  appPath: () => string;
  /** The packaged resources directory (`process.resourcesPath`). */
  resourcesPath: () => string;
}

export interface BridgeEnvironment {
  /** Per-model cache directory; also the bridge child's working directory. */
  cacheDir(model: LocalModel): string;
  bridgeBinaryPath(): string;
  hfXetDownloaderBinaryPath(): string;
}

export function createBridgeEnvironment({
  isDev,
  userDataPath,
  appPath,
  resourcesPath,
}: BridgeEnvironmentOptions): BridgeEnvironment {
  const binaryPath = (name: string) => path.join(
    isDev ? appPath() : resourcesPath(),
    "dist-rust",
    process.platform === "win32" ? `${name}.exe` : name,
  );
  return {
    cacheDir: (model) => path.join(userDataPath(), "local-model-cache", model),
    bridgeBinaryPath: () => binaryPath("open-tts-local-bridge"),
    hfXetDownloaderBinaryPath: () => binaryPath("open-tts-hf-xet-downloader"),
  };
}
