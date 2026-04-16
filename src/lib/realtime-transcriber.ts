import type { ModelState, TranscriptionResult } from "./transcription-types";

export const REALTIME_MODEL_ID = "onnx-community/Voxtral-Mini-4B-Realtime-2602-ONNX";

const SAMPLE_RATE = 16_000;
const REALTIME_MODEL_FILE_COUNT = 3;
const CAPTURE_PROCESSOR_NAME = "realtime-capture-processor";
const CAPTURE_WORKLET_SOURCE = `
  class RealtimeCaptureProcessor extends AudioWorkletProcessor {
    process(inputs) {
      const input = inputs[0];
      if (input.length > 0 && input[0].length > 0) {
        const frames = input[0].length;
        const mono = new Float32Array(frames);
        for (let channelIndex = 0; channelIndex < input.length; channelIndex += 1) {
          const channel = input[channelIndex];
          for (let index = 0; index < frames; index += 1) {
            mono[index] += channel[index] ?? 0;
          }
        }
        const channelCount = Math.max(1, input.length);
        for (let index = 0; index < frames; index += 1) {
          mono[index] /= channelCount;
        }
        this.port.postMessage(mono);
      }
      return true;
    }
  }

  registerProcessor("${CAPTURE_PROCESSOR_NAME}", RealtimeCaptureProcessor);
`;

type RealtimeRuntime = {
  BaseStreamer: RealtimeModule["BaseStreamer"];
  model: any;
  processor: VoxtralStreamingProcessor;
  dtypeLabel: "q4f16" | "q4";
  runtimeLabel: "space-next7" | "local-next10";
};

type RealtimeSessionOptions = {
  onTranscript: (result: TranscriptionResult) => void;
  onStream?: (stream: MediaStream | null) => void;
  stream?: MediaStream;
};

export type RealtimeSession = {
  stop: () => void;
  done: Promise<TranscriptionResult>;
};

type VoxtralStreamingProcessor = {
  (
    audio: Float32Array | Float64Array,
    options?: { is_streaming?: boolean; is_first_audio_chunk?: boolean },
  ): Promise<any>;
  tokenizer: {
    all_special_ids: number[];
    decode(tokens: bigint[], options: { skip_special_tokens: boolean }): string;
  };
  feature_extractor: {
    config: {
      hop_length: number;
      n_fft: number;
    };
  };
  num_mel_frames_first_audio_chunk: number;
  num_samples_first_audio_chunk: number;
  num_samples_per_audio_chunk: number;
  audio_length_per_tok: number;
};

type ProgressInfo = {
  status: string;
  progress?: number;
  file?: string;
  loaded?: number;
  total?: number;
};

type RealtimeModule = {
  BaseStreamer: new () => {
    put(value: bigint[][]): void;
    end(): void;
  };
  VoxtralRealtimeForConditionalGeneration: {
    from_pretrained(
      modelId: string,
      options: {
        dtype: {
          audio_encoder: "q4f16" | "q4";
          embed_tokens: "q4f16" | "q4";
          decoder_model_merged: "q4f16" | "q4";
        };
        device: "webgpu";
        progress_callback: (info: ProgressInfo) => void;
      },
    ): Promise<any>;
  };
  VoxtralRealtimeProcessor: {
    from_pretrained(modelId: string): Promise<VoxtralStreamingProcessor>;
  };
  env?: {
    allowLocalModels?: boolean;
  };
};

let runtimePromise: Promise<RealtimeRuntime> | null = null;
let realtimeLastPct = 0;

export async function loadRealtimeTranscriber(onState: (state: ModelState) => void): Promise<void> {
  await loadRuntime(onState);
  onState({
    status: "ready",
    progress: 100,
    statusText: "Realtime model ready in browser cache.",
  });
}

