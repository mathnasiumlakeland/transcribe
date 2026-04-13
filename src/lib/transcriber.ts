import type {
  AutomaticSpeechRecognitionOutput,
  AutomaticSpeechRecognitionPipeline,
} from "@huggingface/transformers";
import type { ModelState } from "./transcription-types";

export const ACCURACY_MODEL_ID = "onnx-community/cohere-transcribe-03-2026-ONNX";

let transcriberPromise: Promise<AutomaticSpeechRecognitionPipeline> | null = null;
let transformersModulePromise: Promise<typeof import("@huggingface/transformers")> | null = null;

let accuracyFileTracker = new Map<string, { loaded: number; total: number }>();
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
    accuracyFileTracker = new Map();
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
        if (info.status !== "progress" || !info.file || typeof info.loaded !== "number" || typeof info.total !== "number")
          return;

        accuracyFileTracker.set(info.file, { loaded: info.loaded, total: info.total });

        let totalLoaded = 0;
        let totalSize = 0;
        for (const entry of accuracyFileTracker.values()) {
          totalLoaded += entry.loaded;
          totalSize += entry.total;
        }

        const pct = totalSize > 0 ? Math.round((totalLoaded / totalSize) * 100) : 0;
        const progress = Math.max(accuracyLastPct, pct);
        accuracyLastPct = progress;

        onState({
          status: "loading",
          progress,
          statusText: `Loading model… ${progress}%`,
        });
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
