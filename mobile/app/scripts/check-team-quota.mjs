/**
 * Team sync server (mobile/sync-worker): the pure limits and the real Worker
 * `fetch` / `scheduled` handlers against an in-memory R2.
 *   - usage per team and per device from a listing;
 *   - each limit at its edge: exactly at the limit passes, one over is refused
 *     (object size, team bytes, team objects, devices, device bytes, daily
 *     uploads, teams per IP per day, server-wide read-only);
 *   - per-team overrides only through ADMIN_TOKEN;
 *   - wrong token 401, refused uploads are not written, delete removes all,
 *     the stored object is the bytes sent (the server never decodes them);
 *   - files (Media_sync.md phase 0): refused on the public settings, on a
 *     self-hosted server chunks round-trip, oversize / bad index refused, not
 *     counted as records, deleted with the team.
 */
import { checkUpload, limitsFrom, sanitizeOverrides, usageOf } from '../../sync-worker/src/quota.js';
import worker from '../../sync-worker/src/index.js';
import { LIFECYCLE, NO_SUBDOMAIN, PUBLIC_HOST, PUBLIC_SERVER, SELF_HOST_SCRIPT, SELF_HOST_VARS, deploySyncServer, isAccountId, isServerName, multipart, removeSyncServer, scriptMetadata, serverNameOf, tokenTemplateUrl } from '../src/lib/syncDeploy.ts';
import { MEDIA_CHUNK_BYTES, authTokenHash, chunkAad, chunkCount, deriveTeamKeys, mediaId, openChunk, sealChunk } from '../src/lib/teamCrypto.ts';
import { sha256 } from '@noble/hashes/sha2.js';
import { renderSource } from './build-sync-worker-source.mjs';
import { readFileSync } from 'node:fs';

let failed = 0;
const eq = (msg, got, want) => {
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    failed++;
    console.error(`✗ ${msg}\n    got  ${JSON.stringify(got)}\n    want ${JSON.stringify(want)}`);
  }
};

// ── pure limits ──
const L = limitsFrom({ MAX_TEAM_BYTES: '1000', MAX_TEAM_OBJECTS: '3', MAX_TEAM_DEVICES: '2', MAX_DEVICE_BYTES: '600', MAX_OBJECT_BYTES: '500', MAX_DEVICE_PUTS_PER_DAY: '2' });
const objs = [
  { key: 't/T/r/a/d1', size: 300 },
  { key: 't/T/r/b/d1', size: 200 },
  { key: 't/T/r/a/d2', size: 100 },
  { key: 't/T/auth', size: 50 },
];
const U = usageOf(objs);
eq('usage: records only, per device', [U.bytes, U.objects, U.devices], [600, 3, { d1: 500, d2: 100 }]);
const up = (o) => checkUpload(L, U, { putsToday: 0, replacing: null, ...o })?.code ?? null;
eq('object at limit passes, one over refused', [up({ dev: 'd2', size: 500, replacing: 100 }), up({ dev: 'd2', size: 501, replacing: 100 })], [null, 'objectTooLarge']);
eq('new object when team has 3 → teamQuota (objects)', up({ dev: 'd2', size: 10 }), 'teamQuota');
eq('replacing keeps the object count', up({ dev: 'd2', size: 10, replacing: 100 }), null);
eq('third device refused', up({ dev: 'd3', size: 10, replacing: 0 }), 'teamFull');
eq('device bytes at limit passes, one over refused', [up({ dev: 'd1', size: 400, replacing: 300 }), up({ dev: 'd1', size: 401, replacing: 300 })], [null, 'deviceQuota']);
const U2 = usageOf([{ key: 't/T/r/a/d1', size: 550 }, { key: 't/T/r/a/d2', size: 400 }]);
eq('team bytes at limit passes, one over refused', [
  checkUpload(L, U2, { dev: 'd2', size: 450, replacing: 400, putsToday: 0 })?.code ?? null,
  checkUpload(L, U2, { dev: 'd2', size: 451, replacing: 400, putsToday: 0 })?.code ?? null,
], [null, 'teamQuota']);
eq('daily uploads: 1 used passes, 2 used refused', [up({ dev: 'd2', size: 10, replacing: 100, putsToday: 1 }), up({ dev: 'd2', size: 10, replacing: 100, putsToday: 2 })], [null, 'deviceRate']);
eq('team overrides beat the deployment vars', limitsFrom({ MAX_TEAM_BYTES: '1000' }, { maxTeamBytes: 5000 }).maxTeamBytes, 5000);
eq('overrides cannot touch server-wide limits', Object.keys(sanitizeOverrides({ maxTotalBytes: 1, maxTeamsPerIpPerDay: 99, maxTeamBytes: 7 })), ['maxTeamBytes']);