export async function startRealtimeTranscription(options: RealtimeSessionOptions): Promise<RealtimeSession> {
  const runtime = await loadRuntime(() => {});
  let audioBuffer = new Float32Array(0);
  let stopRequested = false;
  let stream: MediaStream | null = null;
  let audioContext: AudioContext | null = null;
  let workletNode: AudioWorkletNode | null = null;
  let scriptProcessorNode: ScriptProcessorNode | null = null;
  let sourceNode: MediaStreamAudioSourceNode | null = null;
  let silentGainNode: GainNode | null = null;
  let sampleCount = 0;
  let usingScriptProcessorFallback = false;
  let normalizeCaptureChunk = (samples: Float32Array) => samples;

  const appendAudio = (newSamples: Float32Array) => {
    if (newSamples.length === 0) {
      return;
    }

    sampleCount += newSamples.length;
    const previousSamples = audioBuffer;
    const mergedSamples = new Float32Array(previousSamples.length + newSamples.length);
    mergedSamples.set(previousSamples);
    mergedSamples.set(newSamples, previousSamples.length);
    audioBuffer = mergedSamples;
  };

  const cleanupAudio = () => {
    workletNode?.disconnect();
    workletNode = null;
    scriptProcessorNode?.disconnect();
    scriptProcessorNode = null;
    sourceNode?.disconnect();
    sourceNode = null;
    silentGainNode?.disconnect();
    silentGainNode = null;

    stream?.getTracks().forEach((track) => track.stop());
    stream = null;

    options.onStream?.(null);

    if (audioContext) {
      void audioContext.close();
      audioContext = null;
    }
  };

  const stop = () => {
    stopRequested = true;
    cleanupAudio();
  };

  const done = (async () => {
    try {
      stream = options.stream ?? await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          sampleRate: SAMPLE_RATE,
        },
        video: false,
      });
      options.onStream?.(stream);

      audioContext = new AudioContext({ sampleRate: SAMPLE_RATE });
      await audioContext.resume();
      normalizeCaptureChunk = createCaptureNormalizer(audioContext.sampleRate, SAMPLE_RATE);

      sourceNode = audioContext.createMediaStreamSource(stream);
      silentGainNode = audioContext.createGain();
      silentGainNode.gain.value = 0;
      silentGainNode.connect(audioContext.destination);

      const useScriptProcessorFallback = () => {
        if (!audioContext || !sourceNode || !silentGainNode || scriptProcessorNode) return;
        usingScriptProcessorFallback = true;
        workletNode?.disconnect();
        workletNode = null;
        scriptProcessorNode = audioContext.createScriptProcessor(4096, 1, 1);
        scriptProcessorNode.onaudioprocess = (event) => {
          if (stopRequested) return;
          appendAudio(normalizeCaptureChunk(mixAudioBufferToMono(event.inputBuffer)));
        };
        sourceNode.connect(scriptProcessorNode);
        scriptProcessorNode.connect(silentGainNode);
      };

      if (audioContext.audioWorklet) {
        try {
          const workletBlob = new Blob([CAPTURE_WORKLET_SOURCE], {
            type: "application/javascript",
          });
          const workletUrl = URL.createObjectURL(workletBlob);
          await audioContext.audioWorklet.addModule(workletUrl);
          URL.revokeObjectURL(workletUrl);

          workletNode = new AudioWorkletNode(audioContext, CAPTURE_PROCESSOR_NAME);
          workletNode.port.onmessage = (event: MessageEvent<Float32Array>) => {
            if (!stopRequested) {
              appendAudio(normalizeCaptureChunk(new Float32Array(event.data)));
            }
          };

          sourceNode.connect(workletNode);
          workletNode.connect(silentGainNode);

          window.setTimeout(() => {
            if (stopRequested || usingScriptProcessorFallback) return;
            if (sampleCount >= 4096) return;
            useScriptProcessorFallback();
          }, 1200);
        } catch {
          useScriptProcessorFallback();
        }
      } else {
        useScriptProcessorFallback();
      }

      return await runRealtimeGeneration(runtime, () => audioBuffer, () => stopRequested, options.onTranscript);
    } finally {
      cleanupAudio();
    }
  })();

  return { stop, done };
}

async function loadRuntime(onState: (state: ModelState) => void): Promise<RealtimeRuntime> {
  const browserNavigator = navigator as Navigator & {
    gpu?: {
      requestAdapter?: () => Promise<{ features?: Set<string> | { has: (value: string) => boolean } } | null>;
    };
  };
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

  if (!runtimePromise) {
    realtimeLastPct = 0;
    runtimePromise = (async () => {
      const progressMap = new Map<string, number>();
      const adapter = await browserNavigator.gpu?.requestAdapter?.();
      const supportsShaderF16 = Boolean((adapter?.features as { has?: (value: string) => boolean } | undefined)?.has?.("shader-f16"));
      const dtypeLabel: "q4f16" | "q4" = supportsShaderF16 ? "q4f16" : "q4";
      const runtimeLabel: "space-next7" | "local-next10" = supportsShaderF16 ? "space-next7" : "local-next10";
      const module = (supportsShaderF16
        ? await import("hf-transformers-voxtral")
        : await import("@huggingface/transformers")) as unknown as RealtimeModule;

      if (module.env) {
        module.env.allowLocalModels = false;
      }

      const progressCallback = (info: ProgressInfo) => {
        const nextState = getRealtimeLoadState(info, progressMap, realtimeLastPct);
        if (!nextState) return;

        realtimeLastPct = nextState.progress;
        onState(nextState);
      };

      const model = await module.VoxtralRealtimeForConditionalGeneration.from_pretrained(REALTIME_MODEL_ID, {
        dtype: {
          audio_encoder: dtypeLabel,
          embed_tokens: dtypeLabel,
          decoder_model_merged: dtypeLabel,
        },
        device: "webgpu",
        progress_callback: progressCallback,
      });

      onState({
        status: "loading",
        progress: Math.max(realtimeLastPct, 96),
        statusText: "Loading realtime processor…",
      });

      const processor = (await module.VoxtralRealtimeProcessor.from_pretrained(
        REALTIME_MODEL_ID,
      )) as VoxtralStreamingProcessor;

      return { BaseStreamer: module.BaseStreamer, model, processor, dtypeLabel, runtimeLabel };
    })().catch((error: unknown) => {
      runtimePromise = null;
      const message = error instanceof Error ? error.message : "Failed to load the realtime model.";
      onState({
        status: "error",
        progress: 0,
        statusText: message,
        error: message,
      });
      throw error;
    });
  }

  return runtimePromise;
}

