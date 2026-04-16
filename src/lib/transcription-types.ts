export type TranscriptionMode = "accuracy" | "timestamps" | "realtime";

export type ModelState = {
  status: "idle" | "loading" | "ready" | "error";
  progress: number;
  statusText: string;
  error?: string;
};

export type TranscriptChunk = {
  id: string;
  text: string;
  start: number;
  end: number | null;
  final: boolean;
  wordStartIndex?: number;
  wordEndIndex?: number;
};

export type TranscriptWord = {
  id: string;
  text: string;
  start: number;
  end: number | null;
  final: boolean;
};

export type TranscriptionResult = {
  mode: TranscriptionMode;
  modelId: string;
  text: string;
  chunks: TranscriptChunk[];
  words: TranscriptWord[];
  tps?: number;
};

export function createChunkId(start: number, index: number): string {
  return `${Math.round(start * 100)}-${index}`;
}

export function transcriptTextFromChunks(chunks: TranscriptChunk[]): string {
  return chunks
    .map((chunk) => chunk.text)
    .join("")
    .replace(/\s+\n/g, "\n")
    .trim();
}
