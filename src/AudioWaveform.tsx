import { useEffect, useRef, useCallback, useState } from "react";

type AudioWaveformProps = {
  src: string;
  mediaRef: React.RefObject<HTMLAudioElement | null>;
  currentTime: number;
  duration: number;
  onTimeUpdate: () => void;
  onLoaded: () => void;
  onSeeked: () => void;
};

const BAR_WIDTH = 2;
const BAR_GAP = 1.5;
const BAR_STEP = BAR_WIDTH + BAR_GAP;
const MIN_BAR_FRAC = 0.04;

export default function AudioWaveform({
  src,
  mediaRef,
  currentTime,
  duration,
  onTimeUpdate,
  onLoaded,
  onSeeked,
}: AudioWaveformProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const peaksRef = useRef<number[]>([]);
  const rafRef = useRef<number>(0);
  const [isPlaying, setIsPlaying] = useState(false);

  const computePeaks = useCallback((canvas: HTMLCanvasElement, audioBuffer: AudioBuffer) => {
    const w = canvas.clientWidth;
    const barCount = Math.floor(w / BAR_STEP);
    if (barCount <= 0) return [];

    const channel = audioBuffer.getChannelData(0);
    const samplesPerBar = Math.floor(channel.length / barCount);
    const peaks: number[] = [];

    for (let i = 0; i < barCount; i++) {
      const start = i * samplesPerBar;
      const end = Math.min(start + samplesPerBar, channel.length);
      let sum = 0;
      for (let j = start; j < end; j++) {
        sum += Math.abs(channel[j]);
      }
      peaks.push(sum / (end - start));
    }

    const max = Math.max(...peaks, 0.001);
    return peaks.map((p) => p / max);
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    let cancelled = false;
    const audioCtx = new AudioContext();

    fetch(src)
      .then((r) => r.arrayBuffer())
      .then((buf) => audioCtx.decodeAudioData(buf))
      .then((audioBuffer) => {
        if (cancelled) return;
        peaksRef.current = computePeaks(canvas, audioBuffer);
      })
      .catch(() => {});

    return () => {
      cancelled = true;
      void audioCtx.close();
    };
  }, [src, computePeaks]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ro = new ResizeObserver(() => {
      if (peaksRef.current.length) {
        const audioCtx = new AudioContext();
        fetch(src)
          .then((r) => r.arrayBuffer())
          .then((buf) => audioCtx.decodeAudioData(buf))
          .then((audioBuffer) => {
            peaksRef.current = computePeaks(canvas, audioBuffer);
          })
          .catch(() => {})
          .finally(() => void audioCtx.close());
      }
    });
    ro.observe(canvas);
    return () => ro.disconnect();
  }, [src, computePeaks]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const draw = () => {
      const ctx = canvas.getContext("2d");
      if (!ctx) return;

      const dpr = devicePixelRatio;
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;

      if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
        canvas.width = w * dpr;
        canvas.height = h * dpr;
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);

      const peaks = peaksRef.current;
      if (!peaks.length) {
        rafRef.current = requestAnimationFrame(draw);
        return;
      }

      const progress = duration > 0 ? currentTime / duration : 0;
      const playedBars = Math.floor(progress * peaks.length);

      for (let i = 0; i < peaks.length; i++) {
        const amplitude = Math.max(MIN_BAR_FRAC, peaks[i]);
        const barH = amplitude * (h * 0.82);
        const x = i * BAR_STEP;
        const y = (h - barH) / 2;

        const played = i <= playedBars;
        ctx.fillStyle = played
          ? "rgba(255, 255, 255, 0.95)"
          : `rgba(255, 255, 255, ${0.2 + amplitude * 0.2})`;

        ctx.beginPath();
        ctx.roundRect(x, y, BAR_WIDTH, barH, 1);
        ctx.fill();
      }

      rafRef.current = requestAnimationFrame(draw);
    };

    rafRef.current = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(rafRef.current);
  }, [currentTime, duration]);

  useEffect(() => {
    const el = mediaRef.current;
    if (!el) return;
    const onPlay = () => setIsPlaying(true);
    const onPause = () => setIsPlaying(false);
    el.addEventListener("play", onPlay);
    el.addEventListener("pause", onPause);
    return () => {
      el.removeEventListener("play", onPlay);
      el.removeEventListener("pause", onPause);
    };
  }, [mediaRef, src]);

  const handleCanvasClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const el = mediaRef.current;
    if (!el || !duration) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const frac = (e.clientX - rect.left) / rect.width;
    el.currentTime = Math.max(0, Math.min(duration, frac * duration));
  };

  const togglePlayPause = () => {
    const el = mediaRef.current;
    if (!el) return;
    if (el.paused) {
      void el.play();
    } else {
      el.pause();
    }
  };

  return (
    <div className="audio-player">
      <audio
        key={src}
        ref={(node) => {
          (mediaRef as React.MutableRefObject<HTMLAudioElement | null>).current = node;
        }}
        src={src}
        preload="metadata"
        onLoadedMetadata={onLoaded}
        onTimeUpdate={onTimeUpdate}
        onSeeked={onSeeked}
      />
      <button type="button" className="play-btn" onClick={togglePlayPause} aria-label={isPlaying ? "Pause" : "Play"}>
        {isPlaying ? (
          <svg width="20" height="20" viewBox="0 0 20 20" fill="currentColor">
            <rect x="4" y="3" width="4.5" height="14" rx="1" />
            <rect x="11.5" y="3" width="4.5" height="14" rx="1" />
          </svg>
        ) : (
          <svg width="20" height="20" viewBox="0 0 20 20" fill="currentColor">
            <path d="M5 3.5a1 1 0 0 1 1.53-.85l10 6.5a1 1 0 0 1 0 1.7l-10 6.5A1 1 0 0 1 5 16.5v-13z" />
          </svg>
        )}
      </button>
      <canvas ref={canvasRef} className="audio-waveform-canvas" onClick={handleCanvasClick} />
    </div>
  );
}
