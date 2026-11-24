import crypto from 'node:crypto';

export function sha256Hex(value: string): string {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

export function sha256Base64Url(value: string): string {
  return crypto.createHash('sha256').update(value, 'utf8').digest('base64url');
}

export function randomToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString('base64url');
}

export function generateTemporaryPassword(): string {
  const body = crypto.randomBytes(24).toString('base64url');
  return `T${body}`;
}

export function timingSafeEqualString(a: string, b: string): boolean {
  const bufferA = Buffer.from(a, 'utf8');
  const bufferB = Buffer.from(b, 'utf8');
  if (bufferA.length !== bufferB.length) return false;
  return crypto.timingSafeEqual(bufferA, bufferB);
}

export function hmacHex(secret: string, value: string): string {
  return crypto.createHmac('sha256', secret).update(value, 'utf8').digest('hex');
}

export interface SignedCsrfToken {
  token: string;
  expiresAtMs: number;
}

export function createLoginCsrfToken(secret: string, ttlMs = 10 * 60 * 1000): SignedCsrfToken {
  const expiresAtMs = Date.now() + ttlMs;
  const nonce = crypto.randomBytes(18).toString('base64url');
  const payload = `${expiresAtMs}.${nonce}`;
  const signature = hmacHex(secret, payload);
  return { token: `${payload}.${signature}`, expiresAtMs };
}

export function verifyLoginCsrfToken(secret: string, token: string): boolean {
  const parts = token.split('.');
  if (parts.length !== 3) return false;
  const [expiresRaw, nonce, signature] = parts as [string, string, string];
  const expiresAtMs = Number.parseInt(expiresRaw, 10);
  if (!Number.isFinite(expiresAtMs) || expiresAtMs < Date.now()) return false;
  const expected = hmacHex(secret, `${expiresRaw}.${nonce}`);
  return timingSafeEqualString(expected, signature);
}
