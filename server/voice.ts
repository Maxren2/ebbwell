// Voice input: serves the Whisper model that browsers run on the device. The audio and the
// transcript never reach the server; only the model files are downloaded from here, by
// signed-in users (they sit under /api, behind the session and app-lock checks).

import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import fastifyStatic from '@fastify/static';
import type { FastifyInstance } from 'fastify';
import type { Config } from './config.ts';
import { VOICE_MODELS } from './voice-models.ts';

export const VOICE_MODELS_PREFIX = '/api/voice/models/';

export interface VoiceInfo {
  /** Model id; the browser loads it from VOICE_MODELS_PREFIX + model. */
  model: string;
  sizeMb: number;
}

/** The configured model, if its files are present. */
export function voiceInfo(config: Config): VoiceInfo | null {
  if (config.VOICE_MODEL === 'off') return null;
  const model = VOICE_MODELS[config.VOICE_MODEL];
  const dir = resolve(config.MODELS_DIR, model.id);
  if (!Object.keys(model.files).every((f) => existsSync(join(dir, f)))) return null;
  return { model: model.id, sizeMb: model.sizeMb };
}

export async function registerVoiceRoutes(app: FastifyInstance, config: Config): Promise<VoiceInfo | null> {
  const info = voiceInfo(config);
  if (!info) {
    if (config.VOICE_MODEL !== 'off') {
      app.log.warn(`Voice input: the ${config.VOICE_MODEL} model is missing in ${resolve(config.MODELS_DIR)} (run: node scripts/fetch-models.ts). Voice input is off.`);
    }
    return null;
  }
  await app.register(fastifyStatic, {
    root: resolve(config.MODELS_DIR, info.model),
    prefix: `${VOICE_MODELS_PREFIX}${info.model}/`,
    decorateReply: false,
    index: false,
    // The directory name carries the model revision, so the files never change.
    setHeaders(res) {
      res.header('Cache-Control', 'private, max-age=31536000, immutable');
    },
  });
  return info;
}
