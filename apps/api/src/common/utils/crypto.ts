import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

/**
 * AES-256-GCM envelope encryption for the few columns that hold secrets at
 * rest — TOTP seeds and OAuth provider tokens.
 *
 * Payload layout: `v1.<iv>.<authTag>.<ciphertext>`, all base64url.  The version
 * prefix is what makes key rotation possible: a rotation job can decrypt v1 and
 * re-encrypt as v2 without a flag day, because every row says which key made it.
 */

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12; // 96 bits, the GCM standard
const AUTH_TAG_LENGTH = 16;

export function encrypt(plaintext: string, key: Buffer, version = 1): string {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return [
    `v${version}`,
    iv.toString('base64url'),
    authTag.toString('base64url'),
    ciphertext.toString('base64url'),
  ].join('.');
}

export function decrypt(payload: string, key: Buffer): string {
  const parts = payload.split('.');
  if (parts.length !== 4 || !parts[0]?.startsWith('v')) {
    throw new Error('Malformed ciphertext envelope');
  }

  const [, ivPart, tagPart, dataPart] = parts;
  const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(ivPart!, 'base64url'), {
    authTagLength: AUTH_TAG_LENGTH,
  });
  // Throws on tampering — GCM authenticates as well as encrypts.
  decipher.setAuthTag(Buffer.from(tagPart!, 'base64url'));

  return Buffer.concat([
    decipher.update(Buffer.from(dataPart!, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
}

/**
 * Refresh tokens are stored as SHA-256 digests. They are already 256 bits of
 * CSPRNG output, so there is nothing to brute-force and no need for the cost of
 * a password KDF here — unlike passwords, which use Argon2id.
 */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function generateToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/** Constant-time comparison, so an attacker learns nothing from response time. */
export function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  // Lengths must match before timingSafeEqual, and length is not a secret here.
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/** Numeric recovery codes, formatted in groups for legibility. */
export function generateRecoveryCodes(count = 10): string[] {
  return Array.from({ length: count }, () => {
    const raw = randomBytes(5).toString('hex').toUpperCase();
    return `${raw.slice(0, 5)}-${raw.slice(5, 10)}`;
  });
}
