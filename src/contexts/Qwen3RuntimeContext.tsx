import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type {
  LocalTtsQwen3DownloadProgress,
  LocalTtsQwen3ProfileSetup,
  LocalTtsQwen3Setup,
} from "../electron";
import {
  getDefaultQwen3Profile,
  getQwen3Profile,
  getQwen3Profiles,
  QWEN3_LANGUAGES,
  QWEN3_SPEAKERS,
  type Qwen3Profile,
} from "../../electron/qwen3Profiles";

export const QWEN3_DEFAULT_MAX_NEW_TOKENS = 1_536;

export interface Qwen3RuntimeSettings {
  profile: Qwen3Profile;
  modelPath: string;
  readiness: "missing" | "structural" | "verified";
  speaker: string;
  language: string;
  instruct: string;
  temperature: number;
  topK: number;
  maxNewTokens: number;
  referenceAudioName: string;
  referenceAudioBase64: string | null;
  referenceAudioSignature: string;
  referenceText: string;
}

interface Qwen3RuntimeContextValue extends Qwen3RuntimeSettings {
  available: boolean;
  profiles: readonly Qwen3Profile[];
  profileSetup: LocalTtsQwen3ProfileSetup | null;
  setup: LocalTtsQwen3Setup | null;
  setupBusy: boolean;
  downloadBusy: boolean;
  downloadProgress: LocalTtsQwen3DownloadProgress | null;
  error: string | null;
  setProfileRepo: (repo: string) => void;
  setModelPath: (path: string) => void;
  setSpeaker: (speaker: string) => void;
  setLanguage: (language: string) => void;
  setInstruct: (instruct: string) => void;
  setTemperature: (temperature: number) => void;
  setTopK: (topK: number) => void;
  setMaxNewTokens: (maxNewTokens: number) => void;
  setReferenceAudio: (name: string, base64: string | null, signature?: string) => void;
  setReferenceText: (text: string) => void;
  refreshSetup: () => Promise<void>;
  downloadModel: () => Promise<void>;
  chooseModelPath: () => Promise<void>;
  clearError: () => void;
}

const Qwen3RuntimeContext = createContext<Qwen3RuntimeContextValue | null>(null);

