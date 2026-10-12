import { Suspense } from "react";
import { useQwen3Runtime } from "../contexts/Qwen3RuntimeContext";
import { getEngine, surfaceEngineVoiceLabel } from "../models/registry";
import { lazyWithRetry } from "../shared/lazyWithRetry";
import { useSynthesisSession } from "../shared/synthesisSessionContext";
import { SurfaceErrorBoundary } from "./SurfaceErrorBoundary";
import { renderSurfaceEngineSettings } from "./surfaceEngineSettings";

// The Reader is a large subtree most sessions never open. It sits inside a
// SurfaceErrorBoundary, so a chunk that fails to load or a page that throws
// costs only the Reader, never Studio's state.
const AdvancedReaderPage = lazyWithRetry(() => import("./AdvancedReaderPage")
  .then((module) => module.AdvancedReaderPage));

interface ReaderSurfaceProps {
  immersive: boolean;
  onImmersiveChange: (immersive: boolean) => void;
}

/** The Reader page, wired to the shared session's library, engines and player. */
export function ReaderSurface({ immersive, onImmersiveChange }: ReaderSurfaceProps) {
  const session = useSynthesisSession();
  const qwen3Settings = useQwen3Runtime();
  const { documents, engines, environment, player, reader, routing } = session;
  const { library, runtime, session: readerSession } = reader;
  const { browserSupport } = environment;
  const { kokoro: kokoroState, supertonic: supertonicState } = engines.browser.states;
  const readerEngine = getEngine(reader.engineId);

  return (
    <SurfaceErrorBoundary name="The Reader" resetKeys={[routing.activePage]}>
      <Suspense fallback={null}>
        <AdvancedReaderPage
          fullScreen
          text={readerSession.activeSectionText}
          onTextChange={readerSession.changeSectionText}
          onEditStart={readerSession.startSectionEdit}
          onEditEnd={readerSession.endSectionEdit}
          onImportDocument={documents.importDocument}
          onImportFile={documents.importReaderFile}
          onImportUrl={documents.importReaderUrl}
          isImportingDocument={documents.isImporting}
          documents={library.documents}
          activeDocument={readerSession.document}
          activeChapter={readerSession.activeChapter}
          activeSection={readerSession.activeSection}
          previousSection={readerSession.previousSection}
          nextSection={readerSession.nextSection}
          onNavigateToOffset={readerSession.navigateToOffset}
          onAutoAdvanceHoldChange={readerSession.setAutoAdvanceHold}
          viewPreferences={reader.viewPreferences}
          onViewPreferencesChange={reader.updateViewPreferences}
          libraryLoading={library.loading}
          libraryError={library.error}
          libraryPersistent={library.persistent}
          onNewDocument={readerSession.newDocument}
          onOpenDocument={readerSession.openDocument}
          onDeleteDocument={readerSession.deleteDocument}
          onUpdateDocumentMetadata={library.updateActiveMetadata}
          onAddBookmark={library.addBookmark}
          onRemoveBookmark={library.removeBookmark}
          onAddNote={library.addNote}
          onUpdateNote={library.updateNote}
          onRemoveNote={library.removeNote}
          onAddHighlight={library.addHighlight}
          onUpdateHighlight={library.updateHighlight}
          onRemoveHighlight={library.removeHighlight}
          activeModel={engines.activeModel}
          onModelChange={reader.changeModel}
          desktopModelOptions={engines.desktopModelOptions.reader}
          desktopQwenMode={reader.desktopModel === "qwen3" ? qwen3Settings.profile.mode : undefined}
          // Unit-streaming engines keep extending a segment's duration while
          // it generates, so estimated word timing settles only afterwards.
          estimatedWordTrackingStable={
            readerEngine.capabilities.streamingGranularity !== "unit" || !runtime.isGenerating
          }
          desktopVoiceLabel={reader.desktopModel
            ? surfaceEngineVoiceLabel(reader.desktopModel, engines.surfaceEngineSettings)
            : undefined}
          desktopModelSettings={renderSurfaceEngineSettings(session, reader.desktopModel)}
          kokoroState={kokoroState}
          supertonicState={supertonicState}
          visibleModels={browserSupport.supportedModels}
          unavailableModels={browserSupport.unsupportedModelMessages}
          kokoroVoices={engines.kokoroVoices}
          voice={engines.voice}
          onVoiceChange={engines.changeVoice}
          quality={engines.quality}
          onQualityChange={engines.changeQuality}
          canGenerate={runtime.canGenerate}
          modelReady={runtime.modelState.ready}
          modelError={runtime.modelState.error}
          loadingProgress={runtime.modelState.downloadProgress}
          generationProgress={runtime.generationProgress}
          isGenerating={runtime.isGenerating}
          onGenerate={reader.generate}
          onRetryLoad={reader.retryLoad}
          onStop={reader.stop}
          stats={runtime.stats}
          isPlaying={player.state.isPlaying}
          clock={player.state.clock}
          totalDuration={player.state.totalDuration}
          playbackRate={player.state.playbackRate}
          onPlaybackRateChange={reader.setPlaybackRate}
          segments={player.state.segments}
          activeSegmentId={player.state.activeSegmentId}
          onTogglePlay={player.togglePlay}
          onSeek={player.state.seek}
          onSkipBackward={player.skipBackward}
          onSkipForward={player.skipForward}
          onDownload={player.downloadAudio}
          isRetaking={readerEngine.capabilities.retake && engines.browser.isRetakingSegment}
          onRetakeSegment={engines.browser.handleRetakeSegment}
          canRetakeSegments={readerEngine.capabilities.retake}
          onJumpToSegment={reader.jumpToSegment}
          generationError={runtime.error}
          immersive={immersive}
          onImmersiveChange={onImmersiveChange}
        />
      </Suspense>
    </SurfaceErrorBoundary>
  );
}
