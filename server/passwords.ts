// scrypt hashing for passwords and app-lock PINs: "scrypt$N$r$p$salt$hash" (base64url).

import { randomBytes, randomInt, scrypt as scryptCb, timingSafeEqual, type ScryptOptions } from 'node:crypto';

const SCRYPT = { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 } satisfies ScryptOptions;

function scrypt(secret: string, salt: Buffer, params: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scryptCb(secret.normalize('NFKC'), salt, 32, params, (err, key) => (err ? reject(err) : resolve(key))),
  );
}

export async function hashSecret(secret: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(secret, salt, SCRYPT);
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64url'), key.toString('base64url')].join('$');
}

export async function verifySecret(secret: string, stored: string): Promise<boolean> {
  const [alg, N, r, p, salt, hash] = stored.split('$');
  if (alg !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64url');
  const key = await scrypt(secret, Buffer.from(salt, 'base64url'), { N: Number(N), r: Number(r), p: Number(p), maxmem: SCRYPT.maxmem });
  return key.length === expected.length && timingSafeEqual(key, expected);
}

/** A hash to verify against when the account doesn't exist, so timing doesn't reveal usernames. */
let dummy: Promise<string> | null = null;
export const dummyHash = () => (dummy ??= hashSecret(randomBytes(16).toString('hex')));

/** One-time password for new accounts and resets: 16 characters without look-alikes (~92 bits). */
export function temporaryPassword(): string {
  const alphabet = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let out = '';
  for (let i = 0; i < 16; i++) out += alphabet[randomInt(alphabet.length)];
  return out.replace(/(.{4})(?!$)/g, '$1-');
}
