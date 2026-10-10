import { dialog, type WebContents } from "electron";
import path from "path";
import { runHfXetDownloader } from "../hfXetDownload";
import type { LocalModelLifecycle } from "../localModelLifecycle";
import { isRecord, type LocalModel } from "../localTtsIpc";
import {
  adoptLegacyQwen3ModelDir,
  createQwen3ModelDownloadCoordinator,
  createSafeProgressSender,
  downloadQwen3Model,
  inspectQwen3ModelDir,
  requestUrl,
  type Qwen3ModelDownloadResult,
  type Qwen3ModelReadiness,
} from "../qwen3ModelDownload";
import {
  getDefaultQwen3Profile,
  getQwen3Profile,
  getQwen3Profiles,
  qwen3ProfileSupportsRuntime,
  type Qwen3Profile,
} from "../qwen3Profiles";
import type { BridgeEnvironment } from "./bridgeEnvironment";

export interface Qwen3SetupResult {
  provider: Qwen3Profile["provider"];
  profiles: Array<Qwen3Profile & { modelDir: string; readiness: Qwen3ModelReadiness; reason?: string }>;
  recommendedModelRepo: string;
  recommendedModelDir: string;
}

export interface Qwen3ModelDirChoice {
  path: string | null;
  readiness?: Qwen3ModelReadiness;
  reason?: string;
}

export interface Qwen3SetupOptions {
  environment: BridgeEnvironment;
  /** Shared with generation, so cache deletion waits for setup and downloads too. */
  lifecycle: LocalModelLifecycle<LocalModel>;
  /** Throws once the quit has started. */
  assertAcceptingRequests: () => void;
}

export interface Qwen3SetupHandlers {
  setup(request: unknown): Promise<Qwen3SetupResult>;
  download(request: unknown, sender: WebContents): Promise<Qwen3ModelDownloadResult>;
  chooseModelDir(request: unknown): Promise<Qwen3ModelDirChoice>;
}

/** Qwen3 model inventory, managed downloads and manual model folders. */
export function createQwen3SetupHandlers({
  environment,
  lifecycle,
  assertAcceptingRequests,
}: Qwen3SetupOptions): Qwen3SetupHandlers {
  function getQwen3ModelDir(profile: Qwen3Profile): string {
    const dirName = profile.repo.split("/").at(-1);
    if (!dirName || !/^[A-Za-z0-9._-]+$/.test(dirName)) throw new Error("Invalid Qwen3 model repository.");
    return path.join(environment.cacheDir("qwen3"), profile.provider, `${dirName}-${profile.revision.slice(0, 12)}`);
  }

  function getLegacyQwen3ModelDir(profile: Qwen3Profile): string {
    const dirName = profile.repo.split("/").at(-1);
    if (!dirName || !/^[A-Za-z0-9._-]+$/.test(dirName)) throw new Error("Invalid Qwen3 model repository.");
    return path.join(environment.cacheDir("qwen3"), profile.provider, dirName);
  }

  async function resolveQwen3ModelDir(profile: Qwen3Profile): Promise<string> {
    return adoptLegacyQwen3ModelDir(profile, getQwen3ModelDir(profile), getLegacyQwen3ModelDir(profile));
  }

  function getRequestedQwen3Profile(request: unknown): Qwen3Profile {
    const repo = isRecord(request) && typeof request.modelRepo === "string"
      ? request.modelRepo.trim()
      : getDefaultQwen3Profile(process.platform, process.arch).repo;
    const profile = getQwen3Profile(repo);
    if (!profile || !qwen3ProfileSupportsRuntime(profile, process.platform, process.arch)) {
      throw new Error("Unsupported Qwen3 model profile for this platform.");
    }
    return profile;
  }

  const qwen3ModelDownloads = createQwen3ModelDownloadCoordinator(
    (profile, modelDir, onProgress, _request, _xetDownloader, signal) => downloadQwen3Model(
      profile,
      modelDir,
      onProgress,
      requestUrl,
      ({ revision, fileName, destination, onProgress: reportFileProgress, signal }) => runHfXetDownloader({
        binaryPath: environment.hfXetDownloaderBinaryPath(),
        modelRepo: profile.repo,
        revision,
        fileName,
        destination,
        onProgress: reportFileProgress,
        signal,
      }),
      signal,
    ),
  );

  return {
    setup(request) {
      return lifecycle.run("qwen3", async (signal) => {
        const selected = getRequestedQwen3Profile(request);
        // Adoption may rename a model directory. Join every branch before releasing
        // the lifecycle lease, including when another profile fails or is cancelled.
        const inspections = await Promise.allSettled(
          getQwen3Profiles(process.platform, process.arch).map(async (profile) => {
            const modelDir = await resolveQwen3ModelDir(profile);
            const inspection = await inspectQwen3ModelDir(modelDir, profile, signal);
            return { ...profile, modelDir, ...inspection };
          }),
        );
        const profiles = inspections.map((inspection) => {
          if (inspection.status === "rejected") throw inspection.reason;
          return inspection.value;
        });
        return {
          provider: selected.provider,
          profiles,
          recommendedModelRepo: selected.repo,
          recommendedModelDir: await resolveQwen3ModelDir(selected),
        };
      });
    },

    async download(request, sender) {
      assertAcceptingRequests();
      return lifecycle.run("qwen3", async (signal) => {
        const profile = getRequestedQwen3Profile(request);
        const modelDir = await resolveQwen3ModelDir(profile);
        return qwen3ModelDownloads.download(
          profile,
          modelDir,
          createSafeProgressSender(sender, "local-tts:qwen3-download-progress"),
          signal,
        );
      });
    },

    async chooseModelDir(request) {
      const profile = getRequestedQwen3Profile(request);
      const result = await dialog.showOpenDialog({
        title: "Choose Qwen3 model directory",
        properties: ["openDirectory"],
      });
      if (result.canceled || result.filePaths.length === 0) {
        return { path: null };
      }
      const modelPath = result.filePaths[0];
      const inspection = await inspectQwen3ModelDir(modelPath, profile);
      if (inspection.readiness === "missing") return { path: modelPath, ...inspection };
      return {
        path: modelPath,
        readiness: "structural",
        reason: "The selected manual folder passed structural checks but is not a managed, revision-verified download.",
      };
    },
  };
}
