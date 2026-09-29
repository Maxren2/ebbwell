// Voice input with Whisper on this device: records from the microphone, converts to 16 kHz mono
// and transcribes in a worker. Nothing is uploaded; the model comes from the Ebbwell server
// once and stays in the browser's cache.

import { LANGUAGES, isLang, type Lang } from '../../shared/i18n/index.ts';
import type { VoiceReply, VoiceRequest } from './voice.worker.ts';

export const MAX_RECORDING_SECONDS = 30;
const SAMPLE_RATE = 16_000; // what Whisper expects
// Ebbwell's language codes (en, fr, de, ar) are also Whisper's.
/** Where the transformers library caches downloaded model files (its default cache name). */
const MODEL_CACHE = 'transformers-cache';

export const voiceSupported = () =>
  window.isSecureContext && !!navigator.mediaDevices?.getUserMedia && typeof MediaRecorder !== 'undefined' && typeof Worker !== 'undefined';

// ------------------------------------------------------------------ worker

let worker: Worker | null = null;
let queue: Promise<unknown> = Promise.resolve();

function ask(req: VoiceRequest, onProgress?: (fraction: number) => void): Promise<VoiceReply> {
  const run = () =>
    new Promise<VoiceReply>((resolve, reject) => {
      worker ??= new Worker(new URL('./voice.worker.ts', import.meta.url), { type: 'module', name: 'voice' });
      const w = worker;
      const onMessage = (e: MessageEvent<VoiceReply>) => {
        const r = e.data;
        if (r.type === 'progress') {
          if (r.total > 0) onProgress?.(r.loaded / r.total);
          return;
        }
        w.removeEventListener('message', onMessage);
        w.removeEventListener('error', onError);
        if (r.type === 'error') reject(new Error(r.message));
        else resolve(r);
      };
      const onError = (e: ErrorEvent) => {
        w.removeEventListener('message', onMessage);
        w.removeEventListener('error', onError);
        worker?.terminate();
        worker = null;
        reject(new Error(e.message || 'voice worker failed'));
      };
      w.addEventListener('message', onMessage);
      w.addEventListener('error', onError);
      w.postMessage(req, req.type === 'transcribe' ? [req.audio.buffer] : []);
    });
  const next = queue.then(run, run);
  queue = next.catch(() => {});
  return next;
}

/** Downloads (first time) and initialises the model. */
export async function prepareVoice(model: string, onProgress?: (fraction: number) => void): Promise<void> {
  await ask({ type: 'load', model }, onProgress);
}

/**
 * The speech may be in any of Ebbwell's languages, whatever the interface language (people
 * switch languages): the worker detects which one, the interface language winning near ties.
 */
export async function transcribe(
  model: string,
  audio: Float32Array,
  preferred: Lang,
  onProgress?: (fraction: number) => void,
): Promise<{ text: string; lang: Lang }> {
  const languages = [preferred, ...LANGUAGES.filter((l) => l !== preferred)];
  const reply = await ask({ type: 'transcribe', model, audio, languages }, onProgress);
  if (reply.type !== 'text') return { text: '', lang: preferred };
  return { text: reply.text, lang: isLang(reply.language) ? reply.language : preferred };
}

// ------------------------------------------------------------------ model cache

const cacheUrl = (model: string) => `${location.origin}/api/voice/models/${model}/onnx/decoder_model_merged_quantized.onnx`;

/** The model is already on this device (no download needed). */
export async function voiceModelCached(model: string): Promise<boolean> {
  try {
    const cache = await caches.open(MODEL_CACHE);
    return !!(await cache.match(cacheUrl(model)));
  } catch {
    return false;
  }
}

/** Frees the space the model takes on this device. */
export async function removeVoiceModel(): Promise<void> {
  worker?.terminate();
  worker = null;
  try {
    await caches.delete(MODEL_CACHE);
  } catch {
    /* nothing cached */
  }
}

// ------------------------------------------------------------------ recording

export interface Recording {
  /** Stops and returns 16 kHz mono samples. */
  stop(): Promise<Float32Array>;
  cancel(): void;
}

export async function startRecording(): Promise<Recording> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
  const recorder = new MediaRecorder(stream);
  const chunks: Blob[] = [];
  recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  const stopped = new Promise<void>((resolve) => (recorder.onstop = () => resolve()));
  recorder.start();
  const release = () => stream.getTracks().forEach((t) => t.stop());
  return {
    async stop() {
      if (recorder.state !== 'inactive') recorder.stop();
      await stopped;
      release();
      return toMono16k(await new Blob(chunks, { type: recorder.mimeType }).arrayBuffer());
    },
    cancel() {
      if (recorder.state !== 'inactive') recorder.stop();
      release();
    },
  };
}

async function toMono16k(data: ArrayBuffer): Promise<Float32Array> {
  const ctx = new AudioContext();
  try {
    const decoded = await ctx.decodeAudioData(data);
    const offline = new OfflineAudioContext(1, Math.max(1, Math.ceil(decoded.duration * SAMPLE_RATE)), SAMPLE_RATE);
    const source = offline.createBufferSource();
    source.buffer = decoded;
    source.connect(offline.destination); // downmixes to mono
    source.start();
    return (await offline.startRendering()).getChannelData(0);
  } finally {
    void ctx.close();
  }
}
