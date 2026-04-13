import { useEffect, useRef } from "react";

type LiveWaveformProps = {
  stream: MediaStream;
};

const BAR_WIDTH = 3;
const BAR_GAP = 2;
const BAR_STEP = BAR_WIDTH + BAR_GAP;
const MIN_BAR_HEIGHT = 2;
const SAMPLE_INTERVAL_MS = 50;

export default function LiveWaveform({ stream }: LiveWaveformProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const ctxRef = useRef<AudioContext | null>(null);
  const barsRef = useRef<number[]>([]);
  const rafRef = useRef<number>(0);
  const intervalRef = useRef<number>(0);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const audioCtx = new AudioContext();
    ctxRef.current = audioCtx;
    const source = audioCtx.createMediaStreamSource(stream);
    const analyser = audioCtx.createAnalyser();
    analyser.fftSize = 256;
    source.connect(analyser);

    const dataArray = new Uint8Array(analyser.frequencyBinCount);
    barsRef.current = [];

    intervalRef.current = window.setInterval(() => {
      analyser.getByteTimeDomainData(dataArray);

      let sum = 0;
      for (let i = 0; i < dataArray.length; i++) {
        const v = (dataArray[i] - 128) / 128;
        sum += v * v;
      }
      const rms = Math.sqrt(sum / dataArray.length);
      const normalized = Math.min(1, rms * 3);

      barsRef.current.push(normalized);

      const w = canvas.clientWidth;
      const maxBars = Math.ceil(w / BAR_STEP) + 2;
      if (barsRef.current.length > maxBars) {
        barsRef.current = barsRef.current.slice(-maxBars);
      }
    }, SAMPLE_INTERVAL_MS);

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

      const bars = barsRef.current;
      const visibleSlots = Math.floor(w / BAR_STEP);
      const isFull = bars.length >= visibleSlots;

      for (let i = 0; i < bars.length; i++) {
        const amplitude = bars[i];
        const barH = Math.max(MIN_BAR_HEIGHT, amplitude * (h * 0.85));

        const x = isFull
          ? w - (bars.length - i) * BAR_STEP
          : i * BAR_STEP;
        const y = (h - barH) / 2;

        ctx.fillStyle = `rgba(255, 255, 255, ${0.4 + amplitude * 0.6})`;
        ctx.beginPath();
        ctx.roundRect(x, y, BAR_WIDTH, barH, 1.5);
        ctx.fill();
      }

      rafRef.current = requestAnimationFrame(draw);
    };

    rafRef.current = requestAnimationFrame(draw);

    return () => {
      cancelAnimationFrame(rafRef.current);
      clearInterval(intervalRef.current);
      source.disconnect();
      analyser.disconnect();
      void audioCtx.close();
      ctxRef.current = null;
    };
  }, [stream]);

  return <canvas ref={canvasRef} className="live-waveform" />;
}
