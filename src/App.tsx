import { useEffect, useRef, useState } from "react";
import LiveWaveform from "./LiveWaveform";
import {
  createFileDescriptor,
  createMicrophoneDescriptor,
  decodeToMono16k,
  inferMediaKindFromMime,
  inferSourceTitle,
  type MediaKind,
  type SourceDescriptor,
} from "./lib/media";
import {
  createTranscriptRecord,
  downloadJson,
  downloadMarkdown,
  loadHistory,
  saveHistory,
  type TranscriptRecord,
} from "./lib/storage";
import {
  type ModelState,
  type TranscriptChunk,
  type TranscriptionMode,
  type TranscriptionResult,
  type TranscriptWord,
} from "./lib/transcription-types";
import { ACCURACY_MODEL_ID, loadAccuracyTranscriber, transcribeAccuracyAudio } from "./lib/transcriber";
import { loadTimestampTranscriber, transcribeTimestampedAudio } from "./lib/whisper-transcriber";

const LANGUAGE_OPTIONS = [
  { value: "", label: "Auto" },
  { value: "en", label: "English" },
  { value: "fr", label: "French" },
  { value: "de", label: "German" },
  { value: "es", label: "Spanish" },
  { value: "it", label: "Italian" },
  { value: "pt", label: "Portuguese" },
  { value: "nl", label: "Dutch" },
  { value: "hi", label: "Hindi" },
];

type CaptureState = {
  status: "idle" | "recording" | "stopping";
  seconds: number;
};

