/**
 * Team sync cryptography (docs/Team_sync.md). Pure: randomness comes in as
 * bytes from the caller (SQLite randomblob, as signingKey.ts does — React
 * Native has no crypto.getRandomValues), so check:team-crypto runs it in Node.
 *
 * One 32-byte team secret, shared face to face in a QR code, is the only key.
 * HKDF-SHA256 derives three values from it that cannot be derived from one
 * another:
 *   - teamId    the server's folder name (the server sees it);
 *   - authToken the bearer token; the server stores only its SHA-256;
 *   - encKey    encrypts content and hashes record / device names — it never
 *               leaves the phones.
 *
 * Records are deflated, then sealed with XChaCha20-Poly1305 (@noble/ciphers,
 * audited by cure53 in 2024). The additional data binds a blob to its team,
 * record and device, so a blob moved to another path does not open.
 */
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { deflateSync, inflateSync, strFromU8, strToU8 } from 'fflate';

export const TEAM_SECRET_BYTES = 32;
export const NONCE_BYTES = 24;
/** First byte of every sealed blob; a future format bumps it. */
const BLOB_VERSION = 1;
const SALT = strToU8('mitalivana-team-v1');

export type TeamKeys = { teamId: string; authToken: string; encKey: Uint8Array };

export function deriveTeamKeys(secret: Uint8Array): TeamKeys {
  if (secret.length !== TEAM_SECRET_BYTES) throw new Error('team secret must be 32 bytes');
  const out = (info: string, len: number) => hkdf(sha256, secret, SALT, strToU8(info), len);
  return {
    teamId: bytesToHex(out('team-id', 16)),
    authToken: b64u(out('auth-token', 32)),
    encKey: out('enc-key', 32),
  };
}

/** What the server stores to check a bearer token (hex SHA-256 of its text). */
export function authTokenHash(authToken: string): string {
  return bytesToHex(sha256(strToU8(authToken)));
}

const keyed = (encKey: Uint8Array, label: string) => bytesToHex(hmac(sha256, encKey, strToU8(label))).slice(0, 32);

/**
 * The server-side name of a record. Checklists and plots by uuid; GLORIA by
 * summit + cycle, so two phones that each started the same survey meet.
 */
export function recordKey(encKey: Uint8Array, kind: string, ident: string): string {
  return keyed(encKey, `rec|${kind}|${ident}`);
}

export function deviceKey(encKey: Uint8Array, installId: string): string {
  return keyed(encKey, `dev|${installId}`);
}

export function aadFor(teamId: string, rec: string, dev: string): Uint8Array {
  return strToU8(`${teamId}|${rec}|${dev}`);
}

/** text → [version][nonce][ciphertext+tag]. */
export function sealRecord(encKey: Uint8Array, nonce: Uint8Array, text: string, aad: Uint8Array): Uint8Array {
  if (nonce.length !== NONCE_BYTES) throw new Error('nonce must be 24 bytes');
  const ct = xchacha20poly1305(encKey, nonce, aad).encrypt(deflateSync(strToU8(text)));
  const out = new Uint8Array(1 + NONCE_BYTES + ct.length);
  out[0] = BLOB_VERSION;
  out.set(nonce, 1);
  out.set(ct, 1 + NONCE_BYTES);
  return out;
}

/** Throws when the blob was altered, moved (wrong aad) or sealed with another key. */
export function openRecord(encKey: Uint8Array, blob: Uint8Array, aad: Uint8Array): string {
  if (blob.length < 1 + NONCE_BYTES + 16 || blob[0] !== BLOB_VERSION) throw new Error('not a team-sync blob');
  const nonce = blob.subarray(1, 1 + NONCE_BYTES);
  const pt = xchacha20poly1305(encKey, nonce, aad).decrypt(blob.subarray(1 + NONCE_BYTES));
  return strFromU8(inflateSync(pt));
}

// ── files (photos, audio, scans; docs/planned/Media_sync.md §3.1, §3.3) ────

/** Plaintext bytes per chunk. A sealed chunk adds 1 + 24 + 16 bytes. */
export const MEDIA_CHUNK_BYTES = 4 * 1024 * 1024;
export const CHUNK_OVERHEAD = 1 + NONCE_BYTES + 16;

/**
 * The server-side name of a file, from the SHA-256 of its content: the same
 * photo gets the same name on every phone and in every record, so it is sent
 * once; without encKey the name says nothing about the content.
 */
export function mediaId(encKey: Uint8Array, contentSha256: Uint8Array): string {
  return keyed(encKey, `media|${bytesToHex(contentSha256)}`);
}

export function chunkCount(size: number): number {
  return Math.max(1, Math.ceil(size / MEDIA_CHUNK_BYTES));
}

