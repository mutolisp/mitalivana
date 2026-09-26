/**
 * The one HTTP entry point. Both external clients (iNaturalist, GBIF) go
 * through it so failure has a single vocabulary.
 *
 * Why a timeout at all: React Native's fetch has none, and this app is used in
 * the field where a request does not fail so much as never answer. A survey
 * screen that spins forever is worse than one that says it could not connect.
 */

export type ApiErrorKind =
  /** fetch() itself failed — offline, DNS, TLS. */
  | 'network'
  /** No answer within the timeout. Common on a weak mobile signal. */
  | 'timeout'
  /** Reached the server, got a non-2xx. */
  | 'http'
  /** HTTP 429: we are asking too fast. Its own kind because the remedy is to
   *  wait, not to retry harder or to tell the user the service is broken. */
  | 'rate_limit'
  /** 2xx with a body we could not read. */
  | 'parse'
  /** The caller aborted. */
  | 'aborted';

/**
 * Which external service a request belongs to.
 *
 * A named type, not a literal union repeated at every signature: adding a
 * member used to mean finding every spelling by hand, and `connectivity.ts`
 * picks its cross-probe target from an exhaustive map keyed on this, so a new
 * member that nobody routed is a compile error rather than a silent fallback.
 */
export type ApiService = 'inat' | 'gbif' | 'gdrive' | 'sync' | 'cloudflare';

export class ApiError extends Error {
  kind: ApiErrorKind;
  status?: number;
  /**
   * The server's own explanation, when it sent one.
   *
   * Worth carrying because GBIF's 400s are specific and actionable — "Too few
   * distinct points in geometry component", "Self-intersection at or near
   * point (121.55, 25.175)" — and a bare "HTTP 400" throws that away, leaving
   * the user with nothing to act on.
   */
  detail?: string;
  /** Which service produced it, for the cross-probe in `connectivity.ts`. */
  service: ApiService;

  constructor(
    service: ApiService,
    kind: ApiErrorKind,
    message: string,
    status?: number,
    detail?: string,
  ) {
    super(message);
    this.name = 'ApiError';
    this.service = service;
    this.kind = kind;
    this.status = status;
    this.detail = detail;
  }
}

/** Cap on the error body we keep — enough for a sentence, not a stack trace. */
const MAX_DETAIL = 300;

/** Both services ask API consumers to identify themselves. */
export const USER_AGENT = 'Checklister-NG/1.0 (Taiwan species checklist; mutolisp@gmail.com)';

export const DEFAULT_TIMEOUT_MS = 20000;

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** How long to wait out a 429 when the server does not say. */
const RATE_LIMIT_WAIT_MS = 2500;
/** Never sit on a Retry-After longer than this; tell the user instead. */
const MAX_RATE_LIMIT_WAIT_MS = 10000;
const MAX_RATE_LIMIT_RETRIES = 2;

/** 429 → how long to wait before the one bounded retry, or null to give up
 *  now (no Retry-After we are willing to sit through). */
function rateLimitWaitMs(res: Response, attempt: number): number | null {
  const after = Number(res.headers.get('retry-after'));
  const waitMs = Number.isFinite(after) && after > 0 ? after * 1000 : RATE_LIMIT_WAIT_MS;
  return attempt < MAX_RATE_LIMIT_RETRIES && waitMs <= MAX_RATE_LIMIT_WAIT_MS ? waitMs : null;
}

