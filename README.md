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

## Models:

- High-accuracy model: `onnx-community/cohere-transcribe-03-2026-ONNX` via `@huggingface/transformers`.
- Timestamped model: `onnx-community/whisper-large-v3-turbo_timestamped` via `@huggingface/transformers`.