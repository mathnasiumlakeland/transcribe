/// <reference lib="webworker" />

import {
  TextStreamer,
  env,
  pipeline,
  type AutomaticSpeechRecognitionOutput,
  type AutomaticSpeechRecognitionPipeline,
} from "@huggingface/transformers";
import {
  createChunkId,
  type ModelState,
  type TranscriptChunk,
  type TranscriptionResult,
  type TranscriptWord,
} from "./transcription-types";
import { TIMESTAMP_MODEL_ID } from "./whisper-transcriber";

type WarmupRequest = {
  type: "warmup";
  requestId: number;
};

type TranscribeRequest = {
  type: "transcribe";
  requestId: number;
  audio: Float32Array;
  language: string;
};

type WorkerRequest = WarmupRequest | TranscribeRequest;

env.allowLocalModels = false;

let transcriberPromise: Promise<AutomaticSpeechRecognitionPipeline> | null = null;
let workerFileTracker = new Map<string, { loaded: number; total: number }>();
let workerLastPct = 0;

self.addEventListener("message", async (event: MessageEvent<WorkerRequest>) => {
  const message = event.data;

  try {
    if (message.type === "warmup") {
      await loadTimestampTranscriber(message.requestId);
      postMessage({
        type: "ready",
        requestId: message.requestId,
      });
      return;
    }

    if (message.type === "transcribe") {
      const payload = await transcribeAudio(message);
      postMessage({
        type: "complete",
        requestId: message.requestId,
        payload,
      });
    }
  } catch (error) {
    postMessage({
      type: "error",
      requestId: message.requestId,
      message: error instanceof Error ? error.message : "Timestamp transcription failed.",
    });
  }
});

async function loadTimestampTranscriber(requestId: number): Promise<AutomaticSpeechRecognitionPipeline> {
  const workerNavigator = self.navigator as Navigator & { gpu?: unknown };
  if (!workerNavigator.gpu) {
    const message = "WebGPU is not available in this browser. Use current Chromium with WebGPU enabled.";
    postStatus(requestId, {
      status: "error",
      progress: 0,
      statusText: message,
      error: message,
    });
    throw new Error(message);
  }

  if (!transcriberPromise) {
    workerFileTracker = new Map();
    workerLastPct = 0;

    transcriberPromise = pipeline("automatic-speech-recognition", TIMESTAMP_MODEL_ID, {
      device: "webgpu",
      dtype: {
        encoder_model: "fp16",
        decoder_model_merged: "q4",
      },
      progress_callback(info: {
        status: string;
        progress?: number;
        file?: string;
        loaded?: number;
        total?: number;
      }) {
        if (
          info.status !== "progress" ||
          !info.file ||
          typeof info.loaded !== "number" ||
          typeof info.total !== "number"
        )
          return;

        workerFileTracker.set(info.file, { loaded: info.loaded, total: info.total });

        let totalLoaded = 0;
        let totalSize = 0;
        for (const entry of workerFileTracker.values()) {
          totalLoaded += entry.loaded;
          totalSize += entry.total;
        }

        const pct = totalSize > 0 ? Math.round((totalLoaded / totalSize) * 100) : 0;
        const progress = Math.max(workerLastPct, pct);
        workerLastPct = progress;

        postMessage({
          type: "progress",
          requestId,
          info: {
            status: "progress",
            progress,
            file: info.file,
          },
        });
      },
    }).catch((error: unknown) => {
      transcriberPromise = null;
      throw error;
    });
  }

  return transcriberPromise;
}

