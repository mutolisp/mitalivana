#!/usr/bin/env node
/**
 * Sign in with ORCID: the redirect checks in src/lib/orcidAuth.ts.
 *
 * The id_token's signature is not verified on the device (see the module
 * header), so these claim checks plus ORCID's userinfo answer are the whole
 * defence. Every rejection is pinned: a forged, replayed, expired or
 * someone-else's redirect must not become a signing identity.
 *
 * Run: npm run check:orcidauth
 */
import {
  buildAuthorizeUrl,
  decodeIdToken,
  isRedirect,
  parseRedirect,
} from '../src/lib/orcidAuth.ts';

let failures = 0;
const eq = (label, got, want) => {
  const a = JSON.stringify(got);
  const b = JSON.stringify(want);
  if (a !== b) {
    failures += 1;
    console.error(`  ✗ ${label}: got ${a}, expected ${b}`);
  }
};

const b64url = (s) => Buffer.from(s, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const jwt = (claims) => `${b64url('{"alg":"RS256"}')}.${b64url(JSON.stringify(claims))}.sig`;

const NOW = 1_800_000_000_000;
const req = {
  base: 'https://orcid.org',
  clientId: 'APP-TEST123',
  redirectUri: 'https://mitalivana.org/orcid/callback',
  nonce: 'n-1',
  state: 's-1',
};
// ORCID's own documented example iD (valid check digit).
const good = {
  aud: 'APP-TEST123',
  iss: 'https://orcid.org',
  sub: '0000-0002-1825-0097',
  nonce: 'n-1',
  exp: NOW / 1000 + 600,
  name: '林政道',
};
const redirect = (claims, extra = '') =>
  `${req.redirectUri}#access_token=tok&token_type=bearer&expires_in=599&id_token=${jwt(claims)}&state=s-1${extra}`;
const reason = (url) => {
  const r = parseRedirect(url, req, NOW);
  return r.ok ? 'ok' : r.reason;
};

// ── the request ──
const u = new URL(buildAuthorizeUrl(req));
eq('authorize endpoint', `${u.origin}${u.pathname}`, 'https://orcid.org/oauth/authorize');
eq('implicit flow', u.searchParams.get('response_type'), 'token');
eq('openid scope only', u.searchParams.get('scope'), 'openid');
eq('nonce sent', u.searchParams.get('nonce'), 'n-1');
eq('state sent', u.searchParams.get('state'), 's-1');
eq('sandbox base honoured', new URL(buildAuthorizeUrl({ ...req, base: 'https://sandbox.orcid.org' })).origin, 'https://sandbox.orcid.org');

// ── redirect detection ──
eq('redirect with fragment', isRedirect(`${req.redirectUri}#a=1`, req.redirectUri), true);
eq('redirect with query', isRedirect(`${req.redirectUri}?error=x`, req.redirectUri), true);
eq('lookalike path is not the redirect', isRedirect(`${req.redirectUri}-evil#a=1`, req.redirectUri), false);
eq('ORCID pages are not the redirect', isRedirect('https://orcid.org/signin', req.redirectUri), false);

// ── acceptance ──
const ok = parseRedirect(redirect(good), req, NOW);
eq('valid redirect accepted', ok.ok, true);
eq('iD from sub', ok.ok && ok.identity.orcid, '0000-0002-1825-0097');
eq('UTF-8 name decoded', ok.ok && ok.identity.name, '林政道');
eq('access token kept for userinfo', ok.ok && ok.identity.accessToken, 'tok');
eq('name falls back to given + family', (() => { const r = parseRedirect(redirect({ ...good, name: undefined, given_name: 'Cheng-Tao', family_name: 'Lin' }), req, NOW); return r.ok && r.identity.name; })(), 'Cheng-Tao Lin');
eq('aud as an array', reason(redirect({ ...good, aud: ['x', 'APP-TEST123'] })), 'ok');

// ── rejections ──
eq('state mismatch', reason(redirect(good).replace('state=s-1', 'state=other')), 'invalid');
eq('token for another client', reason(redirect({ ...good, aud: 'APP-OTHER' })), 'invalid');
eq('wrong issuer (sandbox token in production)', reason(redirect({ ...good, iss: 'https://sandbox.orcid.org' })), 'invalid');
eq('nonce replay', reason(redirect({ ...good, nonce: 'old' })), 'invalid');
eq('expired', reason(redirect({ ...good, exp: NOW / 1000 - 1 })), 'invalid');
eq('no exp', reason(redirect({ ...good, exp: undefined })), 'invalid');
eq('sub with a bad check digit', reason(redirect({ ...good, sub: '0000-0002-1825-0098' })), 'invalid');
eq('no id_token', reason(`${req.redirectUri}#access_token=tok&state=s-1`), 'invalid');
eq('garbled id_token', reason(`${req.redirectUri}#access_token=tok&id_token=abc&state=s-1`), 'invalid');
eq('user declined', reason(`${req.redirectUri}?error=access_denied&error_description=x`), 'denied');
eq('other error', reason(`${req.redirectUri}#error=server_error&state=s-1`), 'invalid');
eq('decodeIdToken on non-JWT', decodeIdToken('nope'), null);

if (failures > 0) {
  console.error(`✗ orcid-auth: ${failures} failure(s)`);
  process.exit(1);
}
console.log('✓ orcid-auth: only a fresh, matching, in-date redirect for this client becomes an identity');
