import { useMemo } from "react";
import { getEngine } from "../models/registry";
import { useSynthesisSession } from "../shared/synthesisSessionContext";
import { AudioPlayer } from "./AudioPlayer";
import { Controls } from "./Controls";
import { ControlsProvider } from "./ControlsContext";
import { CreatorToolsPanel } from "./CreatorToolsPanel";
import { DownloadProgress } from "./DownloadProgress";
import { ModelToggle } from "./ModelToggle";
import { SettingsPanel } from "./SettingsPanel";
import { TextInput } from "./TextInput";
import { VoiceSelector } from "./VoiceSelector";
import { renderSurfaceEngineSettings } from "./surfaceEngineSettings";

/** Studio: the script, the model and voice controls, and the player. */
export function StudioSurface() {
  const session = useSynthesisSession();
  const { creator, creatorEngineSupport, documents, engines, environment, player, studio } = session;
  const { browserSupport } = environment;
  const { kokoro: kokoroState, supertonic: supertonicState } = engines.browser.states;
  const usesDesktopModel = studio.desktopModel !== null;
  const runtime = studio.runtime;
  const downloadStates = useMemo(() => ({
    kokoro: kokoroState,
    supertonic: supertonicState,
    ...(studio.desktopModel === "supertonic3" ? { supertonic3: engines.runtimes.supertonic3.modelState } : {}),
  }), [engines.runtimes.supertonic3.modelState, kokoroState, studio.desktopModel, supertonicState]);
  const hasAudio = player.state.totalDuration > 0;

  return (
    <>
      <DownloadProgress states={downloadStates} />

      <div className="mt-6 surface rounded-[24px]">
        <div className="grid grid-cols-1 md:grid-cols-5">
          {/* Left: text input */}
          <div className="flex min-h-[320px] flex-col border-border/40 p-4 sm:min-h-[360px] sm:p-6 md:col-span-3 md:border-r">
            <span className="text-sm font-semibold text-text-secondary mb-3 flex-shrink-0">Script</span>
            <div className="flex-1 min-h-0">
              <TextInput
                text={studio.text}
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
              visibleModels={browserSupport.supportedModels}
              unavailableModels={browserSupport.unsupportedModelMessages}
            />

            {renderSurfaceEngineSettings(session, studio.desktopModel)}

            {!usesDesktopModel && (
              <VoiceSelector
                activeModel={engines.activeModel}
                voice={engines.voice}
                onVoiceChange={engines.changeVoice}
                kokoroVoices={engines.kokoroVoices}
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

      {!usesDesktopModel && (
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
