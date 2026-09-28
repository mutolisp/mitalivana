/**
 * Team sync cryptography (src/lib/teamCrypto.ts):
 *   - one secret → fixed teamId / authToken / encKey, all different, and a
 *     different secret gives different ones;
 *   - seal / open round trip; the stored bytes contain none of the plaintext;
 *   - a flipped byte, another team's key, or the blob moved to another record
 *     or device (different additional data) does not open;
 *   - record / device names are keyed hashes (no uuid in them);
 *   - invitations round-trip as a code and as a join link, typos are caught by
 *     the checksum, a non-https server is refused;
 *   - files: the name follows the content and the team key; chunks round-trip
 *     and do not open at another index, count, file, team key or when altered.
 */
import {
  aadFor,
  authTokenHash,
  chunkAad,
  chunkCount,
  MEDIA_CHUNK_BYTES,
  mediaId,
  openChunk,
  sealChunk,
  decodeInvite,
  deriveTeamKeys,
  deviceKey,
  encodeInvite,
  inviteLink,
  openRecord,
  recordKey,
  sealRecord,
} from '../src/lib/teamCrypto.ts';
import { sha256 } from '@noble/hashes/sha2.js';

let failed = 0;
const ok = (msg, cond) => {
  if (!cond) {
    failed++;
    console.error(`✗ ${msg}`);
  }
};
const throws = (fn) => {
  try {
    fn();
    return false;
  } catch {
    return true;
  }
};

const secret = Uint8Array.from({ length: 32 }, (_, i) => i * 7 + 3);
const other = Uint8Array.from({ length: 32 }, (_, i) => 255 - i);
const nonce = Uint8Array.from({ length: 24 }, (_, i) => i + 1);

const k = deriveTeamKeys(secret);
const k2 = deriveTeamKeys(secret);
const ko = deriveTeamKeys(other);
ok('derivation is deterministic', k.teamId === k2.teamId && k.authToken === k2.authToken && k.encKey.join() === k2.encKey.join());
ok('teamId, authToken and encKey differ', k.teamId !== k.authToken && k.teamId !== Buffer.from(k.encKey).toString('hex').slice(0, 32));
ok('another secret → another team', k.teamId !== ko.teamId && k.authToken !== ko.authToken);
ok('teamId is 32 hex', /^[0-9a-f]{32}$/.test(k.teamId));
ok('auth hash is 64 hex and not the token', /^[0-9a-f]{64}$/.test(authTokenHash(k.authToken)) && !authTokenHash(k.authToken).includes(k.authToken));
ok('32-byte secret required', throws(() => deriveTeamKeys(new Uint8Array(16))));

const rec = recordKey(k.encKey, 'gloria', 'TW-DAS-SUN|5');
const dev = deviceKey(k.encKey, 'install-uuid-1');
ok('record / device keys are 32 hex, no identifier inside', /^[0-9a-f]{32}$/.test(rec) && /^[0-9a-f]{32}$/.test(dev) && !rec.includes('DAS'));
ok('record key depends on the team key', rec !== recordKey(ko.encKey, 'gloria', 'TW-DAS-SUN|5'));

const yml = 'record_type: gloria\nsummit:\n  full_code: TW-DAS-SUN\nspecies:\n  - unit: N31\n    comments: 東北側有水鹿排遺\n    decimal_latitude: 24.4567\n';
const aad = aadFor(k.teamId, rec, dev);
const blob = sealRecord(k.encKey, nonce, yml, aad);
ok('round trip', openRecord(k.encKey, blob, aad) === yml);
const asText = Buffer.from(blob).toString('latin1');
ok('ciphertext holds none of the plaintext', !['TW-DAS-SUN', 'N31', '24.4567', 'gloria'].some((s) => asText.includes(s)));
const flipped = blob.slice();
flipped[flipped.length - 5] ^= 1;
ok('a flipped byte does not open', throws(() => openRecord(k.encKey, flipped, aad)));
ok('another team key does not open', throws(() => openRecord(ko.encKey, blob, aad)));
ok('moved to another record does not open', throws(() => openRecord(k.encKey, blob, aadFor(k.teamId, recordKey(k.encKey, 'gloria', 'x'), dev))));
ok('moved to another device does not open', throws(() => openRecord(k.encKey, blob, aadFor(k.teamId, rec, deviceKey(k.encKey, 'other')))));
ok('two seals with different nonces differ', sealRecord(k.encKey, nonce.map((x) => x ^ 9), yml, aad).join() !== blob.join());

const inv = { secret, name: '大霸尖山調查隊', server: 'https://sync.example.org' };
const code = encodeInvite(inv);
const back = decodeInvite(code);
ok('invite code round trip', typeof back === 'object' && back.name === inv.name && back.server === inv.server && back.secret.join() === secret.join());
const viaLink = decodeInvite(inviteLink(code));
ok('join link round trip', typeof viaLink === 'object' && viaLink.name === inv.name);
const def = decodeInvite(encodeInvite({ ...inv, server: null }));
ok('empty server = default', typeof def === 'object' && def.server === null);
ok('typed with spaces and line breaks', typeof decodeInvite(code.replace(/(.{8})/g, '$1 \n')) === 'object');
const typo = code.slice(0, 10) + (code[10] === 'A' ? 'B' : 'A') + code.slice(11);
ok('a typo is caught by the checksum', decodeInvite(typo) === 'checksum');
ok('http server refused', decodeInvite(encodeInvite({ ...inv, server: 'http://sync.example.org' })) === 'server');
ok('garbage is a format error', decodeInvite('hello') === 'format');

// ── files ──
const photo = Uint8Array.from({ length: 5000 }, (_, i) => (i * 31) & 255);
const mid = mediaId(k.encKey, sha256(photo));
ok('file name: 32 hex, same content → same name', /^[0-9a-f]{32}$/.test(mid) && mid === mediaId(k.encKey, sha256(photo.slice())));
ok('file name: another content or team key → another name', mid !== mediaId(k.encKey, sha256(photo.subarray(1))) && mid !== mediaId(ko.encKey, sha256(photo)));
ok('chunk count: 0 and exact multiples', [chunkCount(0), chunkCount(1), chunkCount(MEDIA_CHUNK_BYTES), chunkCount(MEDIA_CHUNK_BYTES + 1)].join() === '1,1,1,2');
const caad = chunkAad(k.teamId, mid, 1, 3);
const chunk = sealChunk(k.encKey, nonce, photo, caad);
ok('chunk round trip', openChunk(k.encKey, chunk, caad).join() === photo.join());
ok('chunk size = plain + 41', chunk.length === photo.length + 41);
ok('chunk at another index does not open', throws(() => openChunk(k.encKey, chunk, chunkAad(k.teamId, mid, 2, 3))));
ok('chunk with another count (truncated file) does not open', throws(() => openChunk(k.encKey, chunk, chunkAad(k.teamId, mid, 1, 2))));
ok('chunk moved to another file does not open', throws(() => openChunk(k.encKey, chunk, chunkAad(k.teamId, '0'.repeat(32), 1, 3))));
ok('chunk with another team key does not open', throws(() => openChunk(ko.encKey, chunk, caad)));
const bent = chunk.slice();
bent[100] ^= 1;
ok('altered chunk does not open', throws(() => openChunk(k.encKey, bent, caad)));

if (failed) {
  console.error(`check:team-crypto — ${failed} failed`);
  process.exit(1);
}
console.log('✓ team-crypto: derivation, seal/open, tamper and move detection, keyed names, invitations, file chunks');
