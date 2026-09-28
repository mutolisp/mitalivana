/**
 * Deploy the sync relay to someone's own Cloudflare account through the
 * Cloudflare REST API — no wrangler, no computer needed. Used by the app's
 * 「用我自己的 Cloudflare」 and by mobile/sync-worker/scripts/deploy.mjs; both
 * upload the same two module files (the Worker source lives in
 * mobile/sync-worker/src, embedded here by scripts/build-sync-worker-source.mjs).
 * Pure: no RN or Expo imports, so Node runs it too.
 *
 * Endpoints (checked against developers.cloudflare.com/api, 2026-09-26):
 *   GET  /accounts
 *   POST /accounts/{id}/r2/buckets                          {name}
 *   PUT  /accounts/{id}/r2/buckets/{bucket}/lifecycle       {rules:[…]}
 *   PUT  /accounts/{id}/workers/scripts/{script}            multipart: metadata + modules
 *   POST /accounts/{id}/workers/scripts/{script}/subdomain  {enabled:true}
 *   PUT  /accounts/{id}/workers/scripts/{script}/schedules  [{cron}]
 *   GET  /accounts/{id}/workers/subdomain                   → result.subdomain (checked first)
 *
 * The API token is used for these calls only; nothing here stores it.
 * `fetchImpl` and `randomHex` come from the caller (the app has its own
 * timeouts and CSPRNG), so this module has no platform dependencies.
 */

export const API = 'https://api.cloudflare.com/client/v4';
export const DEFAULT_SCRIPT = 'mitalivana-sync';
/**
 * The public server: Worker `mitalivana-sync` with the custom domain below.
 * A self-hosted deploy in the same Cloudflare account must not reuse that
 * Worker (a workers.dev URL is the same Worker, same limits, same bucket) —
 * on 2026-09-28 an in-app self-host did, and the public server ran with the
 * self-host limits. Such an account self-hosts as SELF_HOST_SCRIPT instead.
 */
export const PUBLIC_HOST = 'sync.mitalivana.org';
export const SELF_HOST_SCRIPT = 'mitalivana-sync-self';
/** `DeployError.detail` when the Worker serves the public server. */
export const PUBLIC_SERVER = 'publicServer';

/**
 * A name usable as both the Worker and its bucket: Worker names on workers.dev
 * are at most 63 characters, alphanumeric and dashes, no dash at either end;
 * R2 bucket names are 3–63 lowercase letters, digits and dashes, no dash at
 * either end (Cloudflare docs, checked 2026-09-28).
 */
export function isServerName(name: string): boolean {
  return /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(name);
}

/** The Worker name of a deployment from its workers.dev URL (`https://{name}.{sub}.workers.dev`). */
export function serverNameOf(url: string): string | null {
  const m = /^https:\/\/([a-z0-9-]+)\.[a-z0-9-]+\.workers\.dev\/?$/.exec(url.trim());
  return m && isServerName(m[1]) ? m[1] : null;
}
export const COMPATIBILITY_DATE = '2026-09-01';
export const DAILY_CRON = '17 3 * * *';

/**
 * Limits for a server someone deploys for their own teams. The shared default
 * server keeps the strict defaults (src/quota.js) because it is open to
 * anyone; on your own account the only real bound is your own bill, so the
 * per-team, per-device and daily limits are effectively lifted.
 *
 * Two stay: the server-wide total (8 GB keeps R2 within its free 10 GB) and a
 * team-object cap of 5,000. Every upload lists the team's objects to count
 * usage, 1,000 per call; the Workers free plan allows 50 subrequests per
 * request (whether R2 binding calls count toward it is not documented where we
 * looked), so 5,000 objects — five list calls — stays far below it either way.
 */
