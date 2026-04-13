import type {
  AutomaticSpeechRecognitionOutput,
  AutomaticSpeechRecognitionPipeline,
} from "@huggingface/transformers";
import type { ModelState } from "./transcription-types";

export const ACCURACY_MODEL_ID = "onnx-community/cohere-transcribe-03-2026-ONNX";

let transcriberPromise: Promise<AutomaticSpeechRecognitionPipeline> | null = null;
let transformersModulePromise: Promise<typeof import("@huggingface/transformers")> | null = null;

let accuracyLastPct = 0;

export async function loadAccuracyTranscriber(
  onState: (state: ModelState) => void,
): Promise<AutomaticSpeechRecognitionPipeline> {
  const browserNavigator = navigator as Navigator & { gpu?: unknown };
  if (!browserNavigator.gpu) {
    const message = "WebGPU is not available in this browser. Use a current Chromium browser with WebGPU enabled.";
    onState({
      status: "error",
      progress: 0,
      statusText: message,
      error: message,
    });
    throw new Error(message);
  }

  const transformers = await loadTransformersModule();

  if (!transcriberPromise) {
    accuracyLastPct = 0;

    transcriberPromise = transformers.pipeline("automatic-speech-recognition", ACCURACY_MODEL_ID, {
      device: "webgpu",
      dtype: "q4",
      progress_callback(info: {
        status: string;
        progress?: number;
        file?: string;
        loaded?: number;
        total?: number;
      }) {
        const nextState = getLoadProgressState(info, accuracyLastPct);
        if (!nextState) return;

        accuracyLastPct = nextState.progress;
        onState(nextState);
      },
    }).catch((error: unknown) => {
      transcriberPromise = null;
      const message = error instanceof Error ? error.message : "Failed to load the WebGPU model.";
      onState({
        status: "error",
        progress: 0,
        statusText: message,
        error: message,
      });
      throw error;
    });
  }

  const transcriber = await transcriberPromise;
  onState({
    status: "ready",
    progress: 100,
    statusText: "Accuracy model ready in browser cache.",
  });
  return transcriber;
}

export async function transcribeAccuracyAudio(
  audio: Float32Array,
  language: string,
  onState: (state: ModelState) => void,
  onToken?: (chunk: string) => void,
): Promise<string> {
  const transcriber = await loadAccuracyTranscriber(onState);
  const transformers = await loadTransformersModule();
  onState({
    status: "ready",
    progress: 100,
    statusText: "Transcribing with the accuracy model on WebGPU…",
  });

  const streamer = onToken
    ? new transformers.TextStreamer(transcriber.tokenizer, {
        skip_prompt: true,
        skip_special_tokens: true,
        callback_function: onToken,
      })
    : undefined;

  const result = (await transcriber(audio, {
    max_new_tokens: 1024,
    language: language || undefined,
    streamer,
  })) as AutomaticSpeechRecognitionOutput;

  onState({
    status: "ready",
    progress: 100,
    statusText: "Accuracy transcript complete.",
  });
  return result.text;
}

async function loadTransformersModule(): Promise<typeof import("@huggingface/transformers")> {
  if (!transformersModulePromise) {
    transformersModulePromise = import("@huggingface/transformers").then((module) => {
      module.env.allowLocalModels = false;
      return module;
    });
  }

  return transformersModulePromise;
}

type LoadProgressInfo = {
  status: string;
  progress?: number;
  file?: string;
};

function getLoadProgressState(info: LoadProgressInfo, previousProgress: number): ModelState | null {
  if (info.status === "progress_total" && typeof info.progress === "number") {
    const progress = clampProgress(info.progress, previousProgress);
    return {
      status: "loading",
      progress,
      statusText: `Loading model… ${progress}%`,
    };
  }

  if (info.status === "download") {
    return {
      status: "loading",
      progress: previousProgress,
      statusText: formatPendingLoadText("Downloading", info.file, previousProgress),
    };
  }

  if (info.status === "done") {
    return {
      status: "loading",
      progress: previousProgress,
      statusText: formatPendingLoadText("Cached", info.file, previousProgress),
    };
  }

  return null;
}

function clampProgress(value: number, previousProgress: number): number {
  return Math.max(previousProgress, Math.min(99, Math.round(value)));
}

function formatPendingLoadText(action: string, file: string | undefined, progress: number): string {
  const filename = file?.split("/").pop();
  const prefix = filename ? `${action} ${filename}…` : `${action} model files…`;
  return progress > 0 ? `${prefix} ${progress}%` : prefix;
}