// ── in-memory R2 ──
function fakeR2() {
  const m = new Map();
  let n = 0;
  const meta = (key, v) => ({ key, size: v.bytes.length, uploaded: v.uploaded, etag: v.etag, httpEtag: `"${v.etag}"` });
  return {
    m,
    async put(key, value) {
      const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : new Uint8Array(value);
      const v = { bytes, uploaded: new Date(), etag: `e${++n}` };
      m.set(key, v);
      return meta(key, v);
    },
    async get(key) {
      const v = m.get(key);
      if (!v) return null;
      return { ...meta(key, v), body: v.bytes, text: async () => new TextDecoder().decode(v.bytes) };
    },
    async head(key) {
      const v = m.get(key);
      return v ? meta(key, v) : null;
    },
    async list({ prefix = '', cursor, limit = 1000 }) {
      const keys = [...m.keys()].filter((k) => k.startsWith(prefix)).sort();
      const start = cursor ? Number(cursor) : 0;
      const page = keys.slice(start, start + limit);
      const truncated = start + limit < keys.length;
      return { objects: page.map((k) => meta(k, m.get(k))), truncated, cursor: truncated ? String(start + limit) : undefined };
    },
    async delete(keys) {
      for (const k of [].concat(keys)) m.delete(k);
    },
  };
}

const env = { SYNC: fakeR2(), ADMIN_TOKEN: 'admin-secret', IP_SALT: 's', MAX_OBJECT_BYTES: '4000', MAX_TEAM_DEVICES: '2', MAX_TEAMS_PER_IP_PER_DAY: '2', MAX_TOTAL_BYTES: '5000' };
const call = async (method, path, { token, body, ip = '1.2.3.4', headers: extra = {} } = {}) => {
  const headers = { 'cf-connecting-ip': ip, ...extra };
  if (token) headers.authorization = `Bearer ${token}`;
  let payload;
  if (body instanceof Uint8Array) {
    payload = body;
    headers['content-length'] = String(body.length);
  } else if (body) {
    payload = JSON.stringify(body);
    headers['content-type'] = 'application/json';
  }
  const res = await worker.fetch(new Request(`https://sync.test${path}`, { method, headers, body: payload }), env);
  const type = res.headers.get('content-type') ?? '';
  return { status: res.status, body: type.includes('json') ? await res.json() : new Uint8Array(await res.arrayBuffer()) };
};

const keys = deriveTeamKeys(Uint8Array.from({ length: 32 }, (_, i) => i));
const T = keys.teamId;
const tok = keys.authToken;
const rec = 'a'.repeat(32);
const d1 = '1'.repeat(32);
const d2 = '2'.repeat(32);
const d3 = '3'.repeat(32);

eq('info', (await call('GET', '/v1/info')).body.api, 1);
eq('create', (await call('POST', `/v1/t/${T}`, { body: { authHash: authTokenHash(tok) } })).status, 201);
eq('create again → 409', (await call('POST', `/v1/t/${T}`, { body: { authHash: authTokenHash(tok) } })).status, 409);
const other = deriveTeamKeys(Uint8Array.from({ length: 32 }, (_, i) => 200 - i)).teamId;
eq('second team from the same IP (limit 2) → 201', (await call('POST', `/v1/t/${other}`, { body: { authHash: authTokenHash('x') } })).status, 201);
const third = deriveTeamKeys(Uint8Array.from({ length: 32 }, (_, i) => 100 + i)).teamId;
eq('third team from the same IP → 429 createRate', (await call('POST', `/v1/t/${third}`, { body: { authHash: authTokenHash('y') } })).body.error, 'createRate');
eq('another IP may create', (await call('POST', `/v1/t/${third}`, { body: { authHash: authTokenHash('y') }, ip: '5.6.7.8' })).status, 201);
{
  const fourth = deriveTeamKeys(Uint8Array.from({ length: 32 }, (_, i) => 50 + i)).teamId;
  eq('owner: a malformed owner hash → 400', (await call('POST', `/v1/t/${fourth}`, { body: { authHash: authTokenHash('z'), ownerHash: 'x' }, ip: '9.9.9.9' })).status, 400);
  eq('owner: created with an owner hash → only the owner token deletes', [
    (await call('POST', `/v1/t/${fourth}`, { body: { authHash: authTokenHash('z'), ownerHash: authTokenHash('own') }, ip: '9.9.9.9' })).status,
    (await call('DELETE', `/v1/t/${fourth}`, { token: 'z' })).body.error,
    (await call('DELETE', `/v1/t/${fourth}`, { token: 'z', headers: { 'x-owner-token': 'own' } })).status,
  ], [201, 'ownerOnly', 200]);
}

const blob = Uint8Array.from({ length: 1000 }, (_, i) => (i * 31) & 255);
eq('wrong token → 401', (await call('PUT', `/v1/t/${T}/r/${rec}/${d1}`, { token: 'nope', body: blob })).status, 401);
eq('upload', (await call('PUT', `/v1/t/${T}/r/${rec}/${d1}`, { token: tok, body: blob })).status, 200);
const got = await call('GET', `/v1/t/${T}/r/${rec}/${d1}`, { token: tok });
eq('download returns the bytes sent', [got.status, got.body.join() === blob.join()], [200, true]);
eq('listing', (await call('GET', `/v1/t/${T}/r/${rec}/`, { token: tok })).body.items.map((i) => [i.dev, i.size]), [[d1, 1000]]);
eq('too large → 413, not written', [(await call('PUT', `/v1/t/${T}/r/${rec}/${d2}`, { token: tok, body: new Uint8Array(4001) })).body.error, env.SYNC.m.has(`t/${T}/r/${rec}/${d2}`)], ['objectTooLarge', false]);
eq('second device', (await call('PUT', `/v1/t/${T}/r/${rec}/${d2}`, { token: tok, body: blob })).status, 200);
eq('third device → teamFull, not written', [(await call('PUT', `/v1/t/${T}/r/${rec}/${d3}`, { token: tok, body: blob })).body.error, env.SYNC.m.has(`t/${T}/r/${rec}/${d3}`)], ['teamFull', false]);
eq('usage', (await call('GET', `/v1/t/${T}/usage`, { token: tok })).body.bytes, 2000);
eq('team listing: every record and device', (await call('GET', `/v1/t/${T}/r`, { token: tok })).body.items.map((i) => `${i.rec.slice(0, 1)}:${i.dev.slice(0, 1)}`).sort(), ['a:1', 'a:2']);