function App() {
  const [screen, setScreen] = useState<"select" | "workspace">("select");
  const [mode, setMode] = useState<TranscriptionMode>("accuracy");
  const [source, setSource] = useState<SourceDescriptor | null>(null);
  const [language, setLanguage] = useState("");
  const [errorText, setErrorText] = useState<string | null>(null);

  const [history, setHistory] = useState<TranscriptRecord[]>([]);
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const [currentRecord, setCurrentRecord] = useState<TranscriptRecord | null>(null);
  const [liveTranscript, setLiveTranscript] = useState<TranscriptionResult | null>(null);
  const [isTranscribing, setIsTranscribing] = useState(false);

  const [localMediaUrl, setLocalMediaUrl] = useState<string | null>(null);
  const [localMediaKind, setLocalMediaKind] = useState<MediaKind | null>(null);
  const [mediaTime, setMediaTime] = useState(0);
  const [mediaDuration, setMediaDuration] = useState(0);
  const [activeChunkId, setActiveChunkId] = useState<string | null>(null);
  const [activeWordId, setActiveWordId] = useState<string | null>(null);

  const [modelStates, setModelStates] = useState<Record<TranscriptionMode, ModelState>>({
    accuracy: { status: "idle", progress: 0, statusText: "Loading…" },
    timestamps: { status: "idle", progress: 0, statusText: "Loading…" },
  });
  const [captureState, setCaptureState] = useState<CaptureState>({
    status: "idle",
    seconds: 0,
  });
  const [isDragOver, setIsDragOver] = useState(false);
  const [userScrolledAway, setUserScrolledAway] = useState(false);
  const [activeStream, setActiveStream] = useState<MediaStream | null>(null);
  const [copied, setCopied] = useState(false);
  const copiedTimerRef = useRef<number>(0);
  const isAutoScrolling = useRef(false);

  const dragCounter = useRef(0);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const captureStreamRef = useRef<MediaStream | null>(null);
  const capturedChunksRef = useRef<Blob[]>([]);
  const captureTimerRef = useRef<number | null>(null);
  const mediaElementRef = useRef<HTMLMediaElement | null>(null);
  const transcriptScrollRef = useRef<HTMLDivElement | null>(null);
  const transcriptItemRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const wordElementRefs = useRef<Record<string, HTMLSpanElement | null>>({});
  const underlineRef = useRef<HTMLDivElement | null>(null);
  const underlineReady = useRef(false);
  const localMediaObjectUrlRef = useRef<string | null>(null);

  const displayTranscript = currentRecord ? recordToTranscript(currentRecord) : liveTranscript;
  const modelState = modelStates[mode];
  const hasMedia = localMediaUrl !== null;
  const canSyncPlayback =
    hasMedia && displayTranscript?.mode === "timestamps" && (displayTranscript.chunks?.length ?? 0) > 0;
  const isBusy = isTranscribing || captureState.status !== "idle";
  const showTimestampView = mode === "timestamps" && hasMedia;
  const hasAccuracyText = mode === "accuracy" && Boolean(displayTranscript?.text);

  /* ── Effects ─────────────────────────────────────── */

  useEffect(() => {
    setHistory(loadHistory());
    setHistoryLoaded(true);
  }, []);

  useEffect(() => {
    if (!historyLoaded) return;
    saveHistory(history);
  }, [history, historyLoaded]);

  useEffect(() => {
    return () => {
      stopTracks(captureStreamRef.current ?? undefined);
      cleanupCaptureTimer(captureTimerRef.current);
      if (localMediaObjectUrlRef.current) URL.revokeObjectURL(localMediaObjectUrlRef.current);
    };
  }, []);

  useEffect(() => {
    if (!displayTranscript?.chunks.length) {
      setActiveChunkId(null);
      setActiveWordId(null);
      return;
    }
    if (displayTranscript.mode !== "timestamps") {
      setActiveChunkId(null);
      setActiveWordId(null);
      return;
    }
    if (!canSyncPlayback) {
      const latestChunk = displayTranscript.chunks[displayTranscript.chunks.length - 1];
      setActiveChunkId(latestChunk?.id ?? null);
      const latestWord = displayTranscript.words[displayTranscript.words.length - 1];
      setActiveWordId(latestWord?.id ?? null);
      return;
    }
    const activeChunk = findActiveChunk(displayTranscript.chunks, mediaTime);
    const activeWord = findActiveWord(displayTranscript.words, mediaTime);
    setActiveChunkId(activeChunk?.id ?? displayTranscript.chunks[0]?.id ?? null);
    setActiveWordId(activeWord?.id ?? null);
  }, [displayTranscript, canSyncPlayback, mediaTime]);

  useEffect(() => {
    if (!activeChunkId || userScrolledAway) return;
    const item = transcriptItemRefs.current[activeChunkId];
    if (!item) return;
    isAutoScrolling.current = true;
    item.scrollIntoView({ behavior: "smooth", block: "nearest" });
    const timer = setTimeout(() => {
      isAutoScrolling.current = false;
    }, 400);
    return () => clearTimeout(timer);
  }, [activeChunkId, userScrolledAway]);

  useEffect(() => {
    const container = transcriptScrollRef.current;
    if (!container || !canSyncPlayback) return;

    const onScroll = () => {
      if (isAutoScrolling.current) return;
      if (!activeChunkId) return;
      const item = transcriptItemRefs.current[activeChunkId];
      if (!item) return;

      const cRect = container.getBoundingClientRect();
      const iRect = item.getBoundingClientRect();
      const visible = iRect.bottom > cRect.top && iRect.top < cRect.bottom;
      setUserScrolledAway(!visible);
    };

    container.addEventListener("scroll", onScroll, { passive: true });
    return () => container.removeEventListener("scroll", onScroll);
  }, [canSyncPlayback, activeChunkId]);

  useEffect(() => {
    if (!isTranscribing || !displayTranscript?.text) return;
    if (displayTranscript.chunks.length) return;
    const el = transcriptScrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [displayTranscript?.text, isTranscribing]);

  useEffect(() => {
    const bar = underlineRef.current;
    if (!bar || !activeWordId) return;

    const wordEl = wordElementRefs.current[activeWordId];
    const listEl = transcriptScrollRef.current;
    if (!wordEl || !listEl) return;

    const wordRect = wordEl.getBoundingClientRect();
    const listRect = listEl.getBoundingClientRect();

    const x = wordRect.left - listRect.left + listEl.scrollLeft;
    const y = wordRect.bottom - listRect.top + listEl.scrollTop + 2;
    const w = wordRect.width;

    const prevY = parseFloat(bar.dataset.lastY ?? "");
    const lineJump = !underlineReady.current || (Number.isFinite(prevY) && Math.abs(y - prevY) > 8);

    if (lineJump) {
      bar.style.transition = "none";
      bar.style.transform = `translate(${x}px, ${y}px)`;
      bar.style.width = `${w}px`;
      bar.style.opacity = "1";
      bar.offsetHeight;
      bar.style.transition = "";
      underlineReady.current = true;
    } else {
      bar.style.transform = `translate(${x}px, ${y}px)`;
      bar.style.width = `${w}px`;
      bar.style.opacity = "1";
    }

    bar.dataset.lastY = String(y);
  }, [activeWordId]);

  /* ── State helpers ───────────────────────────────── */

  const updateModelState = (targetMode: TranscriptionMode, nextState: ModelState) => {
    setModelStates((prev) => ({ ...prev, [targetMode]: nextState }));
  };

  const resetOutput = () => {
    setCurrentRecord(null);
    setLiveTranscript(null);
    setActiveChunkId(null);
    setActiveWordId(null);
    setUserScrolledAway(false);
    underlineReady.current = false;
    wordElementRefs.current = {};
  };

  const applyLocalMedia = (blob: Blob, kind: MediaKind) => {
    clearLocalMedia();
    const url = URL.createObjectURL(blob);
    localMediaObjectUrlRef.current = url;
    setLocalMediaUrl(url);
    setLocalMediaKind(kind);
  };

  const clearLocalMedia = () => {
    if (localMediaObjectUrlRef.current) {
      URL.revokeObjectURL(localMediaObjectUrlRef.current);
      localMediaObjectUrlRef.current = null;
    }
    setLocalMediaUrl(null);
    setLocalMediaKind(null);
  };

  /* ── Navigation ──────────────────────────────────── */

  const selectMode = (selectedMode: TranscriptionMode) => {
    setMode(selectedMode);
    setScreen("workspace");
    setErrorText(null);
    void warmUpModel(selectedMode);
  };

  const goBack = () => {
    if (mediaRecorderRef.current?.state === "recording") mediaRecorderRef.current.stop();
    stopTracks(captureStreamRef.current ?? undefined);
    cleanupCaptureTimer(captureTimerRef.current);
    captureTimerRef.current = null;
    mediaRecorderRef.current = null;
    captureStreamRef.current = null;

    setActiveStream(null);
    setCaptureState({ status: "idle", seconds: 0 });
    setScreen("select");
    setSource(null);
    resetOutput();
    clearLocalMedia();
    underlineReady.current = false;
    wordElementRefs.current = {};
    setErrorText(null);
    setIsTranscribing(false);
    setMediaTime(0);
    setMediaDuration(0);
  };

  /* ── Model loading ───────────────────────────────── */

  const warmUpModel = async (targetMode: TranscriptionMode) => {
    setErrorText(null);
    try {
      if (targetMode === "accuracy") {
        await loadAccuracyTranscriber((s) => updateModelState("accuracy", s));
      } else {
        await loadTimestampTranscriber((s) => updateModelState("timestamps", s));
      }
    } catch (error) {
      setErrorText(normalizeError(error));
    }
  };

  /* ── File handling ───────────────────────────────── */

  const processFile = async (file: File) => {
    if (isBusy) return;

    const src = createFileDescriptor(file);
    setSource(src);
    setErrorText(null);
    resetOutput();
    setMediaTime(0);
    setMediaDuration(0);

    if (mode === "timestamps") {
      applyLocalMedia(file, inferMediaKindFromMime(file.type) ?? "audio");
    }

    try {
      await transcribeBlob(file, src);
    } catch (error) {
      setErrorText(normalizeError(error));
    }
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = "";
    void processFile(file);
  };

  /* ── Drag and drop ───────────────────────────────── */

  const handleDragEnter = (e: React.DragEvent) => {
    e.preventDefault();
    dragCounter.current++;
    if (dragCounter.current === 1) setIsDragOver(true);
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    dragCounter.current--;
    if (dragCounter.current <= 0) {
      dragCounter.current = 0;
      setIsDragOver(false);
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    dragCounter.current = 0;
    setIsDragOver(false);

    if (modelState.status !== "ready" || isBusy) return;

    const file = Array.from(e.dataTransfer.files).find(
      (f) => f.type.startsWith("audio/") || f.type.startsWith("video/"),
    );
    if (file) void processFile(file);
  };

  /* ── Microphone ──────────────────────────────────── */

  const toggleRecording = async () => {
    if (captureState.status === "recording") {
      await finishCaptureAndTranscribe();
    } else {
      await startMicrophoneCapture();
    }
  };

  const startMicrophoneCapture = async () => {
    setErrorText(null);
    resetOutput();
    setSource(createMicrophoneDescriptor());

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
        video: false,
      });
      beginCapture(stream, createMicrophoneRecorderOptions());
    } catch (error) {
      setErrorText(normalizeError(error));
    }
  };

  const beginCapture = (stream: MediaStream, recorderOptions?: MediaRecorderOptions) => {
    captureStreamRef.current = stream;
    setActiveStream(stream);
    capturedChunksRef.current = [];
    const recorder = recorderOptions ? new MediaRecorder(stream, recorderOptions) : new MediaRecorder(stream);
    mediaRecorderRef.current = recorder;

    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) capturedChunksRef.current.push(e.data);
    };
    recorder.onstop = () => {
      stopTracks(stream);
      captureStreamRef.current = null;
      setActiveStream(null);
    };
    recorder.start(1000);

    cleanupCaptureTimer(captureTimerRef.current);
    captureTimerRef.current = window.setInterval(() => {
      setCaptureState((prev) => ({ ...prev, seconds: prev.seconds + 1 }));
    }, 1000);

    stream.getTracks().forEach((track) => {
      track.onended = () => {
        if (mediaRecorderRef.current?.state === "recording") void finishCaptureAndTranscribe();
      };
    });

    setCaptureState({ status: "recording", seconds: 0 });
  };

  const finishCaptureAndTranscribe = async () => {
    const recorder = mediaRecorderRef.current;
    if (!recorder || recorder.state !== "recording") return;

    setCaptureState((prev) => ({ ...prev, status: "stopping" }));
    await new Promise<void>((resolve) => {
      recorder.addEventListener("stop", () => resolve(), { once: true });
      recorder.stop();
    });

    cleanupCaptureTimer(captureTimerRef.current);
    captureTimerRef.current = null;
    mediaRecorderRef.current = null;

    const blob = new Blob(capturedChunksRef.current, {
      type: capturedChunksRef.current[0]?.type ?? "audio/webm",
    });

    setCaptureState({ status: "idle", seconds: 0 });

    if (!blob.size) {
      setErrorText("No audio was captured.");
      return;
    }

    const src = source ?? createMicrophoneDescriptor();
    if (mode === "timestamps") {
      applyLocalMedia(blob, inferMediaKindFromMime(blob.type) ?? "audio");
    }

    try {
      await transcribeBlob(blob, src);
    } catch (error) {
      setErrorText(normalizeError(error));
    }
  };

  /* ── Transcription ───────────────────────────────── */

  const transcribeBlob = async (blob: Blob, activeSource: SourceDescriptor) => {
    setIsTranscribing(true);
    setErrorText(null);
    resetOutput();

    try {
      const audio = await decodeToMono16k(blob);
      if (mode === "accuracy") {
        finalizeTranscription(activeSource, await transcribeAccuracy(audio, language));
      } else {
        finalizeTranscription(activeSource, await transcribeWithTimestamps(audio, language));
      }
    } finally {
      setIsTranscribing(false);
    }
  };

  const transcribeAccuracy = async (audio: Float32Array, lang: string): Promise<TranscriptionResult> => {
    const draft: TranscriptionResult = {
      mode: "accuracy",
      modelId: ACCURACY_MODEL_ID,
      text: "",
      chunks: [],
      words: [],
    };
    let tokenCount = 0;
    let firstTokenTime = 0;
    const text = await transcribeAccuracyAudio(
      audio,
      lang,
      (s) => updateModelState("accuracy", s),
      (chunk) => {
        tokenCount++;
        if (tokenCount === 1) firstTokenTime = performance.now();
        draft.text += chunk;
        const elapsed = (performance.now() - firstTokenTime) / 1000;
        if (elapsed > 0 && tokenCount > 1) {
          draft.tps = (tokenCount - 1) / elapsed;
        }
        setLiveTranscript({ ...draft });
      },
    );
    const finalElapsed = (performance.now() - firstTokenTime) / 1000;
    const tps = finalElapsed > 0 && tokenCount > 1 ? (tokenCount - 1) / finalElapsed : undefined;
    return { ...draft, text, tps };
  };

  const transcribeWithTimestamps = async (audio: Float32Array, lang: string): Promise<TranscriptionResult> => {
    return transcribeTimestampedAudio(
      audio,
      lang,
      (s) => updateModelState("timestamps", s),
      (partial) => setLiveTranscript(partial),
    );
  };

  const finalizeTranscription = (activeSource: SourceDescriptor, result: TranscriptionResult) => {
    const record = createTranscriptRecord(activeSource, result, language, inferSourceTitle(activeSource));
    setCurrentRecord(record);
    setLiveTranscript(result);
    setHistory((prev) => [record, ...prev.filter((r) => r.filename !== record.filename)].slice(0, 8));
  };

  const jumpToActiveChunk = () => {
    setUserScrolledAway(false);
    if (!activeChunkId) return;
    const item = transcriptItemRefs.current[activeChunkId];
    if (!item) return;
    isAutoScrolling.current = true;
    item.scrollIntoView({ behavior: "smooth", block: "nearest" });
    setTimeout(() => {
      isAutoScrolling.current = false;
    }, 400);
  };

  /* ── Media playback ──────────────────────────────── */

  const handleMediaTimeUpdate = () => {
    if (mediaElementRef.current) setMediaTime(mediaElementRef.current.currentTime);
  };

  const handleMediaLoaded = () => {
    if (!mediaElementRef.current) return;
    setMediaDuration(Number.isFinite(mediaElementRef.current.duration) ? mediaElementRef.current.duration : 0);
    setMediaTime(mediaElementRef.current.currentTime);
  };

  const handleChunkClick = (chunk: TranscriptChunk) => {
    if (!canSyncPlayback || !mediaElementRef.current) return;
    const t = clampSeekTime(chunk.start, mediaElementRef.current.duration);
    mediaElementRef.current.currentTime = t;
    setMediaTime(t);
    setActiveChunkId(chunk.id);
    setActiveWordId(getWordsForChunk(displayTranscript?.words ?? [], chunk)[0]?.id ?? null);
  };

  const handleWordClick = (word: TranscriptWord, chunk: TranscriptChunk) => {
    if (!canSyncPlayback || !mediaElementRef.current) return;
    const t = clampSeekTime(word.start, mediaElementRef.current.duration);
    mediaElementRef.current.currentTime = t;
    setMediaTime(t);
    setActiveChunkId(chunk.id);
    setActiveWordId(word.id);
  };

  const handleCopyTranscript = async () => {
    if (!displayTranscript?.text) return;
    await navigator.clipboard.writeText(displayTranscript.text);
    setCopied(true);
    clearTimeout(copiedTimerRef.current);
    copiedTimerRef.current = window.setTimeout(() => setCopied(false), 1500);
  };

  /* ── Render ──────────────────────────────────────── */

  return (
    <main
      className="app-shell"
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {isDragOver && (
        <div className="drop-overlay">
          <span>Drop file to transcribe</span>
        </div>
      )}

      {/* ── Mode selection ──────────────────────────── */}
      {screen === "select" && (
        <div className="select-screen">
          <h1 className="select-title">Transcribe</h1>
          <p className="select-subtitle">Offline, local transcription with WebGPU</p>
          <div className="mode-cards">
            <button type="button" className="mode-card" onClick={() => selectMode("accuracy")}>
              <h2>Accuracy</h2>
              <p>Create a high-quality transcript</p>
            </button>
            <button type="button" className="mode-card" onClick={() => selectMode("timestamps")}>
              <h2>Timestamps</h2>
              <p>Create a timestamped transcript</p>
            </button>
          </div>
        </div>
      )}

      {/* ── Workspace ───────────────────────────────── */}
      {screen === "workspace" && (
        <>
          <header className="top-bar">
            <span className="top-bar-title">Transcribe</span>
            <span className="top-bar-divider">/</span>
            <span className="top-bar-mode">{mode === "accuracy" ? "Accuracy" : "Timestamps"}</span>
            <button type="button" className="top-bar-back" onClick={goBack}>
              Back
            </button>
          </header>

          {/* Model loading */}
          {modelState.status !== "ready" && (
            <div className="loading-section">
              <div className="progress-track">
                <div className="progress-fill" style={{ width: `${modelState.progress}%` }} />
              </div>
              <p className="loading-status">{modelState.statusText}</p>
              {errorText && <p className="error-text">{errorText}</p>}
            </div>
          )}

          {/* Input area (accuracy always, timestamps only when no media) */}
          {modelState.status === "ready" && !showTimestampView && (
            <div className="accuracy-workspace">
              <div className={`input-section${hasAccuracyText ? " compact" : ""}`}>
                {captureState.status === "recording" ? (
                  <div className="recording-section">
                    {activeStream && <LiveWaveform stream={activeStream} />}
                    <button type="button" className="btn recording" onClick={toggleRecording}>
                      Stop recording · {formatClockTime(captureState.seconds)}
                    </button>
                  </div>
                ) : (
                  <>
                    <p className="input-prompt">{isTranscribing ? "Transcribing…" : "Drop a file anywhere, or"}</p>
                    <div className="input-actions">
                      <label className="btn primary">
                        Choose file
                        <input
                          type="file"
                          className="file-input"
                          accept="audio/*,video/*"
                          onChange={handleFileChange}
                          disabled={isBusy}
                        />
                      </label>
                      <button type="button" className="btn" onClick={toggleRecording} disabled={isBusy}>
                        Record
                      </button>
                    </div>
                    <div className="language-field">
                      <select value={language} onChange={(e) => setLanguage(e.target.value)} disabled={isBusy}>
                        {LANGUAGE_OPTIONS.map((opt) => (
                          <option key={opt.value || "auto"} value={opt.value}>
                            {opt.label}
                          </option>
                        ))}
                      </select>
                    </div>
                  </>
                )}
                {errorText && modelState.status === "ready" && <p className="error-text">{errorText}</p>}
              </div>

              {/* Accuracy transcript */}
              {mode === "accuracy" && hasAccuracyText && (
                <div className="accuracy-result">
                  <div ref={transcriptScrollRef} className="transcript-box">
                    {displayTranscript!.text}
                  </div>
                  <div className="action-row">
                    {displayTranscript?.tps && (
                      <span className="tps-badge">{displayTranscript.tps.toFixed(1)} tok/s</span>
                    )}
                    <button
                      type="button"
                      className="btn"
                      disabled={!currentRecord}
                      onClick={() => currentRecord && downloadMarkdown(currentRecord)}
                    >
                      Download markdown
                    </button>
                    <button type="button" className="btn" onClick={handleCopyTranscript}>
                      {copied ? "Copied" : "Copy text"}
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Timestamp workspace — side by side */}
          {showTimestampView && modelState.status === "ready" && (
            <div className="timestamp-workspace">
              <div className="media-side">
                {localMediaKind === "video" ? (
                  <video
                    key={localMediaUrl}
                    ref={(node) => {
                      mediaElementRef.current = node;
                    }}
                    src={localMediaUrl!}
                    controls
                    playsInline
                    preload="metadata"
                    onLoadedMetadata={handleMediaLoaded}
                    onTimeUpdate={handleMediaTimeUpdate}
                    onSeeked={handleMediaTimeUpdate}
                  />
                ) : (
                  <audio
                    key={localMediaUrl}
                    ref={(node) => {
                      mediaElementRef.current = node;
                    }}
                    src={localMediaUrl!}
                    controls
                    preload="metadata"
                    onLoadedMetadata={handleMediaLoaded}
                    onTimeUpdate={handleMediaTimeUpdate}
                    onSeeked={handleMediaTimeUpdate}
                  />
                )}
                <div className="media-info">
                  <span>{formatPlayback(mediaTime, mediaDuration)}</span>
                  {isTranscribing && <span className="transcribing-badge">Transcribing…</span>}
                </div>
              </div>

              <div className="transcript-side">
                <div className="transcript-side-header">
                  <span className="transcript-side-title">Transcript</span>
                  {displayTranscript?.tps && (
                    <span className="tps-badge">{displayTranscript.tps.toFixed(1)} tok/s</span>
                  )}
                </div>

                {displayTranscript?.mode === "timestamps" && displayTranscript.chunks.length ? (
                  <div ref={transcriptScrollRef} className="timeline-list">
                    <div ref={underlineRef} className="floating-underline" />
                    {displayTranscript.chunks.map((chunk) => {
                      const isActive = activeChunkId === chunk.id;
                      const segmentWords = getWordsForChunk(displayTranscript.words, chunk);
                      return (
                        <div
                          key={chunk.id}
                          ref={(node) => {
                            transcriptItemRefs.current[chunk.id] = node;
                          }}
                          className={`timeline-item${isActive ? " active" : ""}`}
                          onClick={() => handleChunkClick(chunk)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter" || e.key === " ") {
                              e.preventDefault();
                              handleChunkClick(chunk);
                            }
                          }}
                          role="button"
                          tabIndex={canSyncPlayback ? 0 : -1}
                          aria-disabled={!canSyncPlayback}
                        >
                          <span className="timeline-stamp">{formatTimestampRange(chunk.start, chunk.end)}</span>
                          {segmentWords.length ? (
                            <span className="timeline-words">
                              {segmentWords.map((word) => (
                                <span
                                  key={word.id}
                                  ref={(node) => {
                                    wordElementRefs.current[word.id] = node;
                                  }}
                                  className={`timeline-word${activeWordId === word.id ? " active" : ""}`}
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    handleWordClick(word, chunk);
                                  }}
                                  onKeyDown={(e) => {
                                    if (e.key === "Enter" || e.key === " ") {
                                      e.preventDefault();
                                      e.stopPropagation();
                                      handleWordClick(word, chunk);
                                    }
                                  }}
                                  role="button"
                                  tabIndex={canSyncPlayback ? 0 : -1}
                                  aria-label={`Seek to ${formatPreciseSeconds(word.start)}`}
                                >
                                  {word.text}
                                </span>
                              ))}
                            </span>
                          ) : (
                            <span className="timeline-words">{chunk.text.trim() || "…"}</span>
                          )}
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <div
                    ref={transcriptScrollRef}
                    className={`timeline-placeholder${!displayTranscript?.text ? " empty" : ""}`}
                  >
                    {displayTranscript?.text || (isTranscribing ? "Transcribing…" : "Transcript will appear here")}
                  </div>
                )}

                {userScrolledAway && canSyncPlayback && (
                  <button type="button" className="jump-to-current" onClick={jumpToActiveChunk}>
                    ↓ Jump to current
                  </button>
                )}

                <div className="transcript-side-actions">
                  <button
                    type="button"
                    className="btn"
                    disabled={!currentRecord}
                    onClick={() => currentRecord && downloadMarkdown(currentRecord)}
                  >
                    Markdown
                  </button>
                  <button type="button" className="btn" disabled={!displayTranscript?.text} onClick={handleCopyTranscript}>
                    {copied ? "Copied" : "Copy"}
                  </button>
                  <button
                    type="button"
                    className="btn"
                    disabled={!currentRecord?.chunks.length}
                    onClick={() => currentRecord && downloadJson(currentRecord)}
                  >
                    JSON
                  </button>
                </div>
              </div>
            </div>
          )}
        </>
      )}
    </main>
  );
}

export default App;

/* ── Pure helpers ─────────────────────────────────── */

function findActiveChunk(chunks: TranscriptChunk[], time: number): TranscriptChunk | undefined {
  return chunks.find((chunk, index) => {
    const nextStart = chunks[index + 1]?.start ?? Number.POSITIVE_INFINITY;
    return time >= chunk.start && time < (chunk.end ?? nextStart);
  });
}

function findActiveWord(words: TranscriptWord[], time: number): TranscriptWord | undefined {
  return words.find((word, index) => {
    const nextStart = words[index + 1]?.start ?? Number.POSITIVE_INFINITY;
    return time >= word.start && time < (word.end ?? nextStart);
  });
}

function normalizeError(error: unknown): string {
  return error instanceof Error ? error.message : "Something went wrong.";
}

function stopTracks(stream?: MediaStream) {
  stream?.getTracks().forEach((track) => track.stop());
}

function cleanupCaptureTimer(timerId: number | null) {
  if (timerId != null) window.clearInterval(timerId);
}

function formatClockTime(value: number): string {
  const m = Math.floor(value / 60).toString().padStart(2, "0");
  const s = (value % 60).toString().padStart(2, "0");
  return `${m}:${s}`;
}

function formatTimestampRange(start: number, end: number | null): string {
  return `${formatPreciseSeconds(start)} – ${end == null ? "…" : formatPreciseSeconds(end)}`;
}

function formatPreciseSeconds(value: number): string {
  const m = Math.floor(value / 60).toString().padStart(2, "0");
  const s = Math.floor(value % 60).toString().padStart(2, "0");
  const cs = Math.round((value % 1) * 100).toString().padStart(2, "0");
  return `${m}:${s}.${cs}`;
}

function clampSeekTime(value: number, duration: number): number {
  if (!Number.isFinite(duration) || duration <= 0) return Math.max(0, value);
  return Math.min(Math.max(0, value), Math.max(0, duration - 0.01));
}

function formatPlayback(currentTime: number, duration: number): string {
  if (!duration) return `${formatClockTime(Math.floor(currentTime))} / --:--`;
  return `${formatClockTime(Math.floor(currentTime))} / ${formatClockTime(Math.floor(duration))}`;
}

function createMicrophoneRecorderOptions(): MediaRecorderOptions | undefined {
  const candidates = ["audio/webm;codecs=opus", "audio/webm"];
  const mimeType = candidates.find((c) => MediaRecorder.isTypeSupported(c)) ?? "";
  return mimeType ? { mimeType } : undefined;
}

function recordToTranscript(record: TranscriptRecord): TranscriptionResult {
  return {
    mode: record.mode,
    modelId: record.modelId,
    text: record.transcript,
    chunks: record.chunks,
    words: record.words,
    tps: record.tps,
  };
}

function getWordsForChunk(words: TranscriptWord[], chunk: TranscriptChunk): TranscriptWord[] {
  if (!words.length) return [];
  const startIndex = chunk.wordStartIndex ?? 0;
  const endIndex = chunk.wordEndIndex ?? -1;
  if (endIndex < startIndex) {
    return words.filter((w) => w.start >= chunk.start && (chunk.end == null || w.start < chunk.end));
  }
  return words.slice(startIndex, endIndex + 1);
}