async function runRealtimeGeneration(
  runtime: RealtimeRuntime,
  audio: () => Float32Array,
  shouldStop: () => boolean,
  onTranscript: (result: TranscriptionResult) => void,
): Promise<TranscriptionResult> {
  const { BaseStreamer, model, processor } = runtime;
  const modelId = `${REALTIME_MODEL_ID}#${runtime.dtypeLabel}-${runtime.runtimeLabel}`;
  const emptyResult = createRealtimeResult(modelId, "", undefined);
  let transcriptText = "";
  let tokensPerSecond: number | undefined;
  let tokenStartAt: number | null = null;
  let tokenCount = 0;

  const pushTranscript = () => {
    onTranscript(createRealtimeResult(modelId, transcriptText, tokensPerSecond));
  };

  const hasAnySamples = await waitUntilWithTimeout(() => audio().length > 0 || shouldStop(), 3000);
  if (!hasAnySamples && !shouldStop()) {
    throw new Error("No microphone audio samples were captured. Check browser microphone permissions and input routing.");
  }

  const reachedFirstChunk = await waitUntilWithTimeout(
    () => audio().length >= processor.num_samples_first_audio_chunk || shouldStop(),
    5000,
  );
  if (!reachedFirstChunk && !shouldStop()) {
    throw new Error(
      `Microphone capture started but did not accumulate enough audio for realtime decoding. Captured ${audio().length} / ${processor.num_samples_first_audio_chunk} samples.`,
    );
  }
  if (shouldStop()) {
    return emptyResult;
  }

  const firstChunkInputs = await processor(audio().subarray(0, processor.num_samples_first_audio_chunk), {
    is_streaming: true,
    is_first_audio_chunk: true,
  });

  const { hop_length, n_fft } = processor.feature_extractor.config;
  const winHalf = Math.floor(n_fft / 2);
  const samplesPerToken = processor.audio_length_per_tok * hop_length;

  async function* inputFeaturesGenerator() {
    yield firstChunkInputs.input_features;

    let melFrameIndex = processor.num_mel_frames_first_audio_chunk;
    let startIndex = melFrameIndex * hop_length - winHalf;

    while (!shouldStop()) {
      const endNeeded = startIndex + processor.num_samples_per_audio_chunk;
      await waitUntil(() => audio().length >= endNeeded || shouldStop());
      if (shouldStop()) break;

      const availableSamples = audio().length;
      let batchEndSample = endNeeded;
      while (batchEndSample + samplesPerToken <= availableSamples) {
        batchEndSample += samplesPerToken;
      }

      const chunkInputs = await processor(audio().slice(startIndex, batchEndSample), {
        is_streaming: true,
        is_first_audio_chunk: false,
      });

      yield chunkInputs.input_features;

      melFrameIndex += chunkInputs.input_features.dims[2];
      startIndex = melFrameIndex * hop_length - winHalf;
    }
  }

  const specialIds = new Set(processor.tokenizer.all_special_ids.map(BigInt));
  let tokenCache: bigint[] = [];
  let decodedLength = 0;
  let isPrompt = true;

  const flushDecodedText = () => {
    if (!tokenCache.length) return;

    const decoded = processor.tokenizer.decode(tokenCache, {
      skip_special_tokens: true,
    });
    const nextSlice = decoded.slice(decodedLength);
    decodedLength = decoded.length;

    if (!nextSlice) return;

    transcriptText += nextSlice;
    pushTranscript();
  };

  const streamer = new (class extends BaseStreamer {
    put(value: bigint[][]) {
      if (shouldStop()) return;
      if (isPrompt) {
        isPrompt = false;
        return;
      }

      const tokens = value[0] ?? [];
      if (tokens.length === 1 && specialIds.has(tokens[0])) {
        return;
      }

      tokenStartAt ??= performance.now();
      tokenCount += tokens.length;
      const elapsedSeconds = (performance.now() - tokenStartAt) / 1000;
      if (elapsedSeconds > 0) {
        tokensPerSecond = tokenCount / elapsedSeconds;
      }

      tokenCache = tokenCache.concat(tokens);
      flushDecodedText();
    }

    end() {
      if (!shouldStop()) {
        flushDecodedText();
      }
      tokenCache = [];
      decodedLength = 0;
      isPrompt = true;
    }
  })();

  try {
    await (model as any).generate({
      input_ids: firstChunkInputs.input_ids,
      input_features: inputFeaturesGenerator(),
      max_new_tokens: 4096,
      streamer,
    });
  } catch (error) {
    if (!shouldStop()) {
      throw error;
    }
  }

  return createRealtimeResult(modelId, transcriptText.trim(), tokensPerSecond);
}

