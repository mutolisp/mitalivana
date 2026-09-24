/**
 * Sign in with ORCID — who the provenance signature is attributed to.
 *
 * Replaces typing the iD in. A typed iD proved only that someone knew a
 * number; this proves the person at the keyboard controls that ORCID account,
 * which is the claim a signed export makes.
 *
 * Flow (verified against ORCID's own docs, not recalled):
 *   - OpenID Connect **implicit** flow, `response_type=token` + `scope=openid`
 *     — ORCID's recommendation for apps with no back end: no client secret
 *     is involved, and only `/authenticate` / `openid` scopes are granted, so
 *     the token cannot edit the record. Tokens live 10 minutes; nothing is
 *     stored but the iD and name.
 *     (info.orcid.org API tutorial "Get an authenticated ORCID iD";
 *     ORCID-Source orcid-web/ORCID_AUTH_WITH_OPENID_CONNECT.md)
 *   - The result comes back in the redirect's `#fragment`: `access_token` and
 *     an `id_token` JWT whose `sub` is the iD, with `name` and the `nonce`
 *     echoed back.
 *   - Production redirect URIs must be HTTPS and registered on the client.
 *     The app never loads that page: the WebView intercepts the navigation to
 *     it and reads the fragment off the URL.
 *
 * Trust: the id_token's RS256 signature is NOT checked here (no RSA in the
 * app). Instead, after the claims check (aud, iss, nonce, exp), the access
 * token is sent to ORCID's userinfo endpoint over TLS, and the `sub` ORCID
 * answers with must match. ORCID itself vouches for whose token it is.
 *
 * Client: a **Public API** client registered by an individual in their own
 * ORCID Developer Tools — no ORCID membership needed (that is the Member API,
 * which writes to records; this only reads who signed in). Free for
 * non-commercial use. The base URL is configurable so the same code runs
 * against sandbox.orcid.org while testing.
 *
 * Pure except `confirmWithOrcid` (network): the rest runs under Node
 * (`npm run check:orcidauth`).
 */
import { normalizeOrcid } from './signing';

/** Production base. Issuer and endpoints follow it — per
 *  https://orcid.org/.well-known/openid-configuration (checked 2026-09-24):
 *  issuer = base, `/oauth/authorize`, `/oauth/userinfo`. */
export const ORCID_PRODUCTION = 'https://orcid.org';

export type OrcidAuthRequest = {
  /** `https://orcid.org`, or `https://sandbox.orcid.org` while testing. */
  base: string;
  clientId: string;
  redirectUri: string;
  /** Random, single-use; must come back inside the id_token. */
  nonce: string;
  /** Random, single-use; must come back in the fragment. */
  state: string;
};

export function buildAuthorizeUrl(req: OrcidAuthRequest): string {
  const q = new URLSearchParams({
    client_id: req.clientId,
    response_type: 'token',
    scope: 'openid',
    redirect_uri: req.redirectUri,
    nonce: req.nonce,
    state: req.state,
  });
  return `${req.base}/oauth/authorize?${q.toString()}`;
}

/** Whether a navigation is the redirect back to us (so the WebView must stop
 *  and hand the URL over instead of loading it). */
export function isRedirect(url: string, redirectUri: string): boolean {
  return url === redirectUri || url.startsWith(`${redirectUri}#`) || url.startsWith(`${redirectUri}?`);
}

export type OrcidIdentity = { orcid: string; name: string; accessToken: string };

export type RedirectResult =
  | { ok: true; identity: OrcidIdentity }
  | { ok: false; reason: 'denied' | 'invalid' };

function base64UrlDecode(s: string): string {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
  const bin = atob(padded);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder('utf-8').decode(bytes);
}

/** The id_token payload, or null when it is not a well-formed JWT. */
export function decodeIdToken(jwt: string): Record<string, unknown> | null {
  const parts = jwt.split('.');
  if (parts.length !== 3) return null;
  try {
    const payload = JSON.parse(base64UrlDecode(parts[1])) as unknown;
    return payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * Read and check the redirect URL. Everything a forged or replayed redirect
 * could get wrong is checked: state, then the id_token's audience, issuer,
 * nonce and expiry, then that `sub` is a real ORCID iD (check digit).
 */
export function parseRedirect(
  url: string,
  req: OrcidAuthRequest,
  nowMs: number,
): RedirectResult {
  const hashAt = url.indexOf('#');
  const queryAt = url.indexOf('?');
  // Errors come back in the query (`?error=access_denied`), success in the
  // fragment.
  const query = new URLSearchParams(queryAt >= 0 ? url.slice(queryAt + 1, hashAt >= 0 ? hashAt : undefined) : '');
  const frag = new URLSearchParams(hashAt >= 0 ? url.slice(hashAt + 1) : '');
  if (query.get('error') || frag.get('error')) {
    const e = query.get('error') ?? frag.get('error');
    return { ok: false, reason: e === 'access_denied' ? 'denied' : 'invalid' };
  }
  if (frag.get('state') !== req.state) return { ok: false, reason: 'invalid' };
  const accessToken = frag.get('access_token');
  const idToken = frag.get('id_token');
  if (!accessToken || !idToken) return { ok: false, reason: 'invalid' };

  const claims = decodeIdToken(idToken);
  if (!claims) return { ok: false, reason: 'invalid' };
  const aud = claims.aud;
  const audOk = Array.isArray(aud) ? aud.includes(req.clientId) : aud === req.clientId;
  if (!audOk) return { ok: false, reason: 'invalid' };
  if (claims.iss !== req.base) return { ok: false, reason: 'invalid' };
  if (claims.nonce !== req.nonce) return { ok: false, reason: 'invalid' };
  if (typeof claims.exp !== 'number' || claims.exp * 1000 <= nowMs) {
    return { ok: false, reason: 'invalid' };
  }
  const orcid = typeof claims.sub === 'string' ? normalizeOrcid(claims.sub) : null;
  if (!orcid) return { ok: false, reason: 'invalid' };

  const given = typeof claims.given_name === 'string' ? claims.given_name : '';
  const family = typeof claims.family_name === 'string' ? claims.family_name : '';
  const name =
    (typeof claims.name === 'string' && claims.name.trim()) || `${given} ${family}`.trim();
  return { ok: true, identity: { orcid, name, accessToken } };
}

/**
 * Ask ORCID whose token this is. Resolves true only when ORCID answers with
 * the same iD the id_token named — the check that stands in for verifying the
 * id_token signature on the device.
 */
export async function confirmWithOrcid(base: string, identity: OrcidIdentity): Promise<boolean> {
  const res = await fetch(`${base}/oauth/userinfo`, {
    headers: { Authorization: `Bearer ${identity.accessToken}`, Accept: 'application/json' },
  });
  if (!res.ok) return false;
  const body = (await res.json()) as { sub?: unknown };
  return typeof body.sub === 'string' && normalizeOrcid(body.sub) === identity.orcid;
}