export const SELF_HOST_VARS: Record<string, number> = {
  MAX_OBJECT_BYTES: 10 * 1024 * 1024,
  MAX_TEAM_BYTES: 8 * 1024 * 1024 * 1024,
  MAX_TEAM_OBJECTS: 5000,
  MAX_TEAM_DEVICES: 1000,
  MAX_DEVICE_BYTES: 8 * 1024 * 1024 * 1024,
  MAX_DEVICE_PUTS_PER_DAY: 100000,
  MAX_TEAMS_PER_IP_PER_DAY: 1000,
  MAX_TOTAL_BYTES: 8 * 1024 * 1024 * 1024,
  // Files sync on the deployer's own server only (docs/planned/Media_sync.md);
  // 20 GB of files per team to start with, adjustable per team by the deployer.
  MEDIA_ENABLED: 1,
  MAX_MEDIA_TEAM_BYTES: 20 * 1024 * 1024 * 1024,
};

const DAY = 24 * 3600;
export const LIFECYCLE = {
  rules: [
    { id: 'team-data-90d', enabled: true, conditions: { prefix: 't/' }, deleteObjectsTransition: { condition: { type: 'Age', maxAge: 90 * DAY } } },
    { id: 'counters-2d', enabled: true, conditions: { prefix: 'c/' }, deleteObjectsTransition: { condition: { type: 'Age', maxAge: 2 * DAY } } },
  ],
};

export class DeployError extends Error {
  step: string;
  status: number;
  detail: string | undefined;
  constructor(step: string, status: number, detail?: string) {
    super(`${step}: ${status}${detail ? ` ${detail}` : ''}`);
    this.step = step;
    this.status = status;
    this.detail = detail;
  }
}