export async function getJson(
  service: ApiService,
  url: string,
  signal?: AbortSignal,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
  attempt = 0,
  /** Extra request headers — an `Authorization` JWT for iNaturalist's
   *  authenticated GETs. Merged over the defaults. */
  extraHeaders?: Record<string, string>,
): Promise<Record<string, unknown>> {
  // A timeout and a caller cancellation are different outcomes, so they get
  // their own flag rather than being read back off one shared signal.
  const ctrl = new AbortController();
  let timedOut = false;
  const onAbort = () => ctrl.abort();
  signal?.addEventListener('abort', onAbort);
  const timer = setTimeout(() => {
    timedOut = true;
    ctrl.abort();
  }, timeoutMs);

  try {
    let res: Response;
    try {
      res = await fetch(url, {
        headers: { Accept: 'application/json', 'User-Agent': USER_AGENT, ...extraHeaders },
        signal: ctrl.signal,
      });
    } catch (e) {
      if (timedOut) throw new ApiError(service, 'timeout', `timed out after ${timeoutMs} ms`);
      if (signal?.aborted) throw new ApiError(service, 'aborted', 'aborted');
      throw new ApiError(service, 'network', String((e as Error)?.message ?? e));
    }
    if (!res.ok) {
      let detail: string | undefined;
      try {
        detail = (await res.text()).trim().slice(0, MAX_DETAIL) || undefined;
      } catch {
        // Body unreadable; the status alone still has to be reported.
      }
      if (res.status === 429) {
        // Measured, not assumed: GBIF answers a burst of faceted queries with
        // `Too many API requests have been detected from your client`. Retrying
        // after a wait is the documented remedy, so one bounded retry happens
        // here rather than surfacing a failure the user cannot act on.
        const waitMs = rateLimitWaitMs(res, attempt);
        if (waitMs !== null) {
          await sleep(waitMs);
          if (signal?.aborted) throw new ApiError(service, 'aborted', 'aborted');
          return getJson(service, url, signal, timeoutMs, attempt + 1, extraHeaders);
        }
        throw new ApiError(service, 'rate_limit', `HTTP 429`, 429, detail);
      }
      throw new ApiError(service, 'http', `HTTP ${res.status}`, res.status, detail);
    }
    try {
      return (await res.json()) as Record<string, unknown>;
    } catch (e) {
      throw new ApiError(service, 'parse', String((e as Error)?.message ?? e));
    }
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

/**
 * JSON-in, JSON-out POST — the write-side twin of `getJson`, with the same
 * timeout / abort / error vocabulary and the same single bounded 429 retry.
 * Only fetch, so this file stays loadable under plain Node (check:gbif).
 */
export async function postJson(
  service: ApiService,
  url: string,
  body: unknown,
  opts: { headers?: Record<string, string>; signal?: AbortSignal; timeoutMs?: number } = {},
  attempt = 0,
): Promise<Record<string, unknown>> {
  return sendBody(
    service,
    'POST',
    url,
    body === undefined ? undefined : JSON.stringify(body),
    'application/json',
    opts,
    attempt,
  );
}

/**
 * Form-encoded POST — what OAuth 2.0 token endpoints take.
 *
 * Google's device-flow endpoints are specified as
 * `application/x-www-form-urlencoded`; they are not documented to accept JSON,
 * so they get their own entry point rather than a JSON body that happens to
 * work today. Same timeout / abort / error vocabulary as the rest.
 */
export async function postForm(
  service: ApiService,
  url: string,
  params: Record<string, string>,
  opts: { headers?: Record<string, string>; signal?: AbortSignal; timeoutMs?: number } = {},
  attempt = 0,
): Promise<Record<string, unknown>> {
  return sendBody(service, 'POST', url, qs(params), 'application/x-www-form-urlencoded', opts, attempt);
}

/** Same as `postJson` for the other JSON verbs (PUT / DELETE). `body` may be
 *  undefined for a DELETE. */
export async function sendJson(
  service: ApiService,
  method: 'POST' | 'PUT' | 'DELETE',
  url: string,
  body: unknown,
  opts: { headers?: Record<string, string>; signal?: AbortSignal; timeoutMs?: number } = {},
  attempt = 0,
): Promise<Record<string, unknown>> {
  return sendBody(
    service,
    method,
    url,
    body === undefined ? undefined : JSON.stringify(body),
    'application/json',
    opts,
    attempt,
  );
}

/** The shared write path. `body` is already encoded; `contentType` describes it. */
async function sendBody(
  service: ApiService,
  method: 'POST' | 'PUT' | 'DELETE',
  url: string,
  body: string | undefined,
  contentType: string,
  opts: { headers?: Record<string, string>; signal?: AbortSignal; timeoutMs?: number } = {},
  attempt = 0,
): Promise<Record<string, unknown>> {
  const { headers, signal, timeoutMs = DEFAULT_TIMEOUT_MS } = opts;
  const ctrl = new AbortController();
  let timedOut = false;
  const onAbort = () => ctrl.abort();
  signal?.addEventListener('abort', onAbort);
  const timer = setTimeout(() => {
    timedOut = true;
    ctrl.abort();
  }, timeoutMs);

  try {
    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers: {
          Accept: 'application/json',
          'Content-Type': contentType,
          'User-Agent': USER_AGENT,
          ...headers,
        },
        body,
        signal: ctrl.signal,
      });
    } catch (e) {
      if (timedOut) throw new ApiError(service, 'timeout', `timed out after ${timeoutMs} ms`);
      if (signal?.aborted) throw new ApiError(service, 'aborted', 'aborted');
      throw new ApiError(service, 'network', String((e as Error)?.message ?? e));
    }
    if (!res.ok) {
      let detail: string | undefined;
      try {
        detail = (await res.text()).trim().slice(0, MAX_DETAIL) || undefined;
      } catch {
        // Body unreadable; the status alone still has to be reported.
      }
      if (res.status === 429) {
        const waitMs = rateLimitWaitMs(res, attempt);
        if (waitMs !== null) {
          await sleep(waitMs);
          if (signal?.aborted) throw new ApiError(service, 'aborted', 'aborted');
          return sendBody(service, method, url, body, contentType, opts, attempt + 1);
        }
        throw new ApiError(service, 'rate_limit', `HTTP 429`, 429, detail);
      }
      throw new ApiError(service, 'http', `HTTP ${res.status}`, res.status, detail);
    }
    try {
      const text = await res.text();
      return (text ? JSON.parse(text) : {}) as Record<string, unknown>;
    } catch (e) {
      throw new ApiError(service, 'parse', String((e as Error)?.message ?? e));
    }
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

/**
 * A request with a text body and a text answer, for the team-sync relay
 * (sealed records travel as base64url text: React Native's fetch is reliable
 * with strings, less so with binary bodies). Same timeout / abort / error
 * vocabulary; a non-2xx keeps the server's body in `detail` (the relay sends
 * `{"error": code}`). No 429 retry: the relay's 429 means a daily limit.
 */
export async function fetchText(
  service: ApiService,
  method: 'GET' | 'PUT' | 'POST' | 'DELETE',
  url: string,
  opts: { headers?: Record<string, string>; body?: string; contentType?: string; signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<{ status: number; text: string; etag: string | null }> {
  const { headers, body, contentType = 'text/plain', signal, timeoutMs = DEFAULT_TIMEOUT_MS } = opts;
  const ctrl = new AbortController();
  let timedOut = false;
  const onAbort = () => ctrl.abort();
  signal?.addEventListener('abort', onAbort);
  const timer = setTimeout(() => {
    timedOut = true;
    ctrl.abort();
  }, timeoutMs);
  try {
    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers: { 'User-Agent': USER_AGENT, ...(body !== undefined ? { 'Content-Type': contentType } : {}), ...headers },
        body,
        signal: ctrl.signal,
      });
    } catch (e) {
      if (timedOut) throw new ApiError(service, 'timeout', `timed out after ${timeoutMs} ms`);
      if (signal?.aborted) throw new ApiError(service, 'aborted', 'aborted');
      throw new ApiError(service, 'network', String((e as Error)?.message ?? e));
    }
    let text = '';
    try {
      text = await res.text();
    } catch (e) {
      if (res.ok) throw new ApiError(service, 'parse', String((e as Error)?.message ?? e));
    }
    if (!res.ok) {
      const kind = res.status === 429 ? 'rate_limit' : 'http';
      throw new ApiError(service, kind, `HTTP ${res.status}`, res.status, text.trim().slice(0, MAX_DETAIL) || undefined);
    }
    return { status: res.status, text, etag: res.headers.get('etag') };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

/**
 * Reachability only: is this host answering?
 *
 * A HEAD request, because the body is irrelevant and the alternative is not
 * free — iNaturalist's smallest GET returns ~64 KB, which is a poor thing to
 * spend a field user's mobile data on just to find out whether there is a
 * connection. Both APIs were verified to answer HEAD with 200 and 0 bytes.
 */
export async function probe(
  service: ApiService,
  url: string,
  signal?: AbortSignal,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<void> {
  const ctrl = new AbortController();
  let timedOut = false;
  const onAbort = () => ctrl.abort();
  signal?.addEventListener('abort', onAbort);
  const timer = setTimeout(() => {
    timedOut = true;
    ctrl.abort();
  }, timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'HEAD',
      headers: { 'User-Agent': USER_AGENT },
      signal: ctrl.signal,
    });
    if (!res.ok) throw new ApiError(service, 'http', `HTTP ${res.status}`, res.status);
  } catch (e) {
    if (e instanceof ApiError) throw e;
    if (timedOut) throw new ApiError(service, 'timeout', 'probe timed out');
    throw new ApiError(service, 'network', String((e as Error)?.message ?? e));
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

/**
 * Build a query string.
 *
 * Deliberately NOT `URLSearchParams`, even though React Native polyfills it as
 * a global: its constructor has no copy branch, so `new URLSearchParams(other)`
 * falls through to the plain-object case and `Object.entries()` on the instance
 * yields its private field — the whole thing collapses to
 * `_searchParams=[object Map]` and every parameter is silently dropped. A
 * bounding-box query that quietly loses its bounding box is the worst possible
 * failure here, so this does the encoding itself.
 */
export function qs(params: Record<string, string>): string {
  return Object.entries(params)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
}

