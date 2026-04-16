# AGENTS.md

## Project snapshot

This repo is a browser-only transcription app built with React, Vite, Bun, and TypeScript. It runs Hugging Face speech models locally in the browser with WebGPU. There is no backend, no server-side transcription path, and no persistence beyond browser-local storage and user-triggered downloads.

## Stack and workflow

- Package manager: `bun` (`packageManager: bun@1.2.13`)
- App stack: React 19, TypeScript, Vite 6
- Primary validation command: `bun run build`
- Local dev: `bun run dev`
- Preview build: `bun run preview`

There are currently no repo-defined test or lint scripts. If you change behavior, rely on `bun run build` plus targeted manual checks in a current Chromium-based browser with WebGPU enabled.

`vite.config.ts` supports a deploy base path via `BASE_PATH`. If you touch asset paths or deployment behavior, keep that flow intact.

## Important files

- `src/App.tsx`: Main UI and orchestration. Owns mode selection, model warmup, file upload, microphone capture, live transcript state, playback sync, copy/download actions, and local history updates.
- `src/lib/transcriber.ts`: Accuracy mode loader and inference path using `onnx-community/cohere-transcribe-03-2026-ONNX` on WebGPU.
- `src/lib/whisper-transcriber.ts`: Main-thread wrapper around the timestamp worker.
- `src/lib/whisper.worker.ts`: Timestamped transcription pipeline using `onnx-community/whisper-large-v3-turbo_timestamped`, word timestamps, and chunk grouping.
- `src/lib/media.ts`: Source descriptors plus media decoding to mono 16 kHz `Float32Array`.
- `src/lib/storage.ts`: Transcript record creation, localStorage history hydration, and Markdown/JSON/SRT/VTT export helpers.
- `src/lib/transcription-types.ts`: Shared result, chunk, and word types. Treat these as cross-module contracts.
- `src/AudioWaveform.tsx`: Audio playback UI and waveform seeking for timestamp mode.
- `src/LiveWaveform.tsx`: Live microphone waveform during capture.

## Architecture notes

- The app has two user-facing modes:
  - `accuracy`: streams plain transcript text, no timestamps, no media-sync timeline.
  - `timestamps`: runs in a worker, produces `words` and grouped `chunks`, and enables synced playback plus caption exports.
- Treat `accuracy` and `timestamps` as distinct UX flows, not as a single transcript feature with optional metadata.
- All transcription paths normalize media through `decodeToMono16k()` before inference. Do not bypass that unless model input requirements change across the app.
- Accuracy mode runs the model on the main thread and streams tokens into the UI.
- Timestamp mode runs in `src/lib/whisper.worker.ts`; partial updates are text-only during inference, and final chunk/word structures are produced at completion.
- Timestamp transcription transfers `audio.buffer` into the worker. Treat the input PCM buffer as consumed once `transcribeTimestampedAudio()` is called.
- Caption exports depend on the timestamp data shape. If you change chunk or word semantics, update `src/App.tsx`, `src/lib/storage.ts`, and `src/lib/whisper.worker.ts` together.
- Local history is browser-only, keyed under `transcribe-demo-static-history-v2`, with fallback hydration from `...-v1`, and capped to the most recent 8 records.
- `history` is persisted but not surfaced in the current UI; treat it as an export/cache mechanism unless you explicitly add a history view.
- The app is local-first, but first-run model download and browser caching are part of the product behavior. Preserve those loading/progress states if you change model initialization.

## Repo-specific guidance

- Preserve the offline/local-first product assumption unless the task explicitly asks for remote services.
- Keep browser capability checks intact. Both model paths explicitly fail when WebGPU is unavailable.
- The current UI exposes upload and microphone capture. `src/lib/media.ts` also contains direct URL / YouTube / Vimeo helpers that are not wired into the current UI. Do not assume those flows are active unless you also implement and validate the UI path.
- There is no true cancellation path today. Resetting the UI does not cancel in-flight decode or inference, so changes around navigation and async state should be reviewed carefully.
- Timestamp mode relies on stable `TranscriptChunk` / `TranscriptWord` IDs and `wordStartIndex` / `wordEndIndex` ranges for playback highlighting. Changes here can silently break seeking and active-word underlining.
- Preserve the timestamp interaction details: chunk and word rows are keyboard-seekable, the view auto-follows until the user scrolls away, and the `Focus view` affordance restores the active segment.
- `AudioWaveform.tsx` and `LiveWaveform.tsx` re-render from browser audio primitives. If you change them, keep cleanup logic intact to avoid leaked `AudioContext`s, animation frames, or intervals.
- `dist/`, `*.tsbuildinfo`, `vite.config.js`, and `vite.config.d.ts` are generated/ignored outputs. Do not hand-edit them.

## Validation expectations

Run `bun run build` after code changes.

If you touch transcription, playback, exports, or capture flows, also do manual browser checks:

- Warm both modes from the select screen and confirm the model-ready state resolves.
- Upload an audio or video file and verify transcription completes.
- In timestamp mode, verify playback seeking from chunks/words still works.
- If you change storage or export code, verify Markdown/JSON/SRT/VTT downloads still produce sensible output.
