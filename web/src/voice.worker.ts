/// <reference lib="webworker" />
// On-device speech recognition for voice input (Whisper via ONNX Runtime WebAssembly), off the
// main thread. The model and the runtime are downloaded from the Ebbwell server; the audio and
// the transcript never leave this device.

import { env, pipeline, type ProgressInfo } from '@huggingface/transformers';

export type VoiceRequest =
  | { type: 'load'; model: string }
  | { type: 'transcribe'; model: string; audio: Float32Array; language: string };

export type VoiceReply =
  | { type: 'progress'; loaded: number; total: number }
  | { type: 'ready' }
  | { type: 'text'; text: string }
  | { type: 'error'; message: string };

declare const self: DedicatedWorkerGlobalScope;

// The models come from this Ebbwell server, declared as the "remote" host: the library then
// learns file sizes (for progress) with a 1-byte range request instead of downloading twice.
env.allowLocalModels = false;
env.allowRemoteModels = true;
env.remoteHost = `${self.location.origin}/api/voice/models/`;
env.remotePathTemplate = '{model}/';
// Import the runtime by URL (caching it as a blob: module would need a looser CSP).
env.useWasmCache = false;
const wasm = env.backends.onnx.wasm!;
wasm.wasmPaths = { mjs: `${__ORT_BASE__}ort-wasm-simd-threaded.mjs`, wasm: `${__ORT_BASE__}ort-wasm-simd-threaded.wasm` };
// Several threads need cross-origin isolation (SharedArrayBuffer): the server sends COOP + COEP.
wasm.numThreads = self.crossOriginIsolated ? Math.min(4, Math.max(1, (navigator.hardwareConcurrency || 2) - 1)) : 1;

type Transcriber = (audio: Float32Array, options: Record<string, unknown>) => Promise<{ text: string } | { text: string }[]>;

let current: { model: string; asr: Promise<Transcriber> } | null = null;
const post = (reply: VoiceReply) => self.postMessage(reply);

function load(model: string): Promise<Transcriber> {
  if (current?.model === model) return current.asr;
  const files = new Map<string, { loaded: number; total: number }>();
  const asr = pipeline('automatic-speech-recognition', model, {
    device: 'wasm',
    dtype: { encoder_model: 'q8', decoder_model_merged: 'q8' },
    progress_callback: (p: ProgressInfo) => {
      if (p.status !== 'progress') return;
      files.set(p.file, { loaded: p.loaded, total: p.total });
      let loaded = 0;
      let total = 0;
      for (const f of files.values()) {
        loaded += f.loaded;
        total += f.total;
      }
      post({ type: 'progress', loaded, total });
    },
  }) as unknown as Promise<Transcriber>;
  current = { model, asr };
  asr.catch(() => {
    if (current?.asr === asr) current = null; // try again next time
  });
  return asr;
}

self.onmessage = async (event: MessageEvent<VoiceRequest>) => {
  const msg = event.data;
  try {
    const asr = await load(msg.model);
    if (msg.type === 'load') return post({ type: 'ready' });
    const out = await asr(msg.audio, { language: msg.language, task: 'transcribe' });
    const text = (Array.isArray(out) ? out.map((o) => o.text).join(' ') : out.text).trim();
    post({ type: 'text', text });
  } catch (err) {
    post({ type: 'error', message: (err as Error).message ?? String(err) });
  }
};