/** Binds a chunk to its team, file, position and the file's chunk count: reordered, truncated or moved chunks do not open. */
export function chunkAad(teamId: string, mid: string, index: number, count: number): Uint8Array {
  return strToU8(`${teamId}|m|${mid}|${index}|${count}`);
}

/** Chunk → [version][nonce][ciphertext+tag]. Not deflated: photos and PDFs are compressed already. */
export function sealChunk(encKey: Uint8Array, nonce: Uint8Array, plain: Uint8Array, aad: Uint8Array): Uint8Array {
  if (nonce.length !== NONCE_BYTES) throw new Error('nonce must be 24 bytes');
  const ct = xchacha20poly1305(encKey, nonce, aad).encrypt(plain);
  const out = new Uint8Array(1 + NONCE_BYTES + ct.length);
  out[0] = BLOB_VERSION;
  out.set(nonce, 1);
  out.set(ct, 1 + NONCE_BYTES);
  return out;
}

/** Throws when the chunk was altered, moved (wrong aad) or sealed with another key. */
export function openChunk(encKey: Uint8Array, blob: Uint8Array, aad: Uint8Array): Uint8Array {
  if (blob.length < CHUNK_OVERHEAD || blob[0] !== BLOB_VERSION) throw new Error('not a team-sync chunk');
  return xchacha20poly1305(encKey, blob.subarray(1, 1 + NONCE_BYTES), aad).decrypt(blob.subarray(1 + NONCE_BYTES));
}

// ── invitations (QR / text code) ──────────────────────────────────────────

export type Invite = {
  secret: Uint8Array;
  name: string;
  /** Worker base URL; null = the app's default server. */
  server: string | null;
};

const B64U = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

export function b64u(bytes: Uint8Array): string {
  let out = '';
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out += B64U[(n >> 18) & 63] + B64U[(n >> 12) & 63] + B64U[(n >> 6) & 63] + B64U[n & 63];
  }
  const rest = bytes.length - i;
  if (rest === 1) {
    const n = bytes[i] << 16;
    out += B64U[(n >> 18) & 63] + B64U[(n >> 12) & 63];
  } else if (rest === 2) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8);
    out += B64U[(n >> 18) & 63] + B64U[(n >> 12) & 63] + B64U[(n >> 6) & 63];
  }
  return out;
}

export function fromB64u(s: string): Uint8Array {
  const clean = s.replace(/=+$/, '');
  if (/[^A-Za-z0-9_-]/.test(clean)) throw new Error('bad base64url');
  const out: number[] = [];
  let buf = 0;
  let bits = 0;
  for (const ch of clean) {
    buf = (buf << 6) | B64U.indexOf(ch);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((buf >> bits) & 255);
    }
  }
  return new Uint8Array(out);
}

const checksum = (body: string) => bytesToHex(sha256(strToU8(body))).slice(0, 6);

/** `1.<secret>.<name>.<server>.<checksum>` — all base64url; server empty = default. */
export function encodeInvite(inv: Invite): string {
  const body = ['1', b64u(inv.secret), b64u(strToU8(inv.name)), inv.server ? b64u(strToU8(inv.server)) : ''].join('.');
  return `${body}.${checksum(body)}`;
}

export type InviteError = 'format' | 'checksum' | 'version' | 'server';

/** Accepts the bare code or the whole join link. Whitespace (a code typed by hand) is ignored. */
export function decodeInvite(input: string): Invite | InviteError {
  let code = input.trim();
  const m = code.match(/[?&#]c=([^&#\s]+)/);
  if (m) code = decodeURIComponent(m[1]);
  code = code.replace(/\s+/g, '');
  const parts = code.split('.');
  if (parts.length !== 5) return 'format';
  const [ver, sec, name, server, sum] = parts;
  if (checksum(parts.slice(0, 4).join('.')) !== sum.toLowerCase()) return 'checksum';
  if (ver !== '1') return 'version';
  try {
    const secret = fromB64u(sec);
    if (secret.length !== TEAM_SECRET_BYTES) return 'format';
    const url = server ? strFromU8(fromB64u(server)) : null;
    if (url && !isHttpsUrl(url)) return 'server';
    return { secret, name: strFromU8(fromB64u(name)), server: url };
  } catch {
    return 'format';
  }
}

export function isHttpsUrl(url: string): boolean {
  return /^https:\/\/[a-z0-9.-]+(:\d+)?(\/[^\s]*)?$/i.test(url);
}

/**
 * A server link: scanning it adds a relay to this device's list (printed by
 * mobile/sync-worker/scripts/deploy.mjs after a deploy from a computer).
 */
export function serverLink(url: string): string {
  return `checklister://team/server?url=${encodeURIComponent(url)}`;
}

/** The join link a system camera opens (app scheme `checklister`). */
export function inviteLink(code: string): string {
  return `checklister://team/join?c=${encodeURIComponent(code)}`;
}