function clamp(value: number, fallback: number, min: number, max: number): number {
  return Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function Qwen3RuntimeProvider({ children }: { children: ReactNode }) {
  const platform = window.electron?.platform;
  const arch = window.electron?.arch;
  const profiles = useMemo(() => getQwen3Profiles(platform, arch), [arch, platform]);
  const initialProfile = useMemo(() => {
    try {
      return getDefaultQwen3Profile(platform, arch);
    } catch {
      return getDefaultQwen3Profile("darwin", "arm64");
    }
  }, [arch, platform]);
  const [profile, setProfile] = useState<Qwen3Profile>(initialProfile);
  const [modelPath, setModelPathState] = useState("");
  const [readiness, setReadiness] = useState<Qwen3RuntimeSettings["readiness"]>("missing");
  const [speaker, setSpeakerState] = useState<string>(QWEN3_SPEAKERS[0]);
  const [language, setLanguageState] = useState<string>(QWEN3_LANGUAGES[0]);
  const [instruct, setInstruct] = useState("");
  const [temperature, setTemperatureState] = useState(0.9);
  const [topK, setTopKState] = useState(50);
  const [maxNewTokens, setMaxNewTokensState] = useState(QWEN3_DEFAULT_MAX_NEW_TOKENS);
  const [referenceAudioName, setReferenceAudioName] = useState("");
  const [referenceAudioBase64, setReferenceAudioBase64] = useState<string | null>(null);
  const [referenceAudioSignature, setReferenceAudioSignature] = useState("");
  const [referenceText, setReferenceText] = useState("");
  const [setup, setSetup] = useState<LocalTtsQwen3Setup | null>(null);
  const [setupBusy, setSetupBusy] = useState(false);
  const [downloadBusy, setDownloadBusy] = useState(false);
  const [downloadProgress, setDownloadProgress] = useState<LocalTtsQwen3DownloadProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(true);
  const setupVersionRef = useRef(0);
  const modelPathOperationVersionRef = useRef(0);
  const downloadVersionRef = useRef(0);

  const available = !!window.electron?.localTts && profiles.length > 0;
  const profileSetup = useMemo(
    () => setup?.profiles.find((candidate) => candidate.repo === profile.repo) ?? null,
    [profile.repo, setup],
  );

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const applyProfileSetup = useCallback((selected: Qwen3Profile, nextSetup: LocalTtsQwen3Setup) => {
    const entry = nextSetup.profiles.find((candidate) => candidate.repo === selected.repo);
    if (!entry) {
      setModelPathState("");
      setReadiness("missing");
      return;
    }
    setModelPathState(entry.modelDir);
    setReadiness(entry.readiness);
  }, []);

  const refreshSetup = useCallback(async () => {
    const bridge = window.electron?.localTts;
    if (!bridge?.getQwen3Setup) return;
    const version = ++setupVersionRef.current;
    setSetupBusy(true);
    setError(null);
    try {
      const nextSetup = await bridge.getQwen3Setup({ modelRepo: profile.repo });
      if (!mountedRef.current || version !== setupVersionRef.current) return;
      setSetup(nextSetup);
      applyProfileSetup(profile, nextSetup);
    } catch (nextError) {
      if (mountedRef.current && version === setupVersionRef.current) setError(errorMessage(nextError));
    } finally {
      if (mountedRef.current && version === setupVersionRef.current) setSetupBusy(false);
    }
  }, [applyProfileSetup, profile]);

  useEffect(() => {
    if (available) void refreshSetup();
  }, [available, refreshSetup]);

  useEffect(() => {
    const subscribe = window.electron?.localTts?.subscribeQwen3DownloadProgress;
    if (!subscribe) return;
    return subscribe((progress) => {
      if (mountedRef.current && progress.modelRepo === profile.repo) setDownloadProgress(progress);
    });
  }, [profile.repo]);

  const setProfileRepo = useCallback((repo: string) => {
    const next = getQwen3Profile(repo);
    if (!next || !profiles.some((candidate) => candidate.repo === repo)) return;
    setupVersionRef.current += 1;
    modelPathOperationVersionRef.current += 1;
    downloadVersionRef.current += 1;
    setDownloadBusy(false);
    setProfile(next);
    setReferenceAudioName("");
    setReferenceAudioBase64(null);
    setReferenceAudioSignature("");
    setReferenceText("");
    const entry = setup?.profiles.find((candidate) => candidate.repo === repo);
    setModelPathState(entry?.modelDir ?? "");
    setReadiness(entry?.readiness ?? "missing");
    setDownloadProgress(null);
    setError(null);
  }, [profiles, setup]);

  const setModelPath = useCallback((nextPath: string) => {
    setupVersionRef.current += 1;
    modelPathOperationVersionRef.current += 1;
    setModelPathState(nextPath);
    const bundledPath = setup?.profiles.find((candidate) => candidate.repo === profile.repo)?.modelDir;
    setReadiness(nextPath.trim() && nextPath !== bundledPath ? "structural" : profileSetup?.readiness ?? "missing");
  }, [profile.repo, profileSetup?.readiness, setup]);

  const downloadModel = useCallback(async () => {
    const bridge = window.electron?.localTts;
    if (!bridge?.downloadQwen3Model) return;
    const operationVersion = ++modelPathOperationVersionRef.current;
    const downloadVersion = ++downloadVersionRef.current;
    setupVersionRef.current += 1;
    setDownloadBusy(true);
    setDownloadProgress(null);
    setError(null);
    try {
      const result = await bridge.downloadQwen3Model({ modelRepo: profile.repo });
      if (
        !mountedRef.current
        || operationVersion !== modelPathOperationVersionRef.current
        || downloadVersion !== downloadVersionRef.current
      ) return;
      setModelPathState(result.modelDir);
      setReadiness(result.readiness);
      await refreshSetup();
    } catch (nextError) {
      if (mountedRef.current && downloadVersion === downloadVersionRef.current) {
        setError(errorMessage(nextError));
      }
    } finally {
      if (mountedRef.current && downloadVersion === downloadVersionRef.current) {
        setDownloadBusy(false);
      }
    }
  }, [profile.repo, refreshSetup]);

  const chooseModelPath = useCallback(async () => {
    const bridge = window.electron?.localTts;
    if (!bridge?.chooseQwen3ModelDir) return;
    const operationVersion = ++modelPathOperationVersionRef.current;
    setupVersionRef.current += 1;
    try {
      const result = await bridge.chooseQwen3ModelDir({ modelRepo: profile.repo });
      if (
        !mountedRef.current
        || operationVersion !== modelPathOperationVersionRef.current
        || !result.path
      ) return;
      setModelPathState(result.path);
      setReadiness(result.readiness ?? "missing");
      setError(result.readiness === "missing" ? result.reason ?? "The selected folder is not a compatible model." : null);
    } catch (nextError) {
      if (mountedRef.current && operationVersion === modelPathOperationVersionRef.current) {
        setError(errorMessage(nextError));
      }
    }
  }, [profile.repo]);

  const setSpeaker = useCallback((nextSpeaker: string) => {
    if (QWEN3_SPEAKERS.includes(nextSpeaker as typeof QWEN3_SPEAKERS[number])) setSpeakerState(nextSpeaker);
  }, []);
  const setLanguage = useCallback((nextLanguage: string) => {
    if (QWEN3_LANGUAGES.includes(nextLanguage as typeof QWEN3_LANGUAGES[number])) setLanguageState(nextLanguage);
  }, []);
  const setTemperature = useCallback((value: number) => setTemperatureState((current) => clamp(value, current, 0.2, 2)), []);
  const setTopK = useCallback((value: number) => setTopKState((current) => Math.round(clamp(value, current, 0, 1_000))), []);
  const setMaxNewTokens = useCallback(
    (value: number) => setMaxNewTokensState((current) => Math.round(clamp(value, current, 64, 8_192))),
    [],
  );
  const setReferenceAudio = useCallback((name: string, base64: string | null, signature = "") => {
    setReferenceAudioName(name);
    setReferenceAudioBase64(base64);
    setReferenceAudioSignature(base64 ? signature : "");
  }, []);

  const value = useMemo<Qwen3RuntimeContextValue>(() => ({
    available,
    profiles,
    profile,
    modelPath,
    readiness,
    profileSetup,
    setup,
    setupBusy,
    downloadBusy,
    downloadProgress,
    error,
    speaker,
    language,
    instruct,
    temperature,
    topK,
    maxNewTokens,
    referenceAudioName,
    referenceAudioBase64,
    referenceAudioSignature,
    referenceText,
    setProfileRepo,
    setModelPath,
    setSpeaker,
    setLanguage,
    setInstruct,
    setTemperature,
    setTopK,
    setMaxNewTokens,
    setReferenceAudio,
    setReferenceText,
    refreshSetup,
    downloadModel,
    chooseModelPath,
    clearError: () => setError(null),
  }), [
    available, chooseModelPath, downloadBusy, downloadModel, downloadProgress, error, instruct, language,
    maxNewTokens, modelPath, profile, profileSetup, profiles, readiness, referenceAudioBase64,
    referenceAudioName, referenceAudioSignature, referenceText, refreshSetup, setLanguage, setMaxNewTokens, setModelPath,
    setProfileRepo, setReferenceAudio, setSpeaker, setTemperature, setTopK, setup, setupBusy, speaker,
    temperature, topK,
  ]);

  return <Qwen3RuntimeContext.Provider value={value}>{children}</Qwen3RuntimeContext.Provider>;
}

// eslint-disable-next-line react-refresh/only-export-components
export function useQwen3Runtime(): Qwen3RuntimeContextValue {
  const value = useContext(Qwen3RuntimeContext);
  if (!value) throw new Error("useQwen3Runtime must be used inside Qwen3RuntimeProvider.");
  return value;
}