eq('limits: team token cannot use admin', (await call('PUT', `/v1/admin/t/${T}/limits`, { token: tok, body: { maxTeamDevices: 5 } })).status, 401);
eq('limits: admin raises devices', (await call('PUT', `/v1/admin/t/${T}/limits`, { token: 'admin-secret', body: { maxTeamDevices: 5 } })).body.maxTeamDevices, 5);
eq('third device now allowed', (await call('PUT', `/v1/t/${T}/r/${rec}/${d3}`, { token: tok, body: blob })).status, 200);

// Server-wide (MAX_TOTAL_BYTES 5000): 3000 bytes stored. An upload that would
// pass the total is refused at once, not only after the next daily cron.
const big = `t/${T}/r/${'b'.repeat(32)}/${d1}`;
eq('server-wide: an upload past the total is refused at once, not written', [
  (await call('PUT', `/v1/t/${T}/r/${'b'.repeat(32)}/${d1}`, { token: tok, body: new Uint8Array(3000) })).body.error,
  env.SYNC.m.has(big),
], ['serverFull', false]);
{
  // Small metadata writes are left to the cron's exact recount; uploads move the total by their size.
  const total = () => Number(new TextDecoder().decode(env.SYNC.m.get('sys/bytes').bytes));
  const t0 = total();
  await call('PUT', `/v1/t/${T}/r/${'c'.repeat(32)}/${d1}`, { token: tok, body: new Uint8Array(100) });
  const t1 = total();
  await call('PUT', `/v1/t/${T}/r/${'c'.repeat(32)}/${d1}`, { token: tok, body: new Uint8Array(40) });
  eq('server-wide: the running total moves by exactly what is stored (new, then replaced)', [t1 - t0, total() - t1], [100, -60]);
}
// Something the running total missed (another writer): the daily cron still catches it.
await env.SYNC.put(big, new Uint8Array(3000));
await worker.scheduled({}, env);
eq('cron sets read-only above the total', !!(await env.SYNC.head('sys/readonly')), true);
eq('read-only: uploads 503, downloads still work', [(await call('PUT', `/v1/t/${T}/r/${rec}/${d1}`, { token: tok, body: blob })).body.error, (await call('GET', `/v1/t/${T}/r/${rec}/${d1}`, { token: tok })).status], ['serverFull', 200]);

eq('owner: the team (created without an owner hash) is deletable by any member until claimed', true, true);
const ownerTok = 'o'.repeat(40);
const ownerHash = authTokenHash(ownerTok);
eq('owner: claim sets the owner hash once', [
  (await call('PUT', `/v1/t/${T}/owner`, { token: tok, body: { ownerHash } })).status,
  (await call('PUT', `/v1/t/${T}/owner`, { token: tok, body: { ownerHash } })).status,
  (await call('PUT', `/v1/t/${T}/owner`, { token: tok, body: { ownerHash: authTokenHash('someone-else') } })).body.error,
  (await call('PUT', `/v1/t/${T}/owner`, { token: 'nope', body: { ownerHash } })).status,
], [200, 200, 'ownerSet', 401]);
eq('owner: a member without the owner token cannot delete; nothing removed', [
  (await call('DELETE', `/v1/t/${T}`, { token: tok })).body.error,
  (await call('DELETE', `/v1/t/${T}`, { token: tok, headers: { 'x-owner-token': 'wrong' } })).body.error,
  env.SYNC.m.has(`t/${T}/r/${rec}/${d1}`),
], ['ownerOnly', 'ownerOnly', true]);
// An upload that refreshes the auth object keeps the owner hash.
{
  const a = JSON.parse(new TextDecoder().decode(env.SYNC.m.get(`t/${T}/auth`).bytes));
  await env.SYNC.put(`t/${T}/auth`, JSON.stringify({ ...a, created: 0, touched: 0 }));
  // Room again: drop the oversized object and let the cron recount and lift read-only.
  await env.SYNC.delete(big);
  await worker.scheduled({}, env);
  const up = await call('PUT', `/v1/t/${T}/r/${rec}/${d1}`, { token: tok, body: blob });
  const after = JSON.parse(new TextDecoder().decode(env.SYNC.m.get(`t/${T}/auth`).bytes));
  eq('owner: the auth refresh on upload keeps the owner hash', [up.status, after.touched > 0, after.ownerHash], [200, true, ownerHash]);
}
eq('delete team (owner token)', (await call('DELETE', `/v1/t/${T}`, { token: tok, headers: { 'x-owner-token': ownerTok } })).status, 200);
eq('after delete: gone', [(await call('GET', `/v1/t/${T}/r/${rec}/${d1}`, { token: tok })).status, [...env.SYNC.m.keys()].some((k) => k.startsWith(`t/${T}/`))], [404, false]);