function createRealtimeResult(modelId: string, text: string, tps?: number): TranscriptionResult {
  return {
    mode: "realtime",
    modelId,
    text,
    chunks: [],
    words: [],
    tps,
  };
}

function getRealtimeLoadState(
  info: ProgressInfo,
  progressMap: Map<string, number>,
  previousProgress: number,
): ModelState | null {
  if (info.status === "progress_total" && typeof info.progress === "number") {
    const progress = clampProgress(info.progress, previousProgress);
    return {
      status: "loading",
      progress,
      statusText: `Loading model… ${progress}%`,
    };
  }

  if (
    info.status === "progress" &&
    info.file?.includes(".onnx_data") &&
    typeof info.loaded === "number" &&
    typeof info.total === "number" &&
    info.total > 0
  ) {
    progressMap.set(info.file, info.loaded / info.total);
    const aggregateProgress =
      Array.from(progressMap.values()).reduce((sum, value) => sum + value, 0) / REALTIME_MODEL_FILE_COUNT;
    const progress = clampProgress(Math.min(aggregateProgress * 100, 99), previousProgress);
    return {
      status: "loading",
      progress,
      statusText: formatPendingLoadText("Downloading", info.file, progress),
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

function waitUntil(condition: () => boolean): Promise<void> {
  return new Promise((resolve) => {
    if (condition()) {
      resolve();
      return;
    }

    const timer = window.setInterval(() => {
      if (!condition()) return;
      window.clearInterval(timer);
      resolve();
    }, 50);
  });
}

function waitUntilWithTimeout(condition: () => boolean, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    if (condition()) {
      resolve(true);
      return;
    }

    const timeout = window.setTimeout(() => {
      window.clearInterval(interval);
      resolve(condition());
    }, timeoutMs);

    const interval = window.setInterval(() => {
      if (!condition()) return;
      window.clearTimeout(timeout);
      window.clearInterval(interval);
      resolve(true);
    }, 50);
  });
}

function mixAudioBufferToMono(audioBuffer: AudioBuffer): Float32Array {
  const channelCount = Math.max(1, audioBuffer.numberOfChannels);
  const mono = new Float32Array(audioBuffer.length);

  for (let channelIndex = 0; channelIndex < channelCount; channelIndex += 1) {
    const channel = audioBuffer.getChannelData(channelIndex);
    for (let index = 0; index < audioBuffer.length; index += 1) {
      mono[index] += channel[index] ?? 0;
    }
  }

  for (let index = 0; index < mono.length; index += 1) {
    mono[index] /= channelCount;
  }

  return mono;
}

function createCaptureNormalizer(inputSampleRate: number, outputSampleRate: number) {
  if (!Number.isFinite(inputSampleRate) || inputSampleRate <= 0 || inputSampleRate === outputSampleRate) {
    return (samples: Float32Array) => samples;
  }

  const sampleRateRatio = inputSampleRate / outputSampleRate;
  let carry = new Float32Array(0);
  let position = 0;

  return (samples: Float32Array): Float32Array => {
    if (samples.length === 0) {
      return samples;
    }

    const combined = new Float32Array(carry.length + samples.length);
    combined.set(carry);
    combined.set(samples, carry.length);

    const output: number[] = [];
    while (position + sampleRateRatio <= combined.length) {
      const start = position;
      const end = position + sampleRateRatio;
      const startIndex = Math.floor(start);
      const endIndex = Math.max(startIndex + 1, Math.floor(end));

      let sum = 0;
      let count = 0;
      for (let index = startIndex; index < endIndex && index < combined.length; index += 1) {
        sum += combined[index] ?? 0;
        count += 1;
      }

      output.push(count > 0 ? sum / count : 0);
      position = end;
    }

    const consumed = Math.floor(position);
    carry = consumed > 0 ? combined.slice(consumed) : combined;
    position -= consumed;

    return output.length ? Float32Array.from(output) : new Float32Array(0);
  };
}
