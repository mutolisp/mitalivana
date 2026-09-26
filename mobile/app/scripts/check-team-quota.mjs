/**
 * Team sync server (mobile/sync-worker): the pure limits and the real Worker
 * `fetch` / `scheduled` handlers against an in-memory R2.
 *   - usage per team and per device from a listing;
 *   - each limit at its edge: exactly at the limit passes, one over is refused
 *     (object size, team bytes, team objects, devices, device bytes, daily
 *     uploads, teams per IP per day, server-wide read-only);
 *   - per-team overrides only through ADMIN_TOKEN;
 *   - wrong token 401, refused uploads are not written, delete removes all,
 *     the stored object is the bytes sent (the server never decodes them).
 */
import { checkUpload, limitsFrom, sanitizeOverrides, usageOf } from '../../sync-worker/src/quota.js';
import worker from '../../sync-worker/src/index.js';
import { LIFECYCLE, NO_SUBDOMAIN, SELF_HOST_VARS, deploySyncServer, multipart, scriptMetadata } from '../src/lib/syncDeploy.ts';
import { authTokenHash, deriveTeamKeys } from '../src/lib/teamCrypto.ts';
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
const call = async (method, path, { token, body, ip = '1.2.3.4' } = {}) => {
  const headers = { 'cf-connecting-ip': ip };
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

// Server-wide: 3000 bytes stored > MAX_TOTAL_BYTES 5000? no → still writable; push over, run cron.
await call('PUT', `/v1/t/${T}/r/${'b'.repeat(32)}/${d1}`, { token: tok, body: new Uint8Array(3000) });
await worker.scheduled({}, env);
eq('cron sets read-only above the total', !!(await env.SYNC.head('sys/readonly')), true);
eq('read-only: uploads 503, downloads still work', [(await call('PUT', `/v1/t/${T}/r/${rec}/${d1}`, { token: tok, body: blob })).body.error, (await call('GET', `/v1/t/${T}/r/${rec}/${d1}`, { token: tok })).status], ['serverFull', 200]);

eq('delete team', (await call('DELETE', `/v1/t/${T}`, { token: tok })).status, 200);
eq('after delete: gone', [(await call('GET', `/v1/t/${T}/r/${rec}/${d1}`, { token: tok })).status, [...env.SYNC.m.keys()].some((k) => k.startsWith(`t/${T}/`))], [404, false]);

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

eq('app copy of the Worker source is current (node scripts/build-sync-worker-source.mjs)', readFileSync(new URL('../src/lib/syncWorkerSource.ts', import.meta.url), 'utf8') === renderSource(), true);

if (failed) {
  console.error(`check:team-quota — ${failed} failed`);
  process.exit(1);
}
console.log('✓ team-quota: limits at their edges, overrides, auth, refusals not written, read-only, delete, deploy steps');