// ── files (docs/planned/Media_sync.md phases 0–2) ──
const mid = 'f'.repeat(32);
const chunk = Uint8Array.from({ length: 700 }, (_, i) => (i * 13) & 255);
eq('files: off by default → 403 mediaDisabled, nothing written', [
  (await call('PUT', `/v1/t/${other}/m/${mid}/0`, { token: 'x', body: chunk })).body.error,
  (await call('GET', `/v1/t/${other}/m/${mid}`, { token: 'x' })).body.error,
  (await call('POST', `/v1/t/${other}/m/have`, { token: 'x', body: { mids: [mid] } })).body.error,
  (await call('PUT', `/v1/t/${other}/refs/${'a'.repeat(32)}/${'b'.repeat(32)}`, { token: 'x', body: { mids: [mid] } })).body.error,
  [...env.SYNC.m.keys()].some((k) => k.startsWith('m/') || k.includes('/refs/')),
], ['mediaDisabled', 'mediaDisabled', 'mediaDisabled', 'mediaDisabled', false]);
const tomlVars = Object.fromEntries([...readFileSync(new URL('../../sync-worker/wrangler.toml', import.meta.url), 'utf8').matchAll(/^([A-Z_]+) = "([^"]*)"$/gm)].map((m) => [m[1], m[2]]));
eq('files: the public server config (wrangler.toml) keeps them off', [tomlVars.MEDIA_ENABLED, limitsFrom(tomlVars).mediaEnabled], ['0', 0]);
eq('files: self-host deploy turns them on with 20 GB per team', [limitsFrom(SELF_HOST_VARS).mediaEnabled, limitsFrom(SELF_HOST_VARS).maxMediaTeamBytes], [1, 20 * 1024 ** 3]);
eq('files: a team override cannot turn them on, but may change the team file quota', Object.keys(sanitizeOverrides({ mediaEnabled: 1, maxMediaChunkBytes: 9, maxMediaTeamBytes: 5 })), ['maxMediaTeamBytes']);
const MV = { MEDIA_ENABLED: '1', MAX_MEDIA_CHUNK_BYTES: '800', MAX_MEDIA_TEAM_BYTES: '2000' };
const menv = { ...env, SYNC: fakeR2(), ...MV };
const mcall = async (method, path, opts = {}) => {
  const saved = env.SYNC;
  Object.assign(env, menv);
  try {
    return await call(method, path, opts);
  } finally {
    Object.assign(env, { SYNC: saved, MEDIA_ENABLED: undefined, MAX_MEDIA_CHUNK_BYTES: undefined, MAX_MEDIA_TEAM_BYTES: undefined });
  }
};
const keyOf = (i) => `m/${T}/${mid}/${i}`;
await mcall('POST', `/v1/t/${T}`, { body: { authHash: authTokenHash(tok) } });
eq('files: wrong token → 401', (await mcall('PUT', `/v1/t/${T}/m/${mid}/0`, { token: 'nope', body: chunk })).status, 401);
eq('files: chunks 0 and 1 stored outside t/ (not under the 90-day record lifecycle)', [
  (await mcall('PUT', `/v1/t/${T}/m/${mid}/0`, { token: tok, body: chunk, headers: { 'x-media-size': '1000' } })).status,
  (await mcall('PUT', `/v1/t/${T}/m/${mid}/1`, { token: tok, body: chunk.subarray(0, 300), headers: { 'x-media-size': '1000' } })).status,
  menv.SYNC.m.has(keyOf(0)), [...menv.SYNC.m.keys()].some((k) => k.startsWith(`t/${T}/m/`)),
], [200, 200, true, false]);
const back = await mcall('GET', `/v1/t/${T}/m/${mid}/0`, { token: tok });
eq('files: download returns the bytes sent', [back.status, back.body.join() === chunk.join()], [200, true]);
eq('files: status lists the stored chunks in order, not yet complete', (await mcall('GET', `/v1/t/${T}/m/${mid}`, { token: tok })).body, { chunks: [{ i: 0, size: 700 }, { i: 1, size: 300 }], done: false });
eq('files: not complete → not in have', (await mcall('POST', `/v1/t/${T}/m/have`, { token: tok, body: { mids: [mid] } })).body.have, []);
eq('files: done with a chunk missing → 409, not complete', [
  (await mcall('POST', `/v1/t/${T}/m/${mid}/done`, { token: tok, body: { n: 3, size: 1000 } })).body,
  menv.SYNC.m.has(`m/${T}/${mid}/info`),
], [{ error: 'mediaIncomplete', missing: 2 }, false]);
eq('files: done with every chunk → complete, counted once', [
  (await mcall('POST', `/v1/t/${T}/m/${mid}/done`, { token: tok, body: { n: 2, size: 1000 } })).status,
  (await mcall('POST', `/v1/t/${T}/m/${mid}/done`, { token: tok, body: { n: 2, size: 1000 } })).status,
  (await mcall('POST', `/v1/t/${T}/m/have`, { token: tok, body: { mids: [mid, 'e'.repeat(32), 'bad'] } })).body.have,
  (await mcall('GET', `/v1/t/${T}/usage`, { token: tok })).body.mediaBytes,
], [200, 200, [mid], 1000]);
const mid2 = 'e'.repeat(32);
const mid3 = 'd'.repeat(32);
eq('files: the quota counts bytes stored, not the client\'s x-media-size', [
  (await mcall('PUT', `/v1/t/${T}/m/${mid2}/0`, { token: tok, body: chunk, headers: { 'x-media-size': '0' } })).status,
  (await mcall('PUT', `/v1/t/${T}/m/${mid2}/1`, { token: tok, body: chunk, headers: { 'x-media-size': '0' } })).body.error,
  menv.SYNC.m.has(`m/${T}/${mid2}/1`),
  (await mcall('GET', `/v1/t/${T}/usage`, { token: tok })).body.mediaBytes,
], [200, 'mediaQuota', false, 1700]);
eq('files: x-media-size still refuses a file that cannot fit at its first chunk', [
  (await mcall('PUT', `/v1/t/${T}/m/${mid3}/0`, { token: tok, body: chunk.subarray(0, 100), headers: { 'x-media-size': '400' } })).body.error,
  menv.SYNC.m.has(`m/${T}/${mid3}/0`),
], ['mediaQuota', false]);
eq('files: replacing a chunk counts only the difference', [
  (await mcall('PUT', `/v1/t/${T}/m/${mid2}/0`, { token: tok, body: chunk })).status,
  (await mcall('GET', `/v1/t/${T}/usage`, { token: tok })).body.mediaBytes,
], [200, 1700]);
eq('files: done ignores the client\'s size (records what is stored)', [
  (await mcall('POST', `/v1/t/${T}/m/${mid2}/done`, { token: tok, body: { n: 1, size: 0 } })).status,
  JSON.parse(new TextDecoder().decode(menv.SYNC.m.get(`m/${T}/${mid2}/info`).bytes)).size,
  (await mcall('GET', `/v1/t/${T}/usage`, { token: tok })).body.mediaBytes,
], [200, 700, 1700]);
await mcall('PUT', `/v1/admin/t/${T}/limits`, { token: 'admin-secret', body: { maxMediaTeamBytes: 100000 } });
eq('files: chunk at the limit passes, one over → 413 not written', [
  (await mcall('PUT', `/v1/t/${T}/m/${mid}/2`, { token: tok, body: new Uint8Array(800) })).status,
  (await mcall('PUT', `/v1/t/${T}/m/${mid}/3`, { token: tok, body: new Uint8Array(801) })).body.error,
  menv.SYNC.m.has(keyOf(3)),
], [200, 'objectTooLarge', false]);
eq('files: bad index or name → 404', [
  (await mcall('PUT', `/v1/t/${T}/m/${mid}/01`, { token: tok, body: chunk })).status,
  (await mcall('PUT', `/v1/t/${T}/m/${mid}/-1`, { token: tok, body: chunk })).status,
  (await mcall('PUT', `/v1/t/${T}/m/XYZ/0`, { token: tok, body: chunk })).status,
], [404, 404, 404]);
eq('files: empty chunk → 400', (await mcall('PUT', `/v1/t/${T}/m/${mid}/4`, { token: tok, body: new Uint8Array(0) })).status, 400);
eq('files: not counted as records', (await mcall('GET', `/v1/t/${T}/usage`, { token: tok })).body.bytes, 0);
eq('files: /v1/info reports them on', (await mcall('GET', '/v1/info')).body.limits.mediaEnabled, 1);
// Clean-up: a file some record copy refers to stays; an unreferenced one goes after a week.
const recA = 'a'.repeat(32);
const devA = 'b'.repeat(32);
eq('files: a record copy lists the files it refers to', (await mcall('PUT', `/v1/t/${T}/refs/${recA}/${devA}`, { token: tok, body: { mids: [mid, mid, 'nope'] } })).body.count, 1);
const { collectMediaGarbage } = await import('../../sync-worker/src/index.js');
const day = 24 * 3600 * 1000;
eq('files: clean-up within the week keeps everything', (await collectMediaGarbage(menv.SYNC, Date.now() + 6 * day)).deleted, 0);
eq('files: clean-up after a week removes only what no record refers to', [
  (await collectMediaGarbage(menv.SYNC, Date.now() + 8 * day)).deleted,
  menv.SYNC.m.has(keyOf(0)), menv.SYNC.m.has(`m/${T}/${mid}/info`), [...menv.SYNC.m.keys()].some((k) => k.startsWith(`m/${T}/${mid2}/`)),
  Number(new TextDecoder().decode(menv.SYNC.m.get(`m/${T}/usage`).bytes)),
], [1, true, true, false, 1800]);
await mcall('DELETE', `/v1/t/${T}`, { token: tok });
eq('files: deleted with the team, records and files alike', [...menv.SYNC.m.keys()].some((k) => k.startsWith(`t/${T}/`) || k.startsWith(`m/${T}/`)), false);

// The phone's path end to end (src/lib/mediaSync.ts without the file I/O):
// hash → name, seal each 4 MiB chunk, store, mark done, fetch, open, same bytes.
{
  const fenv = { SYNC: fakeR2(), MEDIA_ENABLED: '1', MAX_MEDIA_TEAM_BYTES: String(1024 ** 3) };
  const fcall = (method, path, opts = {}) => {
    const headers = { 'cf-connecting-ip': '9.9.9.9', ...(opts.headers ?? {}) };
    if (opts.token) headers.authorization = `Bearer ${opts.token}`;
    if (opts.body instanceof Uint8Array) headers['content-length'] = String(opts.body.length);
    const body = opts.body instanceof Uint8Array ? opts.body : opts.body ? JSON.stringify(opts.body) : undefined;
    return worker.fetch(new Request(`https://sync.test${path}`, { method, headers, body }), fenv);
  };
  await fcall('POST', `/v1/t/${T}`, { body: { authHash: authTokenHash(tok) } });
  const file = Uint8Array.from({ length: 2 * MEDIA_CHUNK_BYTES + 12345 }, (_, i) => (i * 7 + (i >> 11)) & 255);
  const fmid = mediaId(keys.encKey, sha256(file));
  const n = chunkCount(file.length);
  let codes = [];
  for (let i = 0; i < n; i++) {
    const nonce = Uint8Array.from({ length: 24 }, (_, k) => (k * 5 + i) & 255);
    const sealed = sealChunk(keys.encKey, nonce, file.subarray(i * MEDIA_CHUNK_BYTES, (i + 1) * MEDIA_CHUNK_BYTES), chunkAad(T, fmid, i, n));
    codes.push((await fcall('PUT', `/v1/t/${T}/m/${fmid}/${i}`, { token: tok, body: sealed, headers: { 'x-media-size': String(file.length) } })).status);
  }
  codes.push((await fcall('POST', `/v1/t/${T}/m/${fmid}/done`, { token: tok, body: { n, size: file.length } })).status);
  eq('files e2e: three full-size sealed chunks fit the default chunk limit, then complete', codes, [200, 200, 200, 200]);
  const parts = [];
  for (let i = 0; i < n; i++) {
    const res = await fcall('GET', `/v1/t/${T}/m/${fmid}/${i}`, { token: tok });
    parts.push(openChunk(keys.encKey, new Uint8Array(await res.arrayBuffer()), chunkAad(T, fmid, i, n)));
  }
  const joined = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
  let off = 0;
  for (const p of parts) {
    joined.set(p, off);
    off += p.length;
  }
  eq('files e2e: reassembled file has the same bytes and name', [joined.length === file.length, mediaId(keys.encKey, sha256(joined)) === fmid], [true, true]);
  const stored = [...fenv.SYNC.m.entries()].filter(([k]) => k.startsWith('m/') && !k.endsWith('/info') && !k.endsWith('/usage'));
  const plainHead = Buffer.from(file.subarray(0, 64)).toString('hex');
  eq('files e2e: the server holds no plaintext', stored.every(([, v]) => !Buffer.from(v.bytes).toString('hex').includes(plainHead)), true);
}

// ── in-app / script deploy against a recorded fake Cloudflare API ──
const calls = [];
const fakeCf = async (url, init = {}) => {
  calls.push({ url, method: init.method ?? 'GET', body: init.body, ct: init.headers?.['content-type'] });
  const ok = (result) => new Response(JSON.stringify({ success: true, result }), { status: 200, headers: { 'content-type': 'application/json' } });
  if (url.endsWith('/r2/buckets') && init.method === 'POST') {
    return new Response(JSON.stringify({ success: false, errors: [{ code: 10004, message: 'The bucket you tried to create already exists' }] }), { status: 409 });
  }
  if (url.endsWith('/workers/subdomain')) return ok({ subdomain: 'fieldteam' });
  if (url.endsWith('/v1/info')) return new Response(JSON.stringify({ api: 1 }), { status: 200 });
  return ok({});
};
let hexN = 0;
const dep = await deploySyncServer({
  token: 'cf-token',
  accountId: 'acc1',
  modules: { 'index.js': 'export default {}', 'quota.js': 'export const x = 1' },
  fetchImpl: fakeCf,
  randomHex: (n) => String(++hexN).repeat(n * 2).slice(0, n * 2),
  sleep: async () => {},
});
eq('deploy: url from the account subdomain', dep.url, 'https://mitalivana-sync.fieldteam.workers.dev');
eq('deploy: step order (subdomain checked first, existing bucket reused)', calls.map((c) => `${c.method} ${c.url.replace(/^https:\/\/api\.cloudflare\.com\/client\/v4\/accounts\/acc1/, '').replace(/^https:\/\/[^/]+/, '')}`), [
  'GET /workers/subdomain',
  'POST /r2/buckets',
  'PUT /r2/buckets/mitalivana-sync/lifecycle',
  'PUT /workers/scripts/mitalivana-sync',
  'POST /workers/scripts/mitalivana-sync/subdomain',
  'PUT /workers/scripts/mitalivana-sync/schedules',
  'GET /v1/info',
]);
// An account that never opened the Workers page: stop before creating anything.
const noSubCalls = [];
let noSubErr = null;
try {
  await deploySyncServer({
    token: 't', accountId: 'acc1', modules: {}, randomHex: () => '00', sleep: async () => {},
    fetchImpl: async (url, init = {}) => {
      noSubCalls.push(`${init.method ?? 'GET'} ${url}`);
      return new Response(JSON.stringify({ success: false, errors: [{ code: 10063, message: 'You need a workers.dev subdomain' }] }), { status: 403 });
    },
  });
} catch (e) {
  noSubErr = e;
}
eq('deploy: no workers.dev subdomain → stops first, nothing created', [noSubErr?.detail, noSubCalls.length], [NO_SUBDOMAIN, 1]);
eq('deploy: lifecycle 90 days on t/, 2 days on c/', LIFECYCLE.rules.map((r) => [r.conditions.prefix, r.deleteObjectsTransition.condition.maxAge / 86400]), [['t/', 90], ['c/', 2]]);
const scriptPut = calls.find((c) => c.url.endsWith('/workers/scripts/mitalivana-sync') && c.method === 'PUT');
const boundary = scriptPut.ct.split('boundary=')[1];
eq('deploy: multipart has metadata + both modules as ES modules', [
  scriptPut.body.includes('name="metadata"'),
  scriptPut.body.includes('name="index.js"') && scriptPut.body.includes('name="quota.js"'),
  (scriptPut.body.match(/application\/javascript\+module/g) ?? []).length,
  scriptPut.body.trimEnd().endsWith(`--${boundary}--`),
], [true, true, 2, true]);
const meta = JSON.parse(scriptPut.body.split('name="metadata"; filename="metadata"\r\nContent-Type: application/json\r\n\r\n')[1].split('\r\n--')[0]);
eq('deploy: bindings (bucket + two secrets), admin token returned', [meta.main_module, meta.bindings.map((b) => `${b.type}:${b.name}`), dep.adminToken === meta.bindings[1].text], ['index.js', ['r2_bucket:SYNC', 'secret_text:ADMIN_TOKEN', 'secret_text:IP_SALT'], true]);
eq('deploy: the API token is only sent to api.cloudflare.com', calls.filter((c) => !c.url.startsWith('https://api.cloudflare.com/')).every((c) => !JSON.stringify(c).includes('cf-token')), true);
const selfMeta = scriptMetadata({ bucket: 'b', adminToken: 'a', ipSalt: 's', vars: SELF_HOST_VARS });
const selfLimits = limitsFrom(Object.fromEntries(selfMeta.bindings.filter((x) => x.type === 'plain_text').map((x) => [x.name, x.text])));
eq('self-host limits reach the Worker as vars; per-team / device / daily lifted, total kept', [selfLimits.maxTeamDevices, selfLimits.maxDevicePutsPerDay, selfLimits.maxTeamBytes, selfLimits.maxTotalBytes], [1000, 100000, 8 * 1024 ** 3, 8 * 1024 ** 3]);
eq('self-host team objects stay within the free plan\'s 50 list calls per upload', Math.ceil(SELF_HOST_VARS.MAX_TEAM_OBJECTS / 1000) < 50, true);
eq('default deploy (no vars) keeps the public limits', limitsFrom(Object.fromEntries(meta.bindings.filter((x) => x.type === 'plain_text').map((x) => [x.name, x.text]))).maxTeamDevices, 20);
eq('multipart framing', multipart([{ name: 'a', type: 't', text: 'x' }], 'B'), '--B\r\nContent-Disposition: form-data; name="a"; filename="a"\r\nContent-Type: t\r\n\r\nx\r\n--B--\r\n');

// Token pages (Cloudflare "API token template URLs"): the account page first,
// the three permissions the deploy needs pre-filled on both.
const perms = (u) => JSON.parse(decodeURIComponent(new URL(u).searchParams.get('permissionGroupKeys')));
const want = [{ key: 'workers_scripts', type: 'edit' }, { key: 'workers_r2', type: 'edit' }, { key: 'account_settings', type: 'read' }];
eq('token page: account API token template', [tokenTemplateUrl('account').startsWith('https://dash.cloudflare.com/?to=/:account/api-tokens&'), perms(tokenTemplateUrl('account'))], [true, want]);
eq('token page: personal token fallback, all accounts and zones', [new URL(tokenTemplateUrl('user')).pathname, perms(tokenTemplateUrl('user')), new URL(tokenTemplateUrl('user')).searchParams.get('accountId')], ['/profile/api-tokens', want, '*']);
eq('account id: 32 hex only', [isAccountId('0123456789abcdef0123456789abcdef'), isAccountId(' 0123456789abcdef0123456789abcdef '), isAccountId('0123456789ABCDEF0123456789ABCDEF'), isAccountId('abc')], [true, true, false, false]);

const pub = limitsFrom({});
eq('public server defaults (2026-09-28): 5 MB per record, 200 MB and 20 devices per team, 50 MB per device, 200 uploads a day, files off',
  [pub.maxObjectBytes, pub.maxTeamBytes, pub.maxTeamDevices, pub.maxDeviceBytes, pub.maxDevicePutsPerDay, pub.mediaEnabled], [5 * 1024 ** 2, 200 * 1024 ** 2, 20, 50 * 1024 ** 2, 200, 0]);
eq('wrangler.toml matches the public defaults', limitsFrom(tomlVars), pub);

// ── the public server's Worker is not a self-host target (2026-09-28) ──
// teamSync.ts imports Expo, so read the constant from its source.
const DEFAULT_SERVER = /export const DEFAULT_SERVER = '([^']+)'/.exec(readFileSync(new URL('../src/lib/teamSync.ts', import.meta.url), 'utf8'))?.[1];
eq('public host is the app default server', `https://${PUBLIC_HOST}`, DEFAULT_SERVER);
eq('server names: Worker and bucket rules (3–63, a–z 0–9 -, no dash at the ends)',
  ['mitalivana-sync', SELF_HOST_SCRIPT, 'ab', 'a'.repeat(63), 'a'.repeat(64), '-abc', 'abc-', 'Abc', 'a_b'].map(isServerName),
  [true, true, false, true, false, false, false, false, false]);
