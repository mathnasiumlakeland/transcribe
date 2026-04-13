export type SourceKind = "upload" | "direct" | "youtube" | "vimeo" | "microphone";
export type MediaKind = "audio" | "video";

export type SourceDescriptor = {
  kind: SourceKind;
  label: string;
  sourceUrl?: string;
  embedUrl?: string;
  file?: File;
};

type VideoSourceDescriptor = {
  kind: "youtube" | "vimeo";
  label: string;
  sourceUrl: string;
  embedUrl: string;
};

const YOUTUBE_PATTERNS = [
  /(?:youtube\.com\/watch\?v=)([A-Za-z0-9_-]{11})/i,
  /(?:youtu\.be\/)([A-Za-z0-9_-]{11})/i,
  /(?:youtube\.com\/shorts\/)([A-Za-z0-9_-]{11})/i,
  /(?:youtube\.com\/embed\/)([A-Za-z0-9_-]{11})/i,
];

const VIMEO_PATTERNS = [
  /vimeo\.com\/(?:video\/)?(\d+)/i,
  /player\.vimeo\.com\/video\/(\d+)/i,
];

export function describeUrlInput(value: string): SourceDescriptor | null {
  const trimmed = value.trim();
  if (!trimmed) return null;

  const youtubeId = parseYouTubeId(trimmed);
  if (youtubeId) {
    return {
      kind: "youtube",
      label: "YouTube tab capture",
      sourceUrl: trimmed,
      embedUrl: `https://www.youtube-nocookie.com/embed/${youtubeId}?rel=0&modestbranding=1`,
    };
  }

  const vimeoId = parseVimeoId(trimmed);
  if (vimeoId) {
    return {
      kind: "vimeo",
      label: "Vimeo tab capture",
      sourceUrl: trimmed,
      embedUrl: `https://player.vimeo.com/video/${vimeoId}`,
    };
  }

  try {
    const url = new URL(trimmed);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error("Only http and https URLs are supported.");
    }

    return {
      kind: "direct",
      label: "Direct media fetch",
      sourceUrl: trimmed,
    };
  } catch {
    return null;
  }
}

export function createFileDescriptor(file: File): SourceDescriptor {
  return {
    kind: "upload",
    label: file.name,
    file,
  };
}

export function createMicrophoneDescriptor(): SourceDescriptor {
  return {
    kind: "microphone",
    label: "Microphone capture",
  };
}

export async function fetchSourceBlob(source: SourceDescriptor): Promise<Blob> {
  if (source.kind === "upload" && source.file) {
    return source.file;
  }

  if (source.kind !== "direct" || !source.sourceUrl) {
    throw new Error("This source must be captured from the browser tab.");
  }

  const response = await fetch(source.sourceUrl, { mode: "cors" });
  if (!response.ok) {
    throw new Error(`Media request failed with ${response.status}.`);
  }

  const blob = await response.blob();
  const mediaKind = inferMediaKindFromMime(blob.type) ?? inferMediaKindFromUrl(source.sourceUrl);
  if (!mediaKind) {
    throw new Error("The fetched URL did not return audio or video media.");
  }

  return blob;
}

export async function decodeToMono16k(blob: Blob): Promise<Float32Array> {
  const arrayBuffer = await blob.arrayBuffer();
  const audioContext = new AudioContext({ sampleRate: 16_000 });

  try {
    const audioBuffer = await audioContext.decodeAudioData(arrayBuffer.slice(0));
    const channels = Array.from({ length: audioBuffer.numberOfChannels }, (_, index) =>
      audioBuffer.getChannelData(index),
    );

    if (!channels.length) {
      throw new Error("Decoded media contains no audio channels.");
    }

    const mono = new Float32Array(audioBuffer.length);
    for (let i = 0; i < audioBuffer.length; i += 1) {
      let sum = 0;
      for (const channel of channels) {
        sum += channel[i] ?? 0;
      }
      mono[i] = sum / channels.length;
    }

    return mono;
  } finally {
    await audioContext.close();
  }
}

export function inferSourceTitle(source: SourceDescriptor): string {
  if (source.kind === "upload" && source.file) {
    return source.file.name.replace(/\.[^.]+$/, "");
  }

  if (source.sourceUrl) {
    try {
      const url = new URL(source.sourceUrl);
      const finalSegment = url.pathname.split("/").filter(Boolean).pop();
      if (finalSegment) {
        return decodeURIComponent(finalSegment).replace(/\.[^.]+$/, "");
      }
      return url.hostname;
    } catch {
      return source.label;
    }
  }

  return source.label;
}

export function isVideoProvider(source: SourceDescriptor | null): source is VideoSourceDescriptor {
  return Boolean(source && (source.kind === "youtube" || source.kind === "vimeo") && source.embedUrl && source.sourceUrl);
}

export function inferMediaKindFromMime(mimeType?: string): MediaKind | null {
  if (!mimeType) return null;
  if (mimeType.startsWith("audio/")) return "audio";
  if (mimeType.startsWith("video/")) return "video";
  return null;
}

export function inferMediaKindFromUrl(value?: string): MediaKind | null {
  if (!value) return null;

  try {
    const url = new URL(value);
    const pathname = url.pathname.toLowerCase();
    if (/\.(mp3|wav|m4a|aac|flac|ogg|opus|webm)$/.test(pathname)) {
      return "audio";
    }
    if (/\.(mp4|mov|m4v|avi|mkv|webm|ogv)$/.test(pathname)) {
      return "video";
    }
  } catch {
    return null;
  }

  return null;
}

function parseYouTubeId(url: string): string | null {
  for (const pattern of YOUTUBE_PATTERNS) {
    const match = url.match(pattern);
    if (match?.[1]) return match[1];
  }
  return null;
}

function parseVimeoId(url: string): string | null {
  for (const pattern of VIMEO_PATTERNS) {
    const match = url.match(pattern);
    if (match?.[1]) return match[1];
  }
  return null;
}
