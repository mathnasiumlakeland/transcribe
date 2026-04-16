import { useEffect, useRef, useState } from "react";
import RealtimeVoiceMeter from "./RealtimeVoiceMeter";
import {
  startRealtimeTranscription,
  type RealtimeSession,
} from "./lib/realtime-transcriber";
import type { TranscriptionResult } from "./lib/transcription-types";

type RealtimeWorkspaceProps = {
  onComplete: (result: TranscriptionResult) => void;
  onResetOutput: () => void;
};

export default function RealtimeWorkspace({
  onComplete,
  onResetOutput,
}: RealtimeWorkspaceProps) {
  const [transcript, setTranscript] = useState("");
  const [errorText, setErrorText] = useState<string | null>(null);
  const [phase, setPhase] = useState<"idle" | "recording" | "stopping">("idle");
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [isStarting, setIsStarting] = useState(false);

  const sessionRef = useRef<RealtimeSession | null>(null);
  const mountedRef = useRef(true);
  const sessionVersionRef = useRef(0);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      sessionRef.current?.stop();
      sessionRef.current = null;
    };
  }, []);

  const hasTranscript = transcript.trim().length > 0;
  const isRecording = phase === "recording";
  const isStopping = phase === "stopping";
  const showActiveShell = isStarting || isRecording || isStopping || hasTranscript;

  const startSession = async () => {
    if (isRecording || isStarting) return;
    const sessionVersion = sessionVersionRef.current + 1;
    sessionVersionRef.current = sessionVersion;

    setTranscript("");
    setErrorText(null);
    setIsStarting(true);

    try {
      const captureStream = await withTimeout(
        navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true },
          video: false,
        }),
        15000,
        "Microphone access did not finish initializing. Try again.",
      );

      if (!mountedRef.current || sessionVersionRef.current !== sessionVersion) {
        stopTracks(captureStream);
        return;
      }

      setStream(captureStream);
      setPhase("recording");
      setIsStarting(false);

      const session = await startRealtimeTranscription({
        stream: captureStream,
        onTranscript: (result) => {
          if (!mountedRef.current || sessionVersionRef.current !== sessionVersion) return;
          setTranscript(result.text);
        },
        onStream: (nextStream) => {
          if (!mountedRef.current || sessionVersionRef.current !== sessionVersion) return;
          setStream(nextStream);
        },
      });

      if (!mountedRef.current || sessionVersionRef.current !== sessionVersion) {
        session.stop();
        return;
      }

      sessionRef.current = session;
      onResetOutput();
      setPhase("recording");

      const result = await session.done;
      if (!mountedRef.current || sessionVersionRef.current !== sessionVersion) return;

      sessionRef.current = null;
      setPhase("idle");
      setStream(null);
      setTranscript(result.text);

      if (result.text.trim()) {
        onComplete(result);
      }
    } catch (error) {
      if (!mountedRef.current || sessionVersionRef.current !== sessionVersion) return;

      sessionRef.current = null;
      setPhase("idle");
      setStream(null);
      setErrorText(normalizeError(error));
    } finally {
      if (mountedRef.current && sessionVersionRef.current === sessionVersion) {
        setIsStarting(false);
      }
    }
  };

  const stopSession = () => {
    if (!sessionRef.current) return;
    sessionRef.current?.stop();
    setPhase("stopping");
    setStream(null);
  };

  const resetSession = () => {
    if (isRecording) return;
    sessionVersionRef.current += 1;
    sessionRef.current?.stop();
    sessionRef.current = null;
    setPhase("idle");
    setIsStarting(false);
    setTranscript("");
    setErrorText(null);
    setStream(null);
    onResetOutput();
  };

  const statusLabel = errorText
    ? "System error"
    : isStarting
        ? "Connecting microphone"
        : isRecording
        ? "Live transcription"
        : "Standby";
  const helperText = errorText
    ? "Resolve the error and try again."
    : isStarting
        ? "Waiting for browser microphone access…"
        : isRecording
        ? stream
          ? "Listening live. Tap stop when you're done."
          : "Connecting to the microphone…"
        : "Tap the microphone to begin.";

  return (
    <section className="realtime-workspace">
      <div className="realtime-panel">
        <div className="realtime-panel-header">
          <div>
            <p className="realtime-kicker">Realtime mode</p>
            <h1 className="realtime-title">Real-time transcription</h1>
          </div>

          <div
            className={`realtime-status-pill${isRecording ? " is-live" : ""}${errorText ? " is-error" : ""}`}
          >
            <span className="realtime-status-dot" />
            <span>{statusLabel}</span>
          </div>
        </div>

        <div className="realtime-panel-body">
          {errorText && (
            <div className="realtime-error-box">
              <p>{errorText}</p>
            </div>
          )}

          {!showActiveShell ? (
            <div className="realtime-standby">
              <button
                type="button"
                className="realtime-mic-button"
                onClick={startSession}
                disabled={isStarting}
              >
                <MicrophoneGlyph />
              </button>

              <div className="realtime-standby-copy">
                <p className="realtime-headline">Start transcription</p>
                <p className="realtime-subtitle">{helperText}</p>
              </div>

              <div className="realtime-meter-card">
                <RealtimeVoiceMeter />
                <p>Ready when you are</p>
              </div>
            </div>
          ) : (
            <div className="realtime-transcript-shell">
              <div className="realtime-transcript-header">
                <div className="realtime-transcript-label">
                  <TranscriptGlyph />
                  <span>Transcript</span>
                </div>

                <div className="realtime-output-pill">
                  {hasTranscript ? "Live output" : "Waiting for speech"}
                </div>
              </div>

              <div className="realtime-transcript-body">
                {hasTranscript ? (
                  <p className="realtime-transcript-text">
                    <span>{transcript.trimStart()}</span>
                    {isRecording && <span className="realtime-cursor" />}
                  </p>
                ) : (
                  <div className="realtime-empty-state">
                    <RealtimeVoiceMeter active={Boolean(stream) && !isStopping} />
                    <div>
                      <p className="realtime-empty-title">
                        {isStarting
                          ? "Requesting microphone access…"
                          : stream
                            ? "Listening for speech…"
                            : isStopping
                              ? "Waiting for transcript…"
                              : "Connecting microphone…"}
                      </p>
                      <p className="realtime-empty-subtitle">
                        {isStarting
                          ? "Browser permission prompt · microphone setup"
                          : stream || isStopping
                            ? "Local processing · realtime stream"
                            : "Waiting for browser microphone access"}
                      </p>
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

        {(isRecording || isStopping || hasTranscript) && (
          <div className="realtime-controls">
            {isRecording ? (
              <button type="button" className="realtime-stop-button" onClick={stopSession}>
                <span className="realtime-stop-icon" />
                Stop
              </button>
            ) : (
              <button type="button" className="realtime-reset-button" onClick={resetSession}>
                Reset
              </button>
            )}
          </div>
        )}

        <div className="realtime-footer">
          <span>{isStarting ? "stream: starting" : isRecording ? "stream: live" : isStopping ? "stream: finalizing" : "stream: ready"}</span>
          <span>{isStarting ? "mic: requesting" : isRecording ? "mic: active" : "mic: idle"}</span>
        </div>
      </div>
    </section>
  );
}

function normalizeError(error: unknown): string {
  return error instanceof Error ? error.message : "Something went wrong.";
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      reject(new Error(message));
    }, timeoutMs);

    promise.then(
      (value) => {
        window.clearTimeout(timeout);
        resolve(value);
      },
      (error) => {
        window.clearTimeout(timeout);
        reject(error);
      },
    );
  });
}