type FetchLike = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<Response>;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function cf(fetchImpl: FetchLike, token: string, step: string, method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<any> {
  const res = await fetchImpl(`${API}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(typeof body === 'string' ? {} : { 'content-type': 'application/json' }), ...headers },
    body: body == null ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
  let data: { success?: boolean; result?: unknown; errors?: Array<{ code: number; message: string }> } | null = null;
  try {
    data = await res.json();
  } catch {
    // non-JSON error page
  }
  if (!res.ok || data?.success === false) {
    const msg = data?.errors?.map((e) => `${e.code} ${e.message}`).join('; ');
    throw new DeployError(step, res.status, msg);
  }
  return data?.result;
}

/**
 * The token the deploy needs, as Cloudflare's token template URLs pre-fill it
 * (developers.cloudflare.com/fundamentals/api/how-to/account-owned-token-template,
 * checked 2026-09-28): permission keys `workers_scripts`, `workers_r2`,
 * `account_settings`. An account API token belongs to the account, not to a
 * person, which Cloudflare recommends for integrations; its page needs an
 * Administrator. The user-token page stays as the fallback.
 */
export const TOKEN_PERMISSIONS = [
  { key: 'workers_scripts', type: 'edit' },
  { key: 'workers_r2', type: 'edit' },
  { key: 'account_settings', type: 'read' },
] as const;
const TOKEN_NAME = 'Mitalivana sync';

export function tokenTemplateUrl(kind: 'account' | 'user'): string {
  const perms = encodeURIComponent(JSON.stringify(TOKEN_PERMISSIONS));
  const name = encodeURIComponent(TOKEN_NAME);
  return kind === 'account'
    ? `https://dash.cloudflare.com/?to=/:account/api-tokens&permissionGroupKeys=${perms}&name=${name}`
    : `https://dash.cloudflare.com/profile/api-tokens?permissionGroupKeys=${perms}&accountId=*&zoneId=all&name=${name}`;
}

export const isAccountId = (s: string) => /^[0-9a-f]{32}$/.test(s.trim());

export type CfAccount = { id: string; name: string };

export async function listAccounts({ token, fetchImpl }: { token: string; fetchImpl: FetchLike }): Promise<CfAccount[]> {
  const result = (await cf(fetchImpl, token, 'accounts', 'GET', '/accounts?per_page=50')) as CfAccount[] | null;
  return (result ?? []).map((a) => ({ id: a.id, name: a.name }));
}

/** Text-only multipart body: every part here is text, so no Blob is needed. */
export function multipart(parts: Array<{ name: string; type: string; text: string }>, boundary: string): string {
  let out = '';
  for (const p of parts) {
    out += `--${boundary}\r\nContent-Disposition: form-data; name="${p.name}"; filename="${p.name}"\r\nContent-Type: ${p.type}\r\n\r\n${p.text}\r\n`;
  }
  return `${out}--${boundary}--\r\n`;
}

/** The script upload's metadata: modules, the bucket, secrets and limit vars. */
export function scriptMetadata({
  bucket,
  adminToken,
  ipSalt,
  vars = {},
}: {
  bucket: string;
  adminToken: string;
  ipSalt: string;
  vars?: Record<string, string | number>;
}) {
  return {
    main_module: 'index.js',
    compatibility_date: COMPATIBILITY_DATE,
    bindings: [
      { type: 'r2_bucket', name: 'SYNC', bucket_name: bucket },
      { type: 'secret_text', name: 'ADMIN_TOKEN', text: adminToken },
      { type: 'secret_text', name: 'IP_SALT', text: ipSalt },
      ...Object.entries(vars).map(([name, text]) => ({ type: 'plain_text', name, text: String(text) })),
    ],
  };
}

/**
 * Steps, in order; `onStep(id)` before each. A bucket that already exists is
 * reused (re-running updates the Worker in place). Returns the Worker URL and
 * the new admin token (the caller keeps it; it is not recoverable).
 */
export type DeployStep = 'url' | 'guard' | 'bucket' | 'lifecycle' | 'script' | 'subdomain' | 'schedule' | 'check';

/** `DeployError.detail` when the account has no workers.dev subdomain yet. */
export const NO_SUBDOMAIN = 'noSubdomain';

/**
 * Refuses when the Worker `script` in this account serves the public server's
 * domain (List Worker Domains, GET /accounts/{id}/workers/domains?service=…;
 * needs Workers Scripts Read or Write, which the deploy token has).
 */
export async function guardPublicServer(fetchImpl: FetchLike, token: string, accountId: string, script: string, step = 'guard'): Promise<void> {
  const domains = (await cf(fetchImpl, token, step, 'GET', `/accounts/${accountId}/workers/domains?service=${encodeURIComponent(script)}`)) as
    | Array<{ hostname?: string; service?: string }>
    | null;
  if ((domains ?? []).some((d) => d.hostname === PUBLIC_HOST && (d.service == null || d.service === script))) {
    throw new DeployError(step, 0, PUBLIC_SERVER);
  }
}

export async function deploySyncServer({
  token,
  accountId,
  modules,
  fetchImpl,
  randomHex,
  script = DEFAULT_SCRIPT,
  bucket = script,
  vars = {},
  selfHost = false,
  onStep = () => {},
  waitForInfo = true,
  sleep = (ms: number) => new Promise((r) => setTimeout(r, ms)),
}: {
  token: string;
  accountId: string;
  modules: Record<string, string>;
  fetchImpl: FetchLike;
  /** `n` random bytes as hex, from a CSPRNG. */
  randomHex: (n: number) => string;
  /** Worker name; the bucket takes the same name unless given. */
  script?: string;
  bucket?: string;
  vars?: Record<string, string | number>;
  /** A deployer's own server: refuses to overwrite the public server's Worker. */
  selfHost?: boolean;
  onStep?: (step: DeployStep) => void;
  waitForInfo?: boolean;
  sleep?: (ms: number) => Promise<unknown>;
}): Promise<{ url: string; adminToken: string }> {
  const acct = `/accounts/${accountId}`;
  // First, before anything is created: an account that never opened the
  // Workers page has no workers.dev subdomain, and Cloudflare refuses the
  // later steps (10063). Its name is the account's permanent *.workers.dev
  // name, so it is the user's to pick in the dashboard, not ours to invent.
  onStep('url');
  const sub = (await cf(fetchImpl, token, 'url', 'GET', `${acct}/workers/subdomain`).catch((e) => {
    if (e instanceof DeployError && /10063|10007|not found/i.test(`${e.detail ?? ''}`)) return null;
    throw e;
  })) as { subdomain?: string } | null;
  if (!sub?.subdomain) throw new DeployError('url', 0, NO_SUBDOMAIN);
  if (!isServerName(script) || !isServerName(bucket)) throw new DeployError('url', 0, 'badName');
  const url = `https://${script}.${sub.subdomain}.workers.dev`;

  // Still before anything is created.
  if (selfHost) {
    onStep('guard');
    await guardPublicServer(fetchImpl, token, accountId, script);
  }

  onStep('bucket');
  try {
    await cf(fetchImpl, token, 'bucket', 'POST', `${acct}/r2/buckets`, { name: bucket });
  } catch (e) {
    // 409 / "already exists": keep going with the existing bucket.
    if (!(e instanceof DeployError) || !(e.status === 409 || /exist/i.test(e.detail ?? ''))) throw e;
  }
  onStep('lifecycle');
  await cf(fetchImpl, token, 'lifecycle', 'PUT', `${acct}/r2/buckets/${bucket}/lifecycle`, LIFECYCLE);

  onStep('script');
  const adminToken = randomHex(32);
  const boundary = `mitalivana${randomHex(12)}`;
  const body = multipart(
    [
      { name: 'metadata', type: 'application/json', text: JSON.stringify(scriptMetadata({ bucket, adminToken, ipSalt: randomHex(16), vars })) },
      ...Object.entries(modules).map(([name, text]) => ({ name, type: 'application/javascript+module', text })),
    ],
    boundary,
  );
  await cf(fetchImpl, token, 'script', 'PUT', `${acct}/workers/scripts/${script}`, body, {
    'content-type': `multipart/form-data; boundary=${boundary}`,
  });

  onStep('subdomain');
  await cf(fetchImpl, token, 'subdomain', 'POST', `${acct}/workers/scripts/${script}/subdomain`, { enabled: true });
  onStep('schedule');
  await cf(fetchImpl, token, 'schedule', 'PUT', `${acct}/workers/scripts/${script}/schedules`, [{ cron: DAILY_CRON }]);

  if (waitForInfo) {
    onStep('check');
    // A new workers.dev route takes a moment to answer.
    let lastErr: unknown = null;
    for (let i = 0; i < 10; i++) {
      try {
        const r = await fetchImpl(`${url}/v1/info`);
        if (r.ok && (await r.json())?.api) return { url, adminToken };
      } catch (e) {
        lastErr = e;
      }
      await sleep(3000);
    }
    throw new DeployError('check', 0, lastErr ? String(lastErr) : 'the Worker did not answer');
  }
  return { url, adminToken };
}

/** Remove a self-hosted deployment: the Worker, then every object and the bucket. Never the public server's. */
export async function removeSyncServer({
  token,
  accountId,
  fetchImpl,
  script = DEFAULT_SCRIPT,
  bucket = script,
}: {
  token: string;
  accountId: string;
  fetchImpl: FetchLike;
  script?: string;
  bucket?: string;
}): Promise<{ bucketDeleted: boolean }> {
  const acct = `/accounts/${accountId}`;
  await guardPublicServer(fetchImpl, token, accountId, script, 'script');
  await cf(fetchImpl, token, 'script', 'DELETE', `${acct}/workers/scripts/${script}`);
  // A bucket must be empty to delete; the Worker is gone, so the objects are
  // left to lifecycle (at most 90 days) when deleting the bucket is refused.
  try {
    await cf(fetchImpl, token, 'bucket', 'DELETE', `${acct}/r2/buckets/${bucket}`);
    return { bucketDeleted: true };
  } catch {
    return { bucketDeleted: false };
  }
}
