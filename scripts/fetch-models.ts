// Downloads the Whisper speech models that browsers run for voice input, at pinned revisions,
// and checks every file against its SHA-256. The Docker build runs this; for development:
//   node scripts/fetch-models.ts            (both models into ./models)
//   node scripts/fetch-models.ts base       (only one)
// Files land in <MODELS_DIR>/<model id>/, the id carrying the revision so browsers can cache
// them forever.

import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { VOICE_MODELS, type VoiceModelSize } from '../server/voice-models.ts';

const root = process.env.MODELS_DIR ?? 'models';
const wanted = (process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(VOICE_MODELS)) as VoiceModelSize[];

const sha256 = (data: Uint8Array) => createHash('sha256').update(data).digest('hex');

for (const size of wanted) {
  const model = VOICE_MODELS[size];
  if (!model) throw new Error(`Unknown model "${size}" (expected ${Object.keys(VOICE_MODELS).join(', ')})`);
  for (const [file, expected] of Object.entries(model.files)) {
    const target = join(root, model.id, file);
    try {
      if (sha256(await readFile(target)) === expected) continue; // already there
    } catch {
      /* missing: download */
    }
    const url = `https://huggingface.co/${model.repo}/resolve/${model.revision}/${file}`;
    process.stdout.write(`${model.id}/${file} … `);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
    const data = new Uint8Array(await res.arrayBuffer());
    const actual = sha256(data);
    if (actual !== expected) throw new Error(`${url}: SHA-256 ${actual}, expected ${expected}`);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(`${target}.part`, data);
    await rename(`${target}.part`, target);
    console.log(`${(data.length / 1e6).toFixed(1)} MB`);
  }
  console.log(`${model.id}: ok`);
}
