import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { buildApp, defaultPush } from './app.ts';
import { loadConfig } from './config.ts';
import { Cipher } from './crypto.ts';
import { Store } from './db.ts';
import { runReminders } from './push.ts';

const HOUR_MS = 3_600_000;

let config;
try {
  config = loadConfig();
} catch (err) {
  console.error((err as Error).message);
  process.exit(1);
}

// Database, WAL and backups are readable by the app user only.
process.umask(0o077);
mkdirSync(config.DATA_DIR, { recursive: true });
const cipher = new Cipher(config.DATA_ENCRYPTION_KEY, config.DATA_ENCRYPTION_KEY_PREVIOUS);
const store = new Store(join(config.DATA_DIR, 'ebbwell.sqlite'), cipher);
const push = defaultPush(store, config);
const app = await buildApp({ config, store, cipher, push });

if (config.DATA_ENCRYPTION_KEY_PREVIOUS) {
  const n = store.rotateKeys();
  app.log.info(`Key rotation: re-encrypted ${n} records. You can now remove DATA_ENCRYPTION_KEY_PREVIOUS.`);
}

const backupDir = join(config.DATA_DIR, 'backups');
const maintenance = () => {
  try {
    store.purgeExpiredSessions(Date.now() - config.SESSION_IDLE_DAYS * 24 * HOUR_MS);
    if (store.lastBackupAge(backupDir) > 23 * HOUR_MS) {
      const file = store.backup(backupDir, config.BACKUP_RETENTION_DAYS);
      if (file) app.log.info(`Backup written: ${file}`);
    }
  } catch (err) {
    app.log.error({ err }, 'Maintenance failed');
  }
};
maintenance();
const timer = setInterval(maintenance, HOUR_MS);

// Reminders: checked every minute; each one is sent at most once.
let remindersRunning = false;
const reminders = setInterval(async () => {
  if (remindersRunning) return;
  remindersRunning = true;
  try {
    const n = await runReminders(store, push.send);
    if (n) app.log.info(`Sent ${n} reminder(s)`);
  } catch (err) {
    app.log.error({ err }, 'Reminders failed');
  } finally {
    remindersRunning = false;
  }
}, 60_000);

const shutdown = async (signal: string) => {
  app.log.info(`${signal} received, shutting down`);
  clearInterval(timer);
  clearInterval(reminders);
  await app.close();
  store.close();
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

await app.listen({ host: config.HOST, port: config.PORT });
