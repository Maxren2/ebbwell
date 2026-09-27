import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

// AES-256-GCM envelope: "v1.<keyId>.<iv>.<ciphertext+tag>" (base64url parts).
// The associated data binds each ciphertext to its row (e.g. "day:<user>:<date>"),
// so ciphertexts cannot be moved between rows or users without detection.

const VERSION = 'v1';
const IV_BYTES = 12;
const TAG_BYTES = 16;

export class Cipher {
  readonly activeKeyId: string;
  private readonly keys = new Map<string, Buffer>();

  constructor(active: Buffer, previous?: Buffer) {
    this.activeKeyId = keyId(active);
    this.keys.set(this.activeKeyId, active);
    if (previous) this.keys.set(keyId(previous), previous);
  }

  encrypt(plaintext: string, aad: string): string {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', this.keys.get(this.activeKeyId)!, iv);
    cipher.setAAD(Buffer.from(aad, 'utf8'));
    const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final(), cipher.getAuthTag()]);
    return [VERSION, this.activeKeyId, iv.toString('base64url'), ct.toString('base64url')].join('.');
  }

  decrypt(token: string, aad: string): string {
    const [version, kid, ivPart, ctPart] = token.split('.');
    if (version !== VERSION || !kid || !ivPart || !ctPart) throw new Error('Malformed ciphertext');
    const key = this.keys.get(kid);
    if (!key) throw new Error(`Unknown encryption key ${kid} (was DATA_ENCRYPTION_KEY changed?)`);
    const iv = Buffer.from(ivPart, 'base64url');
    const data = Buffer.from(ctPart, 'base64url');
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAAD(Buffer.from(aad, 'utf8'));
    decipher.setAuthTag(data.subarray(data.length - TAG_BYTES));
    return Buffer.concat([decipher.update(data.subarray(0, data.length - TAG_BYTES)), decipher.final()]).toString('utf8');
  }

  isStale(token: string): boolean {
    return token.split('.')[1] !== this.activeKeyId;
  }

  encryptJson(value: unknown, aad: string): string {
    return this.encrypt(JSON.stringify(value), aad);
  }

  decryptJson<T>(token: string, aad: string): T {
    return JSON.parse(this.decrypt(token, aad)) as T;
  }
}

function keyId(key: Buffer): string {
  return createHash('sha256').update('lune-key-id').update(key).digest('hex').slice(0, 8);
}

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}
