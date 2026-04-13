import type { ModelState, TranscriptionResult } from "./transcription-types";

export const TIMESTAMP_MODEL_ID = "onnx-community/whisper-large-v3-turbo_timestamped";

type WorkerRequestType = "warmup" | "transcribe";

type WorkerProgressMessage = {
  type: "progress";
  requestId: number;
  info: {
    status: string;
    progress?: number;
    file?: string;
  };
};

type WorkerReadyMessage = {
  type: "ready";
  requestId: number;
};

type WorkerUpdateMessage = {
  type: "update";
  requestId: number;
  payload: TranscriptionResult;
};

type WorkerCompleteMessage = {
  type: "complete";
  requestId: number;
  payload: TranscriptionResult;
};

type WorkerStatusMessage = {
  type: "status";
  requestId: number;
  state: ModelState;
};

type WorkerErrorMessage = {
  type: "error";
  requestId: number;
  message: string;
};

type WorkerResponse =
  | WorkerProgressMessage
  | WorkerReadyMessage
  | WorkerUpdateMessage
  | WorkerCompleteMessage
  | WorkerStatusMessage
  | WorkerErrorMessage;

type PendingRequest<T> = {
  onState: (state: ModelState) => void;
  onUpdate?: (result: TranscriptionResult) => void;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
  kind: WorkerRequestType;
};

let whisperWorker: Worker | null = null;
let requestId = 0;
const pendingRequests = new Map<number, PendingRequest<TranscriptionResult | void>>();

export function loadTimestampTranscriber(onState: (state: ModelState) => void): Promise<void> {
  return runWorkerRequest<void>("warmup", { onState });
}

export function transcribeTimestampedAudio(
  audio: Float32Array,
  language: string,
  onState: (state: ModelState) => void,
  onUpdate: (result: TranscriptionResult) => void,
): Promise<TranscriptionResult> {
  return runWorkerRequest<TranscriptionResult>(
    "transcribe",
    {
      onState,
      onUpdate,
    },
    {
      audio,
      language,
    },
    [audio.buffer as ArrayBuffer],
  );
}

function runWorkerRequest<T extends TranscriptionResult | void>(
  type: WorkerRequestType,
  callbacks: {
    onState: (state: ModelState) => void;
    onUpdate?: (result: TranscriptionResult) => void;
  },
  payload?: Record<string, unknown>,
  transfer?: Transferable[],
): Promise<T> {
  const worker = getWhisperWorker();
  const nextRequestId = ++requestId;

  return new Promise<T>((resolve, reject) => {
    pendingRequests.set(nextRequestId, {
      ...callbacks,
      kind: type,
      resolve: resolve as PendingRequest<TranscriptionResult | void>["resolve"],
      reject,
    });

    worker.postMessage(
      {
        type,
        requestId: nextRequestId,
        ...payload,
      },
      transfer ?? [],
    );
  });
}

function getWhisperWorker(): Worker {
  if (!whisperWorker) {
    whisperWorker = new Worker(new URL("./whisper.worker.ts", import.meta.url), {
      type: "module",
    });
    whisperWorker.addEventListener("message", handleWorkerMessage);
    whisperWorker.addEventListener("error", handleWorkerError);
  }

  return whisperWorker;
}

function handleWorkerMessage(event: MessageEvent<WorkerResponse>) {
  const message = event.data;
  const pending = pendingRequests.get(message.requestId);
  if (!pending) return;

  switch (message.type) {
    case "progress": {
      const progress = Math.round(message.info.progress ?? 0);
      pending.onState({
        status: "loading",
        progress,
        statusText: `Loading model… ${progress}%`,
      });
      return;
    }
    case "status":
      pending.onState(message.state);
      return;
    case "update":
      pending.onUpdate?.(message.payload);
      return;
    case "ready":
      pending.onState({
        status: "ready",
        progress: 100,
        statusText: "Timestamp model ready in browser cache.",
      });
      pendingRequests.delete(message.requestId);
      pending.resolve(undefined);
      return;
    case "complete":
      pending.onState({
        status: "ready",
        progress: 100,
        statusText: "Timestamp transcript complete.",
      });
      pendingRequests.delete(message.requestId);
      pending.resolve(message.payload);
      return;
    case "error":
      pending.onState({
        status: "error",
        progress: 0,
        statusText: message.message,
        error: message.message,
      });
      pendingRequests.delete(message.requestId);
      pending.reject(new Error(message.message));
      return;
    default:
      return;
  }
}

function handleWorkerError() {
  for (const [id, pending] of pendingRequests.entries()) {
    const message = "The timestamp worker crashed while loading Whisper.";
    pending.onState({
      status: "error",
      progress: 0,
      statusText: message,
      error: message,
    });
    pending.reject(new Error(message));
    pendingRequests.delete(id);
  }
}
