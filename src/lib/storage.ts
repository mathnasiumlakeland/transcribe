import type { SourceDescriptor } from "./media";
import {
  transcriptTextFromChunks,
  type TranscriptChunk,
  type TranscriptionMode,
  type TranscriptionResult,
  type TranscriptWord,
} from "./transcription-types";

const HISTORY_KEY = "transcribe-demo-static-history-v2";
const LEGACY_HISTORY_KEY = "transcribe-demo-static-history-v1";

export type TranscriptRecord = {
  id: string;
  title: string;
  sourceLabel: string;
  sourceUrl?: string;
  sourceKind: SourceDescriptor["kind"];
  mode: TranscriptionMode;
  modelId: string;
  language: string;
  createdAt: string;
  transcript: string;
  chunks: TranscriptChunk[];
  words: TranscriptWord[];
  tps?: number;
  markdown: string;
  filename: string;
  jsonFilename: string;
};

export function loadHistory(): TranscriptRecord[] {
  if (typeof window === "undefined") return [];

  try {
    const raw = window.localStorage.getItem(HISTORY_KEY) ?? window.localStorage.getItem(LEGACY_HISTORY_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as Array<Partial<TranscriptRecord>>;
    if (!Array.isArray(parsed)) return [];

    return parsed.map((record, index) => hydrateRecord(record, index)).filter(Boolean) as TranscriptRecord[];
  } catch {
    return [];
  }
}

export function saveHistory(records: TranscriptRecord[]): void {
  if (typeof window === "undefined") return;

  try {
    window.localStorage.setItem(HISTORY_KEY, JSON.stringify(records.slice(0, 8)));
  } catch {
    // Ignore storage failures; the download still gives the user a local file.
  }
}

export function createTranscriptRecord(
  source: SourceDescriptor,
  result: TranscriptionResult,
  language: string,
  title: string,
): TranscriptRecord {
  const createdAt = new Date().toISOString();
  const safeTitle = slugify(title || source.label || "transcript");
  const filename = `${timestampForFilename(createdAt)}-${safeTitle}.md`;
  const jsonFilename = `${timestampForFilename(createdAt)}-${safeTitle}.json`;
  const transcript = result.text.trim() || transcriptTextFromChunks(result.chunks);
  const markdown = [
    `# ${title || "Transcript"}`,
    "",
    `- Source kind: ${source.kind}`,
    `- Source: ${source.sourceUrl ?? source.label}`,
    `- Language: ${language || "auto"}`,
    `- Mode: ${result.mode}`,
    `- Model: ${result.modelId}`,
    `- Generated: ${createdAt}`,
    ...(result.tps ? [`- Tokens per second: ${result.tps.toFixed(2)}`] : []),
    ...(result.chunks.length
      ? [
          "",
          "## Timeline",
          "",
          ...result.chunks.map((chunk) => `- [${formatTimestampRange(chunk.start, chunk.end)}] ${chunk.text.trim()}`),
        ]
      : []),
    "",
    "## Transcript",
    "",
    transcript.trim(),
    "",
  ].join("\n");

  return {
    id: crypto.randomUUID(),
    title: title || "Transcript",
    sourceLabel: source.label,
    sourceUrl: source.sourceUrl,
    sourceKind: source.kind,
    mode: result.mode,
    modelId: result.modelId,
    language,
    createdAt,
    transcript,
    chunks: result.chunks,
    words: result.words,
    tps: result.tps,
    markdown,
    filename,
    jsonFilename,
  };
}

export function downloadMarkdown(record: Pick<TranscriptRecord, "filename" | "markdown">): void {
  const blob = new Blob([record.markdown], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = record.filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

export function downloadJson(
  record: Pick<
    TranscriptRecord,
    "jsonFilename" | "title" | "mode" | "modelId" | "language" | "createdAt" | "sourceKind" | "sourceLabel" | "sourceUrl" | "chunks"
    | "words"
  >,
): void {
  const json = JSON.stringify(
    {
      title: record.title,
      mode: record.mode,
      modelId: record.modelId,
      language: record.language,
      createdAt: record.createdAt,
      sourceKind: record.sourceKind,
      sourceLabel: record.sourceLabel,
      sourceUrl: record.sourceUrl,
      chunks: record.chunks,
      words: record.words,
    },
    null,
    2,
  );

  const blob = new Blob([json], { type: "application/json;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = record.jsonFilename;
  anchor.click();
  URL.revokeObjectURL(url);
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64) || "transcript";
}

function timestampForFilename(isoString: string): string {
  return isoString
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z")
    .replace("T", "-")
    .replace("Z", "");
}

function hydrateRecord(record: Partial<TranscriptRecord>, index: number): TranscriptRecord | null {
  if (!record.title || !record.createdAt) return null;

  const transcript = record.transcript?.trim() || transcriptTextFromChunks(record.chunks ?? []);
  const safeTitle = slugify(record.title || "transcript");
  const createdAt = record.createdAt;

  return {
    id: record.id ?? crypto.randomUUID(),
    title: record.title,
    sourceLabel: record.sourceLabel ?? "Unknown source",
    sourceUrl: record.sourceUrl,
    sourceKind: record.sourceKind ?? "upload",
    mode: record.mode ?? "accuracy",
    modelId: record.modelId ?? "onnx-community/cohere-transcribe-03-2026-ONNX",
    language: record.language ?? "",
    createdAt,
    transcript,
    chunks: record.chunks ?? [],
    words: record.words ?? [],
    tps: record.tps,
    markdown: record.markdown ?? transcript,
    filename: record.filename ?? `${timestampForFilename(createdAt)}-${safeTitle}-${index}.md`,
    jsonFilename: record.jsonFilename ?? `${timestampForFilename(createdAt)}-${safeTitle}-${index}.json`,
  };
}

function formatTimestampRange(start: number, end: number | null): string {
  const startLabel = formatSeconds(start);
  const endLabel = end == null ? "…" : formatSeconds(end);
  return `${startLabel} - ${endLabel}`;
}

function formatSeconds(value: number): string {
  const wholeMinutes = Math.floor(value / 60)
    .toString()
    .padStart(2, "0");
  const seconds = Math.floor(value % 60)
    .toString()
    .padStart(2, "0");
  const hundredths = Math.round((value % 1) * 100)
    .toString()
    .padStart(2, "0");

  return `${wholeMinutes}:${seconds}.${hundredths}`;
}
