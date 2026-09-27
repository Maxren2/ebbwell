// Seeds ~7 realistic cycles for the dev user (AUTH_MODE=dev) so the UI can be explored.
// Usage: node --env-file=.env.dev scripts/seed-demo.ts
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { addDays, localToday } from '../shared/dates.ts';
import type { DayData } from '../shared/schema.ts';
import { loadConfig } from '../server/config.ts';
import { Cipher } from '../server/crypto.ts';
import { Store } from '../server/db.ts';

const config = loadConfig();
if (config.AUTH_MODE !== 'dev') throw new Error('Refusing to seed demo data outside AUTH_MODE=dev');
mkdirSync(config.DATA_DIR, { recursive: true });
const store = new Store(join(config.DATA_DIR, 'lune.sqlite'), new Cipher(config.DATA_ENCRYPTION_KEY));
const user = store.upsertUser('dev-user', 'Dev user');

let seed = 42;
const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
const noise = (amp: number) => (rand() - 0.5) * 2 * amp;

const lengths = [29, 31, 28, 30, 32, 29];
const today = localToday();
let start = addDays(today, -(lengths.reduce((a, b) => a + b, 0) + 11));
store.deleteAllDays(user.id);

for (const [ci, length] of [...lengths, 30].entries()) {
  const current = ci === lengths.length;
  const ov = length - 13 + Math.round(noise(1));
  for (let day = 1; day <= length; day++) {
    const date = addDays(start, day - 1);
    if (date > today) break;
    const d: DayData = {};
    if (day <= 5) d.bleeding = { value: day === 1 ? 'medium' : day <= 3 ? 'heavy' : day === 4 ? 'light' : 'spotting' };
    const base = day <= ov ? 36.42 : day === ov + 1 ? 36.62 : 36.84;
    d.temperature = { value: Math.round((base + noise(0.07)) * 100) / 100, time: '06:45' };
    if (rand() < 0.06) d.temperature = { ...d.temperature, disturbances: ['sleep'], exclude: true, value: d.temperature.value + 0.3 };
    if (day > 5) {
      const rel = day - ov;
      d.mucus =
        rel >= -3 && rel <= 0 ? { sensation: 'wet', appearance: 'eggwhite' }
        : rel >= -6 && rel < -3 ? { sensation: 'moist', appearance: 'creamy' }
        : rel > 0 && rel <= 2 ? { sensation: 'nothing', appearance: 'creamy' }
        : { sensation: 'dry', appearance: 'none' };
    }
    if (day === ov - 1) d.lh = 'positive';
    if (day === 2) d.symptoms = ['cramps', 'fatigue'];
    if (day === length - 2) d.mood = ['irritable'];
    if (day === ov - 2 || day === 20) d.sex = 'protected';
    store.putDay(user.id, date, d);
  }
  if (!current) start = addDays(start, length);
}
store.close();
console.log(`Seeded demo cycles for "${user.name}" up to ${today}`);
