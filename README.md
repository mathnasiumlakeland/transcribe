# Static Site

Browser-only WebGPU transcription app modeled after the Cohere WebGPU space, but adapted for realistic static hosting constraints.

## Run

```bash
bun install
bun run dev
```

## Build

```bash
bun run build
```

## Source Modes

- Local upload: audio or video files are decoded and transcribed entirely in the browser.
- Direct media URL: the browser fetches the file directly if the origin allows CORS.
- YouTube / Vimeo page URL: the app embeds the player and captures tab audio locally with `getDisplayMedia`, then transcribes the captured recording in-browser.

## Notes

- The model is `onnx-community/cohere-transcribe-03-2026-ONNX` via `@huggingface/transformers`.
- WebGPU is required for the intended path.
- Completed transcripts are cached in browser localStorage and downloadable as markdown.