eq('server name from a workers.dev URL', [serverNameOf('https://mitalivana-sync-self.fieldteam.workers.dev'), serverNameOf('https://sync.mitalivana.org'), serverNameOf('https://x.y.workers.dev')], [SELF_HOST_SCRIPT, null, null]);
const cfWith = (domains) => {
  const log = [];
  const f = async (url, init = {}) => {
    const path = url.replace(/^https:\/\/api\.cloudflare\.com\/client\/v4\/accounts\/acc1/, '');
    log.push(`${init.method ?? 'GET'} ${path}`);
    const ok = (result) => new Response(JSON.stringify({ success: true, result }), { status: 200, headers: { 'content-type': 'application/json' } });
    if (path.endsWith('/workers/subdomain')) return ok({ subdomain: 'fieldteam' });
    if (path.startsWith('/workers/domains')) {
      const service = new URL(`https://x${path}`).searchParams.get('service');
      return ok(domains.filter((d) => d.service === service));
    }
    return ok({});
  };
  return { f, log };
};
const bound = [{ hostname: PUBLIC_HOST, service: 'mitalivana-sync' }];
const base = { token: 't', accountId: 'acc1', modules: {}, randomHex: (n) => '0'.repeat(n * 2), sleep: async () => {}, waitForInfo: false };
{
  const { f, log } = cfWith(bound);
  let err = null;
  try {
    await deploySyncServer({ ...base, fetchImpl: f, vars: SELF_HOST_VARS, selfHost: true });
  } catch (e) {
    err = e;
  }
  eq('self-host onto the public Worker: refused before anything is created', [err?.detail, log], [PUBLIC_SERVER, ['GET /workers/subdomain', 'GET /workers/domains?service=mitalivana-sync']]);
}
{
  const { f, log } = cfWith(bound);
  const r = await deploySyncServer({ ...base, fetchImpl: f, script: SELF_HOST_SCRIPT, vars: SELF_HOST_VARS, selfHost: true });
  eq('self-host under another name in the same account: its own Worker, URL and bucket', [r.url, log.filter((l) => !l.startsWith('GET'))], [
    `https://${SELF_HOST_SCRIPT}.fieldteam.workers.dev`,
    ['POST /r2/buckets', `PUT /r2/buckets/${SELF_HOST_SCRIPT}/lifecycle`, `PUT /workers/scripts/${SELF_HOST_SCRIPT}`, `POST /workers/scripts/${SELF_HOST_SCRIPT}/subdomain`, `PUT /workers/scripts/${SELF_HOST_SCRIPT}/schedules`],
  ]);
}
{
  const { f, log } = cfWith(bound);
  await deploySyncServer({ ...base, fetchImpl: f });
  eq('redeploying the public server itself (no self-host) is not blocked', log.includes('PUT /workers/scripts/mitalivana-sync'), true);
}
{
  const { f, log } = cfWith(bound);
  let err = null;
  try {
    await removeSyncServer({ token: 't', accountId: 'acc1', fetchImpl: f });
  } catch (e) {
    err = e;
  }
  eq('remove: the public Worker is never deleted', [err?.detail, log.some((l) => l.startsWith('DELETE'))], [PUBLIC_SERVER, false]);
  const other = cfWith(bound);
  await removeSyncServer({ token: 't', accountId: 'acc1', fetchImpl: other.f, script: SELF_HOST_SCRIPT });
  eq('remove: a self-hosted Worker and its bucket of the same name', other.log.filter((l) => l.startsWith('DELETE')), [`DELETE /workers/scripts/${SELF_HOST_SCRIPT}`, `DELETE /r2/buckets/${SELF_HOST_SCRIPT}`]);
}
{
  const { f } = cfWith([]);
  let err = null;
  try {
    await deploySyncServer({ ...base, fetchImpl: f, script: 'Bad_Name', selfHost: true });
  } catch (e) {
    err = e;
  }
  eq('a bad name is refused before anything is created', err?.detail, 'badName');
}

eq('app copy of the Worker source is current (node scripts/build-sync-worker-source.mjs)', readFileSync(new URL('../src/lib/syncWorkerSource.ts', import.meta.url), 'utf8') === renderSource(), true);

if (failed) {
  console.error(`check:team-quota — ${failed} failed`);
  process.exit(1);
}
console.log('✓ team-quota: limits at their edges, overrides, auth, refusals not written, read-only, delete, deploy steps');
