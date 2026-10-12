import { useMemo, useState } from "react";
import { AudioLines, MessagesSquare } from "lucide-react";
import { useGenerationHistory } from "../hooks/useGenerationHistory";
import { useStudioHistory } from "../hooks/useStudioHistory";
import { useStudioTakes } from "../hooks/useStudioTakes";
import { getEngine } from "../models/registry";
import { useSynthesisSession } from "../shared/synthesisSessionContext";
import { AudioPlayer } from "./AudioPlayer";
import { Controls } from "./Controls";
import { ControlsProvider } from "./ControlsContext";
import { CreatorToolsPanel } from "./CreatorToolsPanel";
import { DialogueStudio } from "./DialogueStudio";
import { DownloadProgress } from "./DownloadProgress";
import { ModelToggle } from "./ModelToggle";
import { SettingsPanel } from "./SettingsPanel";
import { StudioHistoryPanel } from "./StudioHistoryPanel";
import { StudioTakesPanel } from "./StudioTakesPanel";
import { TextInput } from "./TextInput";
import { VoiceSelector } from "./VoiceSelector";
import { renderSurfaceEngineSettings } from "./surfaceEngineSettings";

/** Studio: the script, the model and voice controls, and the player. */
export function StudioSurface() {
  const session = useSynthesisSession();
  const { creator, creatorEngineSupport, documents, engines, environment, player, studio } = session;
  const { browserSupport } = environment;
  const { states: browserStates } = engines.browser;
  const { kokoro: kokoroState, supertonic: supertonicState } = browserStates;
  const usesDesktopModel = studio.desktopModel !== null;
  const runtime = studio.runtime;
  const downloadStates = useMemo(() => ({
    ...browserStates,
    ...(studio.desktopModel === "supertonic3" ? { supertonic3: engines.runtimes.supertonic3.modelState } : {}),
  }), [browserStates, engines.runtimes.supertonic3.modelState, studio.desktopModel]);
  const hasAudio = player.state.totalDuration > 0;
  const { changeText, text: script } = studio;
  // Tags go at the end; the user moves them where they belong.
  const insertTag = (tag: string) => changeText(`${script}${/(^|\s)$/.test(script) ? "" : " "}${tag}`);
  const [mode, setMode] = useState<"single" | "dialogue">("single");
  const history = useGenerationHistory();
  const historyActions = useStudioHistory({ session, history });
  const takes = useStudioTakes(session);

  return (
    <>
      <DownloadProgress states={downloadStates} />

      <div role="group" aria-label="Studio mode" className="mt-6 flex w-fit gap-1 rounded-full bg-text-primary/[0.06] p-1">
        {([
          { id: "single", label: "Single voice", Icon: AudioLines },
          { id: "dialogue", label: "Dialogue", Icon: MessagesSquare },
        ] as const).map(({ id, label, Icon }) => (
          <button
            key={id}
            type="button"
            aria-pressed={mode === id}
            onClick={() => setMode(id)}
            className={`flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-xs font-semibold transition-colors ${
              mode === id ? "bg-panel text-text-primary shadow-glass-sm" : "text-text-secondary hover:text-text-primary"
            }`}
          >
            <Icon size={13} aria-hidden="true" />
            {label}
          </button>
        ))}
      </div>

      {/* Kept mounted so the script, casting and a running render survive switching modes. */}
      <div hidden={mode !== "dialogue"}>
        <DialogueStudio />
      </div>

      {mode === "single" && (
      <div className="mt-4 surface rounded-[24px]">
        <div className="grid grid-cols-1 md:grid-cols-5">
          {/* Left: text input */}
          <div className="flex min-h-[320px] flex-col border-border/40 p-4 sm:min-h-[360px] sm:p-6 md:col-span-3 md:border-r">
            <span className="text-sm font-semibold text-text-secondary mb-3 flex-shrink-0">Script</span>
            <div className="flex-1 min-h-0">
              <TextInput
                text={studio.text}
                spokenText={studio.spokenText}
                onTextChange={studio.changeText}
                onImportDocument={documents.importDocument}
                isImportingDocument={documents.isImporting}
              />
            </div>
          </div>

          {/* Right: controls */}
          <div className="flex flex-col gap-5 border-t border-border/40 p-4 sm:gap-6 sm:p-6 md:col-span-2 md:border-t-0">
            <ModelToggle
              activeModel={engines.activeModel}
              onModelChange={studio.changeModel}
              desktopModelOptions={engines.desktopModelOptions.studio}
              kokoroState={kokoroState}
              supertonicState={supertonicState}
              modelStates={browserStates}
              visibleModels={browserSupport.supportedModels}
              unavailableModels={engines.unavailableModels}
            />

            {renderSurfaceEngineSettings(session, studio.desktopModel, insertTag)}

            {!usesDesktopModel && (
              <VoiceSelector
                activeModel={engines.activeModel}
                voice={engines.voice}
                onVoiceChange={engines.changeVoice}
                kokoroVoices={engines.kokoroVoices}
                modelState={browserStates[engines.activeModel]}
              />
            )}

            <ControlsProvider
              value={{
                // Only engines with a quality range get the slider.
                qualityRange: getEngine(studio.engineId).capabilities.quality,
                quality: engines.quality,
                onQualityChange: engines.changeQuality,
                onGenerate: studio.generate,
                onRetryLoad: studio.retryLoad,
                onStop: studio.stop,
                isGenerating: runtime.isGenerating,
                canGenerate: runtime.canGenerate,
                modelReady: runtime.modelState.ready,
                modelError: runtime.modelState.error,
                loadingProgress: runtime.modelState.downloadProgress,
                generationProgress: runtime.generationProgress,
              }}
            >
              <Controls />
            </ControlsProvider>
          </div>
        </div>

        {player.show && (
          <div className="border-t border-border/40 animate-fade-up">
            <AudioPlayer
              embedded
              isPlaying={player.state.isPlaying}
              clock={player.state.clock}
              totalDuration={player.state.totalDuration}
              segmentCount={player.state.segments.length}
              activeSegmentNumber={player.activeSegmentNumber}
              stats={runtime.stats}
              isGenerating={runtime.isGenerating}
              allowPlaybackDuringGeneration
              playbackRate={player.state.playbackRate}
              onPlaybackRateChange={player.state.setPlaybackRate}
              onTogglePlay={player.togglePlay}
              onSeek={player.state.seek}
              onSkipBackward={player.skipBackward}
              onSkipForward={player.skipForward}
              onDownload={player.downloadAudio}
              onStop={studio.stop}
            />
          </div>
        )}
      </div>
      )}

      {mode === "single" && (
        <div className="mt-4">
          <StudioTakesPanel
            takes={takes}
            disabled={runtime.isGenerating}
            activeSegmentId={player.state.activeSegmentId}
          />
        </div>
      )}

      {mode === "single" && !usesDesktopModel && (
        <div className="mt-4">
          <SettingsPanel
            activeModel={engines.activeModel}
            busy={engines.browser.cacheBusy || engines.currentModelState.loading}
            status={engines.browser.cacheStatus}
            onClearCache={engines.browser.clearCache}
            onRedownloadActive={engines.browser.redownloadActiveModel}
          />
        </div>
      )}

      {mode === "single" && (
        <div className="mt-4">
          <StudioHistoryPanel
            entries={history.entries}
            usage={history.usage}
            loading={history.loading}
            error={historyActions.error ?? history.error}
            onReplay={(id) => void historyActions.replay(id)}
            onDownload={(entry) => void historyActions.download(entry)}
            onReuse={(id) => void historyActions.reuse(id)}
            onSetFavorite={history.setFavorite}
            onDelete={history.deleteEntry}
            onClear={history.clear}
          />
        </div>
      )}

      <div className="mt-4">
        <CreatorToolsPanel
          creator={creator}
          engineSupport={creatorEngineSupport}
          script={studio.text}
          onScriptChange={studio.changeText}
          sourceSampleRate={hasAudio ? player.state.getSourceSampleRate() : null}
          hasAudio={hasAudio}
          audioExport={player.audioExport}
          onDownloadCaptions={player.downloadCaptions}
        />
      </div>
    </>
  );
}