function stopTracks(stream: MediaStream | null) {
  stream?.getTracks().forEach((track) => track.stop());
}

function MicrophoneGlyph() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 2.75a3 3 0 0 0-3 3v6.5a3 3 0 1 0 6 0v-6.5a3 3 0 0 0-3-3Z" />
      <path d="M18.25 11.5a.75.75 0 0 0-1.5 0v.75a4.75 4.75 0 1 1-9.5 0v-.75a.75.75 0 0 0-1.5 0v.75a6.25 6.25 0 0 0 5.5 6.2v2.05H8.5a.75.75 0 0 0 0 1.5h7a.75.75 0 0 0 0-1.5h-2.75v-2.05a6.25 6.25 0 0 0 5.5-6.2v-.75Z" />
    </svg>
  );
}

function TranscriptGlyph() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M4.5 4.5A1.5 1.5 0 0 1 6 3h12a1.5 1.5 0 0 1 1.5 1.5v15A1.5 1.5 0 0 1 18 21H6a1.5 1.5 0 0 1-1.5-1.5v-15ZM6 4.5v15h12v-15H6Z" />
      <path d="M8 9.25a.75.75 0 0 1 .75-.75h5.5a.75.75 0 0 1 0 1.5h-5.5A.75.75 0 0 1 8 9.25ZM8 13.25a.75.75 0 0 1 .75-.75h6.5a.75.75 0 0 1 0 1.5h-6.5a.75.75 0 0 1-.75-.75Z" />
    </svg>
  );
}