async function transcribeAudio({
  requestId,
  audio,
  language,
}: TranscribeRequest): Promise<TranscriptionResult> {
  const transcriber = await loadTimestampTranscriber(requestId);
  postStatus(requestId, {
    status: "ready",
    progress: 100,
    statusText: "Transcribing with Whisper timestamps on WebGPU…",
  });

  const audioDurationSeconds = roundNumber(audio.length / 16_000);
  const shouldChunk = audioDurationSeconds > 29;
  const chunkLengthSeconds = shouldChunk ? 29 : 0;
  const strideLengthSeconds = shouldChunk ? 5 : 0;
  const segmentGapBasisSeconds = shouldChunk ? chunkLengthSeconds - strideLengthSeconds * 2 : 9;

  let tokenStartAt: number | null = null;
  let tokenCount = 0;
  let tokensPerSecond = 0;
  let liveText = "";

  const streamer = new TextStreamer(transcriber.tokenizer, {
    skip_prompt: true,
    skip_special_tokens: true,
    callback_function(text) {
      liveText += text;
      postUpdate(requestId, liveText, tokensPerSecond);
    },
    token_callback_function() {
      tokenStartAt ??= performance.now();
      tokenCount += 1;
      const elapsedSeconds = (performance.now() - tokenStartAt) / 1000;
      if (elapsedSeconds > 0) {
        tokensPerSecond = tokenCount / elapsedSeconds;
      }
    },
  });

  const output = (await transcriber(audio, {
    top_k: 0,
    do_sample: false,
    language: language || undefined,
    task: "transcribe",
    return_timestamps: "word",
    force_full_sequences: false,
    ...(shouldChunk
      ? {
          chunk_length_s: chunkLengthSeconds,
          stride_length_s: strideLengthSeconds,
        }
      : {}),
    streamer,
  })) as AutomaticSpeechRecognitionOutput;

  const words = (output.chunks ?? []).map((chunk, index) => ({
    id: createChunkId(chunk.timestamp[0], index),
    text: chunk.text,
    start: roundNumber(chunk.timestamp[0]),
    end: roundNumber(chunk.timestamp[1]),
    final: true,
  })) satisfies TranscriptWord[];
  const chunks = groupWordsIntoSegments(words, segmentGapBasisSeconds);

  return {
    mode: "timestamps",
    modelId: TIMESTAMP_MODEL_ID,
    text: output.text.trim() || words.map((word) => word.text).join("").trim(),
    chunks,
    words,
    tps: tokensPerSecond || undefined,
  };
}

function postStatus(requestId: number, state: ModelState) {
  postMessage({
    type: "status",
    requestId,
    state,
  });
}

function postUpdate(requestId: number, text: string, tps: number) {
  postMessage({
    type: "update",
    requestId,
    payload: {
      mode: "timestamps",
      modelId: TIMESTAMP_MODEL_ID,
      text: text.trim(),
      chunks: [],
      words: [],
      tps: tps || undefined,
    } satisfies TranscriptionResult,
  });
}

function roundNumber(value: number): number {
  return Math.round(value * 100) / 100;
}

function groupWordsIntoSegments(words: TranscriptWord[], minimumGapSeconds: number): TranscriptChunk[] {
  if (!words.length) return [];

  const segments: TranscriptChunk[] = [];
  let segmentStartIndex = 0;

  const flushSegment = (endIndex: number) => {
    if (endIndex < segmentStartIndex) return;

    const segmentWords = words.slice(segmentStartIndex, endIndex + 1);
    segments.push({
      id: createChunkId(segmentWords[0].start, segments.length),
      text: segmentWords.map((word) => word.text).join(""),
      start: segmentWords[0].start,
      end: segmentWords[segmentWords.length - 1].end,
      final: true,
      wordStartIndex: segmentStartIndex,
      wordEndIndex: endIndex,
    });
    segmentStartIndex = endIndex + 1;
  };

  for (let index = 0; index < words.length; index += 1) {
    const currentWord = words[index];
    const nextWord = words[index + 1];
    const currentText = currentWord.text.trim();
    const hasSentenceBreak = /[.!?]$/.test(currentText);
    const hasLongPause =
      nextWord != null &&
      currentWord.end != null &&
      nextWord.start - currentWord.end >= Math.min(0.9, minimumGapSeconds / 10);
    const hasLengthCap = index - segmentStartIndex >= 11;

    if (hasSentenceBreak || hasLongPause || hasLengthCap || !nextWord) {
      flushSegment(index);
    }
  }

  return segments;
}

export {};
