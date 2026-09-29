/// <reference lib="webworker" />
// On-device speech recognition for voice input (Whisper via ONNX Runtime WebAssembly), off the
// main thread. The model and the runtime are downloaded from the Ebbwell server; the audio and
// the transcript never leave this device.

import { Tensor, env, pipeline, type ProgressInfo } from '@huggingface/transformers';

export type VoiceRequest =
  | { type: 'load'; model: string }
  /** `languages`: Whisper codes the speech may be in, the interface language first. */
  | { type: 'transcribe'; model: string; audio: Float32Array; languages: string[] };

export type VoiceReply =
  | { type: 'progress'; loaded: number; total: number }
  | { type: 'ready' }
  | { type: 'text'; text: string; language: string }
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

/** The parts of the transformers.js pipeline used here (transformers.js is pinned in package.json). */
interface Asr {
  (audio: Float32Array, options: Record<string, unknown>): Promise<{ text: string } | { text: string }[]>;
  processor: (audio: Float32Array) => Promise<{ input_features: Tensor }>;
  model: ((inputs: Record<string, Tensor>) => Promise<{ logits: Tensor }>) & {
    generation_config: { decoder_start_token_id: number; lang_to_id: Record<string, number> };
    /** Inputs `generate` passes on to the model; `encoder_outputs` is added so a precomputed encoding is reused. */
    forward_params: string[];
    /** Runs the encoder (internal to transformers.js). */
    _prepare_encoder_decoder_kwargs_for_generation(args: {
      inputs_tensor: Tensor;
      model_inputs: Record<string, Tensor>;
      model_input_name: string;
      generation_config: { guidance_scale: null };
    }): Promise<{ encoder_outputs: Tensor }>;
  };
}

/** A near tie goes to the interface language. */
const PREFERRED_BONUS = 1;

let current: { model: string; asr: Promise<Asr> } | null = null;
const post = (reply: VoiceReply) => self.postMessage(reply);

function load(model: string): Promise<Asr> {
  if (current?.model === model) return current.asr;
  const files = new Map<string, { loaded: number; total: number }>();
  const asr = (
    pipeline('automatic-speech-recognition', model, {
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
    }) as unknown as Promise<Asr>
  ).then(async (asr) => {
    asr.model.forward_params = [...asr.model.forward_params, 'encoder_outputs'];
    // The first run of each model is much slower (runtime warm-up): do it now, while the user
    // is still speaking, on a second of silence.
    await detectLanguage(asr, await encode(asr, new Float32Array(16_000)), ['en', 'fr']);
    return asr;
  });
  current = { model, asr };
  asr.catch(() => {
    if (current?.asr === asr) current = null; // try again next time
  });
  return asr;
}

/** The encoder's output for the audio, computed once for language detection and transcription. */
async function encode(asr: Asr, audio: Float32Array): Promise<Tensor> {
  const { input_features } = await asr.processor(audio);
  const { encoder_outputs } = await asr.model._prepare_encoder_decoder_kwargs_for_generation({
    inputs_tensor: input_features,
    model_inputs: { input_features },
    model_input_name: 'input_features',
    generation_config: { guidance_scale: null },
  });
  return encoder_outputs;
}

/**
 * Which of the candidate languages is spoken. transformers.js has no language detection (it
 * assumes English), so this asks Whisper itself: after the start token, the decoder's scores
 * for the language tokens say which language it hears.
 */
async function detectLanguage(asr: Asr, encoded: Tensor, candidates: string[]): Promise<string> {
  if (candidates.length < 2) return candidates[0] ?? 'en';
  const { decoder_start_token_id, lang_to_id } = asr.model.generation_config;
  const { logits } = await asr.model({
    encoder_outputs: encoded,
    decoder_input_ids: new Tensor('int64', BigInt64Array.from([BigInt(decoder_start_token_id)]), [1, 1]),
  });
  const scores = logits.data as Float32Array;
  const vocab = logits.dims.at(-1)!;
  const last = scores.subarray(scores.length - vocab);
  let best = candidates[0]!;
  let bestScore = -Infinity;
  candidates.forEach((code, i) => {
    const id = lang_to_id[`<|${code}|>`];
    if (id === undefined) return;
    const score = last[id]! + (i === 0 ? PREFERRED_BONUS : 0);
    if (score > bestScore) {
      best = code;
      bestScore = score;
    }
  });
  return best;
}

self.onmessage = async (event: MessageEvent<VoiceRequest>) => {
  const msg = event.data;
  try {
    const asr = await load(msg.model);
    if (msg.type === 'load') return post({ type: 'ready' });
    const encoded = await encode(asr, msg.audio);
    const language = await detectLanguage(asr, encoded, msg.languages);
    const out = await asr(msg.audio, { language, task: 'transcribe', encoder_outputs: encoded });
    const text = (Array.isArray(out) ? out.map((o) => o.text).join(' ') : out.text).trim();
    post({ type: 'text', text, language });
  } catch (err) {
    post({ type: 'error', message: (err as Error).message ?? String(err) });
  }
};
