/**
 * Team sync through a relay (docs/Team_sync.md): upload this device's copy of
 * a record, fetch the teammates' copies, and hand them to the team merge
 * (mergeEngine / teamMergeFlow). Runs only when the user presses 同步.
 *
 * Everything that leaves the phone is sealed first (teamCrypto.ts): the relay
 * sees a team id, keyed record / device names, sizes and times.
 *
 * Where things live:
 *   - the team secret: Keychain / Keystore (expo-secure-store,
 *     WHEN_UNLOCKED_THIS_DEVICE_ONLY) — never in user.db, never in a backup;
 *   - teams, record links, merged etags, the offline queue: user.db v58;
 *   - this install's id (hashed into the device name): an app-private file,
 *     not user.db, so a restored backup on another phone is a new device.
 */
import { File, Paths } from 'expo-file-system';
import * as SecureStore from 'expo-secure-store';
import { router, type Href } from 'expo-router';
import { strToU8 } from 'fflate';
import yaml from 'js-yaml';
import { getUserDb } from '~/db/init';
import { getPlotLayers, getPlotSurvey, getPlotSurveyByUuid, getSubplotLayers, importPlotSurvey, listPlotSpecies, listSubplots } from '~/db/plots';
import { getProject } from '~/db/projects';
import { listSessionRecords } from '~/db/records';
import { getSessionByUuid, getSession, importSession } from '~/db/sessions';
import { getSite } from '~/db/sites';
import { getSyncBase, setSyncBase, syncBlockFor } from '~/db/syncBase';
import { localPlotDoc, localSessionDoc } from '~/db/teamMerge';
import { getGloriaSurvey, getSummit, importGloriaDoc, loadGloriaDoc } from '~/modules/gloria/db';
import { validateGloriaDoc, type GloriaDoc } from '~/modules/gloria/export/yaml';
import { findGloriaSurveyFor, localGloriaDoc } from '~/modules/gloria/merge';
import { ApiError, fetchText } from './apiFetch';
import { siteToImported } from './bundleExport';
import { buildPlotYamlDoc, buildSessionYamlDoc } from './bundleYaml';
import { COMBINERS, gloriaSide, plotSide, sessionSide, type MergeKind } from './mergeDocs';
import { prepareRecordMedia, receiveRecordMedia, retryPendingMedia, sendRecordMedia, serverTakesFiles } from './mediaSync';
import type { MediaEntry } from './mediaRefsCore';
import { useSyncProgress, withSyncProgress } from '~/stores/syncProgress';
import { baseOf, diffSides, needsReview, rowHash, type MergeChange, type MergeSide } from './mergeEngine';
import { remapUnknownTaxa } from './recordCreate';
import { readRecordImportFromBytes, type ReadRecordImport } from './recordImportZip';
import {
  aadFor,
  authTokenHash,
  b64u,
  decodeInvite,
  deriveTeamKeys,
  deviceKey,
  encodeInvite,
  fromB64u,
  NONCE_BYTES,
  openRecord,
  recordKey,
  sealRecord,
  TEAM_SECRET_BYTES,
  type Invite,
  type TeamKeys,
} from './teamCrypto';
import { applyPendingMerge, usePendingMerge, type PendingMerge } from './teamMergeFlow';

export const DEFAULT_SERVER = 'https://sync.mitalivana.org';
export const SYNC_API_VERSION = 1;

export type Team = {
  team_id: string;
  name: string;
  server: string | null;
  is_owner: number;
  joined_at: number;
  last_sync_at: number | null;
  /** How this device signs its uploads in the team (v59). */
  member_name: string | null;
};

export type TeamMember = { dev: string; name: string; last_upload_at: number | null };

/**
 * Failure codes the UI explains: the relay's own (`teamQuota`, `teamFull`,
 * `deviceQuota`, `deviceRate`, `objectTooLarge`, `createRate`, `serverFull`,
 * `unauthorized`, `noTeam`, `exists`) plus the client's.
 */
export class TeamSyncError extends Error {
  code: string;
  limit?: number;
  constructor(code: string, limit?: number, detail?: string) {
    super(detail ? `${code}: ${detail}` : code);
    this.code = code;
    this.limit = limit;
  }
}

export function asSyncError(e: unknown): TeamSyncError {
  if (e instanceof TeamSyncError) return e;
  if (e instanceof ApiError) {
    if (e.kind === 'network' || e.kind === 'timeout') return new TeamSyncError('offline');
    try {
      const body = JSON.parse(e.detail ?? '{}') as { error?: string; limit?: number };
      if (body.error) return new TeamSyncError(body.error, body.limit);
    } catch {
      // not the relay's JSON (a proxy's page, a wrong URL)
    }
    return new TeamSyncError('server', undefined, e.message);
  }
  return new TeamSyncError('unknown', undefined, String((e as Error)?.message ?? e));
}

// ── randomness, install id, secrets ─────────────────────────────────────────

export function randomBytes(n: number): Uint8Array {
  const res = getUserDb().executeSync(`SELECT hex(randomblob(?)) AS h;`, [n]);
  const hex = String((res.rows?.[0] as { h?: string } | undefined)?.h ?? '');
  if (hex.length !== n * 2) throw new Error('randomblob failed');
  return Uint8Array.from(hex.match(/../g)!.map((b) => parseInt(b, 16)));
}
export const randomHex = (n: number) =>
  [...randomBytes(n)].map((b) => b.toString(16).padStart(2, '0')).join('');

const DEVICE_FILE = 'team_device.json';
let cachedInstallId: string | null = null;
export function installId(): string {
  if (cachedInstallId) return cachedInstallId;
  const f = new File(Paths.document, DEVICE_FILE);
  try {
    if (f.exists) {
      const id = (JSON.parse(f.textSync()) as { installId?: string }).installId;
      if (id) return (cachedInstallId = id);
    }
  } catch {
    // unreadable: mint a new one (this phone becomes a new device to the team)
  }
  const id = randomHex(16);
  if (f.exists) f.delete();
  f.create();
  f.write(JSON.stringify({ installId: id }));
  return (cachedInstallId = id);
}

const secretKey = (teamId: string) => `teamSecret_${teamId}`;
async function saveSecret(teamId: string, secret: Uint8Array): Promise<void> {
  await SecureStore.setItemAsync(secretKey(teamId), b64u(secret), {
    keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  });
}
async function loadSecret(teamId: string): Promise<Uint8Array | null> {
  const v = await SecureStore.getItemAsync(secretKey(teamId));
  if (!v) return null;
  const b = fromB64u(v);
  return b.length === TEAM_SECRET_BYTES ? b : null;
}
export async function hasSecret(teamId: string): Promise<boolean> {
  return (await loadSecret(teamId)) != null;
}

// ── teams ──────────────────────────────────────────────────────────────────

const rows = <T>(sql: string, args: (string | number | null)[] = []) =>
  (getUserDb().executeSync(sql, args).rows ?? []) as unknown as T[];

export function listTeams(): Team[] {
  return rows<Team>(`SELECT * FROM sync_teams ORDER BY joined_at`);
}
export function getTeam(teamId: string): Team | null {
  return rows<Team>(`SELECT * FROM sync_teams WHERE team_id = ?`, [teamId])[0] ?? null;
}
export const serverOf = (t: Pick<Team, 'server'>) => t.server || DEFAULT_SERVER;

async function relay(
  server: string,
  method: 'GET' | 'PUT' | 'POST' | 'DELETE',
  path: string,
  opts: { token?: string; body?: string; json?: boolean } = {},
) {
  return fetchText('sync', method, `${server.replace(/\/+$/, '')}${path}`, {
    headers: opts.token ? { Authorization: `Bearer ${opts.token}` } : undefined,
    body: opts.body,
    contentType: opts.json ? 'application/json' : 'text/plain',
    timeoutMs: 30000,
  });
}

export type ServerInfo = { api: number; version: string; limits: Record<string, number>; readonly: boolean };

/** Refuses a server that is not a compatible relay. */
export async function checkServer(server: string): Promise<ServerInfo> {
  let info: ServerInfo;
  try {
    info = JSON.parse((await relay(server, 'GET', '/v1/info')).text) as ServerInfo;
  } catch (e) {
    const err = asSyncError(e);
    throw err.code === 'offline' ? err : new TeamSyncError('notARelay');
  }
  if (info?.api !== SYNC_API_VERSION) throw new TeamSyncError('incompatible');
  return info;
}

/** New team; this device is its owner. Returns the team id. */
export async function createTeam(name: string, server: string | null, memberName: string | null = null): Promise<string> {
  // The built-in URL is stored as null, so the app's own default can move.
  if (server && normUrl(server) === DEFAULT_SERVER) server = null;
  const srv = server || DEFAULT_SERVER;
  await checkServer(srv);
  const secret = randomBytes(TEAM_SECRET_BYTES);
  const keys = deriveTeamKeys(secret);
  try {
    await relay(srv, 'POST', `/v1/t/${keys.teamId}`, { body: JSON.stringify({ authHash: authTokenHash(keys.authToken) }), json: true });
  } catch (e) {
    throw asSyncError(e);
  }
  await saveSecret(keys.teamId, secret);
  if (server) rememberServer(server);
  getUserDb().executeSync(
    `INSERT OR REPLACE INTO sync_teams (team_id, name, server, is_owner, joined_at, member_name) VALUES (?, ?, ?, 1, ?, ?)`,
    [keys.teamId, name, server || null, Date.now(), cleanName(memberName)],
  );
  return keys.teamId;
}

export async function joinTeam(inv: Invite, memberName: string | null = null): Promise<string> {
  const keys = deriveTeamKeys(inv.secret);
  const srv = inv.server || DEFAULT_SERVER;
  await checkServer(srv);
  try {
    await relay(srv, 'GET', `/v1/t/${keys.teamId}/usage`, { token: keys.authToken });
  } catch (e) {
    throw asSyncError(e);
  }
  await saveSecret(keys.teamId, inv.secret);
  // The team's server is now one this device knows, for its own teams too.
  if (inv.server) rememberServer(inv.server);
  getUserDb().executeSync(
    `INSERT INTO sync_teams (team_id, name, server, is_owner, joined_at, member_name) VALUES (?, ?, ?, 0, ?, ?)
     ON CONFLICT(team_id) DO UPDATE SET name = excluded.name, server = excluded.server,
       member_name = COALESCE(excluded.member_name, sync_teams.member_name)`,
    [keys.teamId, inv.name, inv.server, Date.now(), cleanName(memberName)],
  );
  // Rejoining (e.g. after the team moved): what was uploaded may not be on
  // this server, so the next pull-down sends everything again.
  getUserDb().executeSync(`UPDATE sync_links SET uploaded_hash = NULL WHERE team_id = ?`, [keys.teamId]);
  return keys.teamId;
}

const cleanName = (n: string | null | undefined) => (n && n.trim() ? n.trim().slice(0, 60) : null);

/** Rename this device in a team; teammates see it from its next upload. */
export function setMemberName(teamId: string, name: string | null): void {
  getUserDb().executeSync(`UPDATE sync_teams SET member_name = ? WHERE team_id = ?`, [cleanName(name), teamId]);
}

/** Teammates this device has received uploads from, most recent first. */
export function listMembers(teamId: string): TeamMember[] {
  return rows<TeamMember>(
    `SELECT dev, name, last_upload_at FROM sync_members WHERE team_id = ? ORDER BY last_upload_at DESC`,
    [teamId],
  );
}

function rememberMember(teamId: string, dev: string, author: string | null | undefined, uploadedAt: number): void {
  const name = cleanName(author);
  if (!name) return;
  getUserDb().executeSync(
    `INSERT INTO sync_members (team_id, dev, name, last_upload_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(team_id, dev) DO UPDATE SET name = excluded.name,
       last_upload_at = MAX(COALESCE(sync_members.last_upload_at, 0), excluded.last_upload_at)`,
    [teamId, dev, name, uploadedAt || Date.now()],
  );
}

// ── known servers (v60) ──────────────────────────────────────────────────────

export type KnownServer = { url: string; is_own: number; is_default: number };

const normUrl = (u: string) => u.trim().replace(/\/+$/, '');

/** Relays besides the built-in one: deployed here, or typed once. */
export function listServers(): KnownServer[] {
  return rows<KnownServer>(`SELECT url, is_own, is_default FROM sync_servers ORDER BY is_own DESC, added_at`);
}

export function rememberServer(url: string, own = false): void {
  const u = normUrl(url);
  if (!u || u === DEFAULT_SERVER) return;
  getUserDb().executeSync(
    `INSERT INTO sync_servers (url, is_own, added_at) VALUES (?, ?, ?)
     ON CONFLICT(url) DO UPDATE SET is_own = MAX(sync_servers.is_own, excluded.is_own)`,
    [u, own ? 1 : 0, Date.now()],
  );
}

export function forgetServer(url: string): void {
  getUserDb().executeSync(`DELETE FROM sync_servers WHERE url = ?`, [normUrl(url)]);
}

/** The server new teams start on: a remembered one marked default, else the built-in. */
export function defaultServerForNewTeams(): string {
  return rows<{ url: string }>(`SELECT url FROM sync_servers WHERE is_default = 1 LIMIT 1`)[0]?.url ?? DEFAULT_SERVER;
}

/** `null` or the built-in URL = back to the built-in default. */
export function setDefaultServerForNewTeams(url: string | null): void {
  const db = getUserDb();
  db.executeSync(`UPDATE sync_servers SET is_default = 0`);
  if (url && normUrl(url) !== DEFAULT_SERVER) {
    rememberServer(url);
    db.executeSync(`UPDATE sync_servers SET is_default = 1 WHERE url = ?`, [normUrl(url)]);
  }
}

export function parseInvite(text: string): Invite | string {
  return decodeInvite(text);
}

export async function inviteCodeFor(teamId: string): Promise<string | null> {
  const t = getTeam(teamId);
  const secret = await loadSecret(teamId);
  return t && secret ? encodeInvite({ secret, name: t.name, server: t.server }) : null;
}

/** Forget the team on this device (the cloud copy stays until it expires or the owner deletes it). */
export async function leaveTeam(teamId: string): Promise<void> {
  await SecureStore.deleteItemAsync(secretKey(teamId));
  const db = getUserDb();
  for (const t of ['sync_teams', 'sync_links', 'sync_seen', 'sync_queue', 'sync_members', 'sync_log']) db.executeSync(`DELETE FROM ${t} WHERE team_id = ?`, [teamId]);
}

export async function keysOf(teamId: string): Promise<{ team: Team; keys: TeamKeys }> {
  const team = getTeam(teamId);
  if (!team) throw new TeamSyncError('noTeam');
  const secret = await loadSecret(teamId);
  if (!secret) throw new TeamSyncError('noSecret');
  return { team, keys: deriveTeamKeys(secret) };
}

/** Delete everything the team has on the server, then leave. */
export async function deleteTeamEverywhere(teamId: string): Promise<void> {
  const { team, keys } = await keysOf(teamId);
  try {
    await relay(serverOf(team), 'DELETE', `/v1/t/${keys.teamId}`, { token: keys.authToken });
  } catch (e) {
    const err = asSyncError(e);
    if (err.code !== 'noTeam') throw err;
  }
  await leaveTeam(teamId);
}

export type MoveResult = { sent: number; review: boolean; queued: boolean; oldServer: string };

/**
 * Move a team to another relay, keeping its key: the team is created there
 * under the same team id, this device's server is switched, and every record
 * linked to the team is uploaded again. Teammates then join with the new
 * invitation; `joinTeam` recognises the same team (same key) and only changes
 * its server, so names, links and what was merged stay. The old copy is left
 * for the caller to delete (or to expire after 90 days).
 */
export async function moveTeam(teamId: string, newServer: string): Promise<MoveResult> {
  const { team, keys } = await keysOf(teamId);
  const oldServer = serverOf(team);
  const target = normUrl(newServer) || DEFAULT_SERVER;
  if (target === oldServer) throw new TeamSyncError('sameServer');
  await checkServer(target);
  try {
    await relay(target, 'POST', `/v1/t/${keys.teamId}`, { body: JSON.stringify({ authHash: authTokenHash(keys.authToken) }), json: true });
  } catch (e) {
    const err = asSyncError(e);
    // Already there (a move that was interrupted): fine if our key opens it.
    if (err.code !== 'exists') throw err;
    try {
      await relay(target, 'GET', `/v1/t/${keys.teamId}/usage`, { token: keys.authToken });
    } catch (e2) {
      throw asSyncError(e2);
    }
  }
  if (target !== DEFAULT_SERVER) rememberServer(target);
  getUserDb().executeSync(`UPDATE sync_teams SET server = ? WHERE team_id = ?`, [target === DEFAULT_SERVER ? null : target, teamId]);
  // Etags and upload fingerprints from the old server mean nothing on the new one.
  getUserDb().executeSync(`DELETE FROM sync_seen WHERE team_id = ?`, [teamId]);
  getUserDb().executeSync(`UPDATE sync_links SET uploaded_hash = NULL WHERE team_id = ?`, [teamId]);
  const linked = rows<{ record_kind: MergeKind; record_uuid: string }>(
    `SELECT record_kind, record_uuid FROM sync_links WHERE team_id = ?`,
    [teamId],
  );
  let sent = 0;
  for (const l of linked) {
    const id = localIdOf(l.record_kind, l.record_uuid);
    if (id == null) continue;
    const r = await syncRecord(teamId, l.record_kind, id);
    if (r.queued) return { sent, review: false, queued: true, oldServer };
    sent += 1;
    if (r.review) return { sent, review: true, queued: false, oldServer };
  }
  return { sent, review: false, queued: false, oldServer };
}

/** Delete a team's data from a server it has left (after a move). */
export async function deleteTeamOn(teamId: string, server: string): Promise<void> {
  const { keys } = await keysOf(teamId);
  try {
    await relay(server, 'DELETE', `/v1/t/${keys.teamId}`, { token: keys.authToken });
  } catch (e) {
    const err = asSyncError(e);
    if (err.code !== 'noTeam') throw err;
  }
}

export type TeamUsage = { bytes: number; objects: number; devices: Record<string, number>; limits: Record<string, number>; mine: number; mediaBytes?: number };

export async function teamUsage(teamId: string): Promise<TeamUsage> {
  const { team, keys } = await keysOf(teamId);
  try {
    const u = JSON.parse((await relay(serverOf(team), 'GET', `/v1/t/${keys.teamId}/usage`, { token: keys.authToken })).text) as Omit<TeamUsage, 'mine'>;
    return { ...u, mine: u.devices[deviceKey(keys.encKey, installId())] ?? 0 };
  } catch (e) {
    throw asSyncError(e);
  }
}

// ── records ────────────────────────────────────────────────────────────────

type Ident = { uuid: string; ident: string };

function identOf(kind: MergeKind, id: number): Ident | null {
  if (kind === 'session') {
    const s = getSession(id);
    return s?.uuid ? { uuid: s.uuid, ident: s.uuid } : null;
  }
  if (kind === 'plot') {
    const p = getPlotSurvey(id);
    return p ? { uuid: p.uuid, ident: p.uuid } : null;
  }
  const sv = getGloriaSurvey(id);
  const summit = sv ? getSummit(sv.summit_id) : null;
  // Summit + cycle, not uuid: two phones that each started this survey meet.
  return sv && summit ? { uuid: sv.uuid, ident: `${summit.full_code}|${sv.mocy}` } : null;
}

/** The record as an export yml (no media), carrying this device's ancestor. */
/**
 * The sealed upload's plaintext, and its fingerprint: the same document
 * without the export time, so an unchanged record hashes the same every time.
 */
function recordText(kind: MergeKind, id: number, uuid: string, author: string | null, media: MediaEntry[] = []): { text: string; hash: string } {
  let doc: Record<string, unknown> | null = null;
  if (kind === 'session') {
    const session = getSession(id);
    if (session) {
      const site = session.site_id != null ? getSite(session.site_id) : null;
      doc = buildSessionYamlDoc({
        session,
        projectName: getProject(session.project_id)?.name ?? '',
        records: listSessionRecords(id),
        site: site ? siteToImported(site) : null,
      });
    }
  } else if (kind === 'plot') {
    const plot = getPlotSurvey(id);
    if (plot) {
      const subplots = listSubplots(id);
      const site = plot.site_id != null ? getSite(plot.site_id) : null;
      doc = buildPlotYamlDoc({
        plot,
        projectName: plot.project_id != null ? (getProject(plot.project_id)?.name ?? '') : '',
        species: listPlotSpecies(id),
        layers: plot.plot_type === 'fixed' ? getPlotLayers(id) : [],
        subplots: subplots.map((s) => ({ ...s, layers: getSubplotLayers(s.id) })),
        subplotLabelById: new Map(subplots.map((s) => [s.id, s.label])),
        site: site ? siteToImported(site) : null,
      });
    }
  } else {
    doc = loadGloriaDoc(id) as unknown as Record<string, unknown> | null;
  }
  if (!doc) throw new TeamSyncError('noRecord');
  // The file manifest is part of the fingerprint: a new photo makes the record "changed".
  const sync = { ...syncBlockFor(kind, uuid), ...(author ? { author } : {}), ...(media.length ? { media } : {}) };
  const { exported_at: _at, ...stable } = sync;
  return { text: yaml.dump({ ...doc, sync }, { lineWidth: -1, noRefs: true }), hash: rowHash({ doc, sync: stable }) };
}

/** The team's server without the scheme, to tell same-named teams apart. */
export function serverHost(t: Pick<Team, 'server'>): string {
  return hostOf(serverOf(t));
}

export const hostOf = (url: string) => url.replace(/^https:\/\//, '').replace(/\/+$/, '');

// ── server names (v71) ──────────────────────────────────────────────────────

/** The short name given to a server on this device, or null. */
export function serverAlias(url: string): string | null {
  return rows<{ alias: string }>(`SELECT alias FROM sync_server_alias WHERE url = ?`, [normUrl(url)])[0]?.alias ?? null;
}

/** Name a server on this device; empty or null removes the name. */
export function setServerAlias(url: string, alias: string | null): void {
  const a = alias?.trim().slice(0, 40) || null;
  if (a) getUserDb().executeSync(`INSERT OR REPLACE INTO sync_server_alias (url, alias) VALUES (?, ?)`, [normUrl(url), a]);
  else getUserDb().executeSync(`DELETE FROM sync_server_alias WHERE url = ?`, [normUrl(url)]);
}

/** How a server is shown: its short name, else its host. */
export function serverLabel(url: string): string {
  return serverAlias(url) ?? hostOf(url);
}

/** A team's server as shown (short name, else host). */
export function teamServerLabel(t: Pick<Team, 'server'>): string {
  return serverLabel(serverOf(t));
}

/** Other teams on this device with the same name (one re-created on another server instead of moved). */
export function sameNameTeams(teamId: string): Array<Team & { linked: number }> {
  const me = getTeam(teamId);
  if (!me) return [];
  const k = me.name.trim().toLowerCase();
  return listTeams()
    .filter((x) => x.team_id !== teamId && x.name.trim().toLowerCase() === k)
    .map((x) => ({ ...x, linked: rows<{ n: number }>(`SELECT COUNT(*) AS n FROM sync_links WHERE team_id = ?`, [x.team_id])[0]?.n ?? 0 }));
}

// ── sync log (v70) ─────────────────────────────────────────────────────────

export type SyncLogAction = 'upload' | 'skip' | 'merge' | 'import' | 'link' | 'queued' | 'fail';
export type SyncLogEntry = {
  id: number;
  team_id: string;
  record_kind: MergeKind | null;
  record_uuid: string | null;
  label: string | null;
  action: SyncLogAction;
  server: string | null;
  bytes: number | null;
  detail: string | null;
  at: number;
};

/** A record's name as the lists show it: checklist name, plot id, GLORIA summit and cycle. */
function recordLabel(kind: MergeKind, id: number): string | null {
  if (kind === 'session') return getSession(id)?.name ?? null;
  if (kind === 'plot') return getPlotSurvey(id)?.plotid ?? null;
  const sv = getGloriaSurvey(id);
  const sm = sv ? getSummit(sv.summit_id) : null;
  return sv && sm ? `${sm.full_code} mocy ${sv.mocy}` : null;
}

function logSync(
  teamId: string,
  action: SyncLogAction,
  rec: { kind: MergeKind; uuid: string; id?: number | null } | null,
  extra: { server?: string | null; bytes?: number | null; detail?: string | null } = {},
): void {
  try {
    getUserDb().executeSync(
      `INSERT INTO sync_log (team_id, record_kind, record_uuid, label, action, server, bytes, detail, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [teamId, rec?.kind ?? null, rec?.uuid ?? null, rec?.id != null ? recordLabel(rec.kind, rec.id) : null, action, extra.server ?? null, extra.bytes ?? null, extra.detail ?? null, Date.now()],
    );
  } catch (e) {
    // The log must never stop a sync.
    if (__DEV__) console.warn('[teamSync] log failed', e);
  }
}

/** Newest first; one team, or every team on this device. */
export function listSyncLog(teamId?: string | null, limit = 300): SyncLogEntry[] {
  return teamId
    ? rows<SyncLogEntry>(`SELECT * FROM sync_log WHERE team_id = ? ORDER BY at DESC, id DESC LIMIT ?`, [teamId, limit])
    : rows<SyncLogEntry>(`SELECT * FROM sync_log ORDER BY at DESC, id DESC LIMIT ?`, [limit]);
}

export function linkedTeams(kind: MergeKind, uuid: string): string[] {
  return rows<{ team_id: string }>(`SELECT team_id FROM sync_links WHERE record_kind = ? AND record_uuid = ?`, [kind, uuid]).map(
    (r) => r.team_id,
  );
}
export function recordUuid(kind: MergeKind, id: number): string | null {
  return identOf(kind, id)?.uuid ?? null;
}
export function queuedCount(teamId?: string): number {
  return rows<{ n: number }>(teamId ? `SELECT COUNT(*) AS n FROM sync_queue WHERE team_id = ?` : `SELECT COUNT(*) AS n FROM sync_queue`, teamId ? [teamId] : [])[0]?.n ?? 0;
}

const seenEtag = (teamId: string, rec: string, dev: string) =>
  rows<{ etag: string }>(`SELECT etag FROM sync_seen WHERE team_id = ? AND rec_key = ? AND dev = ?`, [teamId, rec, dev])[0]?.etag ?? null;
function markSeen(teamId: string, rec: string, dev: string, etag: string): void {
  getUserDb().executeSync(`INSERT OR REPLACE INTO sync_seen (team_id, rec_key, dev, etag) VALUES (?, ?, ?, ?)`, [teamId, rec, dev, etag]);
}
function link(teamId: string, kind: MergeKind, uuid: string, rec: string, syncedAt: number | null): void {
  getUserDb().executeSync(
    `INSERT INTO sync_links (team_id, record_kind, record_uuid, rec_key, last_synced_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(team_id, record_kind, record_uuid) DO UPDATE SET rec_key = excluded.rec_key,
       last_synced_at = COALESCE(excluded.last_synced_at, sync_links.last_synced_at)`,
    [teamId, kind, uuid, rec, syncedAt],
  );
}

type Item = { rec?: string; dev: string; etag: string; size: number; uploaded: number };

async function download(team: Team, keys: TeamKeys, rec: string, dev: string): Promise<ReadRecordImport> {
  const { text } = await relay(serverOf(team), 'GET', `/v1/t/${keys.teamId}/r/${rec}/${dev}`, { token: keys.authToken });
  let yml: string;
  try {
    yml = openRecord(keys.encKey, fromB64u(text.trim()), aadFor(keys.teamId, rec, dev));
  } catch {
    // Altered, or sealed with another key: never merged.
    throw new TeamSyncError('corrupt');
  }
  return readRecordImportFromBytes(strToU8(yml));
}

/** This device's side of a record and a teammate's copy → merge items. */
function prepare(kind: MergeKind, localId: number, localUuid: string, payload: ReadRecordImport): PendingMerge | 'same' | 'mismatch' {
  let local: MergeSide | null = null;
  let remote: MergeSide;
  let label = '';
  if (kind === 'session' && payload.kind === 'session') {
    remapUnknownTaxa(payload.session.records);
    const d = localSessionDoc(localId);
    local = d ? sessionSide(d) : null;
    remote = sessionSide(payload.session);
    label = d?.name ?? '';
  } else if (kind === 'plot' && payload.kind === 'plot') {
    remapUnknownTaxa(payload.plot.species);
    const d = localPlotDoc(localId);
    local = d ? plotSide(d) : null;
    remote = plotSide(payload.plot);
    label = d?.plotid ?? '';
  } else if (kind === 'gloria' && payload.kind === 'gloria') {
    const d = localGloriaDoc(localId);
    local = d ? gloriaSide(d) : null;
    remote = gloriaSide(payload.gloria);
    label = `${payload.gloria.summit.full_code} mocy ${payload.gloria.survey.mocy}`;
  } else {
    return 'mismatch';
  }
  if (!local) return 'mismatch';
  const items = diffSides(local, remote, payload.sync?.base ?? null, COMBINERS[kind], getSyncBase(kind, localUuid));
  if (items.length === 0) {
    setSyncBase(kind, localUuid, baseOf(remote));
    return 'same';
  }
  return { kind, localId, localUuid, label, items, remoteSide: remote, photos: [], audio: [] };
}

export type SyncOutcome = {
  /** Teammates' copies merged without a question. */
  merged: number;
  /** Their names, when they signed (for the toast). */
  mergedFrom: string[];
  /** Rows the merges changed (for the toast's summary; the merge log keeps them). */
  changes: MergeChange[];
  /** A copy needs the reviewer: the merge screen was opened. */
  review: boolean;
  /** No connection: queued for the next 同步. */
  queued: boolean;
  /** This device's copy was sent (false: unchanged, skipped by onlyIfChanged). */
  uploaded: boolean;
};

/** An unchanged record is still re-sent after this long, well inside the relay's 90-day expiry. */
const REUPLOAD_MS = 30 * 24 * 3600 * 1000;

function hrefOf(kind: MergeKind, id: number): Href {
  return (kind === 'session' ? `/session/${id}` : kind === 'plot' ? `/plot/${id}` : `/gloria/${id}`) as Href;
}

/**
 * Upload this record, then merge every teammate's copy that changed since the
 * last merge. Copies that need a decision open the review screen (one at a
 * time; the rest are picked up by the next 同步).
 */
export function syncRecord(teamId: string, kind: MergeKind, id: number, opts: { onlyIfChanged?: boolean } = {}): Promise<SyncOutcome> {
  // The progress strip on every screen while it runs (SyncProgressHost).
  return withSyncProgress(() => {
    useSyncProgress.getState().update({ record: recordLabel(kind, id), stage: 'record' });
    return syncRecordNow(teamId, kind, id, opts);
  });
}

async function syncRecordNow(teamId: string, kind: MergeKind, id: number, opts: { onlyIfChanged?: boolean }): Promise<SyncOutcome> {
  const { team, keys } = await keysOf(teamId);
  const who = identOf(kind, id);
  if (!who) throw new TeamSyncError('noRecord');
  const rec = recordKey(keys.encKey, kind, who.ident);
  const dev = deviceKey(keys.encKey, installId());
  link(teamId, kind, who.uuid, rec, null);
  const out: SyncOutcome = { merged: 0, mergedFrom: [], changes: [], review: false, queued: false, uploaded: false };
  const server = serverOf(team);
  // Files go only to servers that take them (self-hosted, Media_sync.md).
  const withFiles = async () => ((await serverTakesFiles(server)) ? prepareRecordMedia(keys, kind, id) : null);
  // A teammate's copy: its files are fetched and added here (adding only).
  const receive = async (manifest: unknown[] | undefined) => {
    if (!manifest?.length) return;
    const r = await receiveRecordMedia(teamId, kind, who.uuid, id, manifest);
    if (r.added) logSync(teamId, 'merge', { kind, uuid: who.uuid, id }, { server, detail: `files:${r.added}` });
  };
  // This device's copy as it is now, with its base (`sync.base`) and its files.
  const put = async () => {
    const prepared = await withFiles();
    const sentFiles = prepared ? await sendRecordMedia(server, keys, prepared, rec, dev) : 0;
    const { text, hash } = recordText(kind, id, who.uuid, team.member_name, prepared?.entries ?? []);
    const sealed = sealRecord(keys.encKey, randomBytes(NONCE_BYTES), text, aadFor(keys.teamId, rec, dev));
    const body = b64u(sealed);
    await relay(serverOf(team), 'PUT', `/v1/t/${keys.teamId}/r/${rec}/${dev}`, { token: keys.authToken, body });
    getUserDb().executeSync(
      `UPDATE sync_links SET uploaded_hash = ?, uploaded_at = ? WHERE team_id = ? AND record_kind = ? AND record_uuid = ?`,
      [hash, Date.now(), teamId, kind, who.uuid],
    );
    out.uploaded = true;
    logSync(teamId, 'upload', { kind, uuid: who.uuid, id }, { server, bytes: body.length, detail: sentFiles ? `files:${sentFiles}` : null });
  };
  try {
    await retryPendingMedia(teamId, localIdOf, { kind, uuid: who.uuid });
    const { hash } = recordText(kind, id, who.uuid, team.member_name, (await withFiles())?.entries ?? []);
    const last = rows<{ uploaded_hash: string | null; uploaded_at: number | null }>(
      `SELECT uploaded_hash, uploaded_at FROM sync_links WHERE team_id = ? AND record_kind = ? AND record_uuid = ?`,
      [teamId, kind, who.uuid],
    )[0];
    const unchanged = last?.uploaded_hash === hash && (last.uploaded_at ?? 0) > Date.now() - REUPLOAD_MS;
    if (!(opts.onlyIfChanged && unchanged)) await put();
    else logSync(teamId, 'skip', { kind, uuid: who.uuid, id }, { server: serverOf(team) });
    const { items } = JSON.parse((await relay(serverOf(team), 'GET', `/v1/t/${keys.teamId}/r/${rec}/`, { token: keys.authToken })).text) as {
      items: Item[];
    };
    for (const it of items) {
      if (it.dev === dev || seenEtag(teamId, rec, it.dev) === it.etag) continue;
      let payload: ReadRecordImport;
      try {
        payload = await download(team, keys, rec, it.dev);
      } catch (e) {
        if (e instanceof TeamSyncError && e.code === 'corrupt') {
          markSeen(teamId, rec, it.dev, it.etag); // never retried: it will not open
          continue;
        }
        throw e;
      }
      rememberMember(teamId, it.dev, payload.sync?.author, it.uploaded);
      const prep = prepare(kind, id, who.uuid, payload);
      if (prep === 'mismatch') {
        markSeen(teamId, rec, it.dev, it.etag);
        continue;
      }
      if (prep === 'same') {
        // Same content, but the teammate may have photos this device lacks.
        await receive(payload.sync?.media);
        markSeen(teamId, rec, it.dev, it.etag);
        continue;
      }
      const onApplied = () => markSeen(teamId, rec, it.dev, it.etag);
      if (prep.items.every((i) => !needsReview(i))) {
        // Only additions and one-sided edits: applied like the review's
        // defaults, without a backup (nothing is overwritten that was changed here).
        const res = await applyPendingMerge({ ...prep, afterApply: onApplied, from: payload.sync?.author ?? null }, new Map(), { backup: false });
        out.changes.push(...res.changes);
        out.merged += 1;
        if (payload.sync?.author) out.mergedFrom.push(payload.sync.author);
        // After the rows: a photo of a species row new here needs that row.
        await receive(payload.sync?.media);
        continue;
      }
      usePendingMerge.getState().set({
        ...prep,
        afterApply: () => {
          onApplied();
          // Files after the reviewed rows are in; failures wait in media_pending.
          void receive(payload.sync?.media).catch(() => {});
        },
        from: payload.sync?.author ?? null,
        fromAt: it.uploaded || null,
      });
      router.push('/merge' as Href);
      out.review = true;
      break;
    }
    // Teammates' changes were merged here: send the merged copy now. The copy
    // uploaded above predates them and carries the base from before, so a
    // teammate merging it would take their own newer values for conflicts
    // and keep the old ones (Device_test 隊伍同步 #4, 2026-09-27).
    if (out.merged > 0) {
      logSync(teamId, 'merge', { kind, uuid: who.uuid, id }, { server: serverOf(team), detail: [...new Set(out.mergedFrom)].join('、') || String(out.merged) });
      await put();
    }
    const now = Date.now();
    link(teamId, kind, who.uuid, rec, now);
    getUserDb().executeSync(`UPDATE sync_teams SET last_sync_at = ? WHERE team_id = ?`, [now, teamId]);
    getUserDb().executeSync(`DELETE FROM sync_queue WHERE team_id = ? AND record_kind = ? AND record_uuid = ?`, [teamId, kind, who.uuid]);
    return out;
  } catch (e) {
    const err = asSyncError(e);
    if (err.code === 'offline') {
      getUserDb().executeSync(
        `INSERT OR REPLACE INTO sync_queue (team_id, record_kind, record_uuid, queued_at) VALUES (?, ?, ?, ?)`,
        [teamId, kind, who.uuid, Date.now()],
      );
      logSync(teamId, 'queued', { kind, uuid: who.uuid, id }, { server: serverOf(team) });
      return { ...out, queued: true };
    }
    logSync(teamId, 'fail', { kind, uuid: who.uuid, id }, { server: serverOf(team), detail: err.code });
    throw err;
  }
}

export function localIdOf(kind: MergeKind, uuid: string): number | null {
  if (kind === 'session') return getSessionByUuid(uuid)?.id ?? null;
  if (kind === 'plot') return getPlotSurveyByUuid(uuid)?.id ?? null;
  return rows<{ id: number }>(`SELECT id FROM gloria_surveys WHERE uuid = ?`, [uuid])[0]?.id ?? null;
}

/** Send what was queued while offline. Stops at the first review. */
export async function flushQueue(teamId: string): Promise<{ sent: number; review: boolean; queued: boolean }> {
  const queued = rows<{ record_kind: MergeKind; record_uuid: string }>(`SELECT record_kind, record_uuid FROM sync_queue WHERE team_id = ?`, [teamId]);
  let sent = 0;
  for (const q of queued) {
    const id = localIdOf(q.record_kind, q.record_uuid);
    if (id == null) {
      getUserDb().executeSync(`DELETE FROM sync_queue WHERE team_id = ? AND record_uuid = ?`, [teamId, q.record_uuid]);
      continue;
    }
    const r = await syncRecord(teamId, q.record_kind, id);
    if (r.queued) return { sent, review: false, queued: true };
    sent += 1;
    if (r.review) return { sent, review: true, queued: false };
  }
  return { sent, review: false, queued: false };
}

export type TeamSyncOutcome = {
  /** Records whose changes were uploaded (unchanged ones are only checked for teammates' changes). */
  sent: number;
  merged: number;
  mergedFrom: string[];
  changes: MergeChange[];
  /** The team's records that were not on this device yet. */
  imported: number;
  /** Stopped at a copy that needs the reviewer (the merge screen is open). */
  review: boolean;
  /** Stopped for lack of a connection (the rest wait for the next sync). */
  queued: boolean;
};

/**
 * The team page's pull-to-refresh: sync every record linked to this team —
 * uploading only those changed since this device last sent them (and the
 * queue) — then bring in the team's records not here yet.
 * Stops at the first review or when the connection drops, like flushQueue.
 */
export function syncTeam(teamId: string, opts: { pull?: boolean } = {}): Promise<TeamSyncOutcome> {
  return withSyncProgress(() => syncTeamNow(teamId, opts));
}

let allRunning = false;

/**
 * The Records tab's pull-down: every record already linked to a team this
 * device holds the key for, team by team — what each team page's pull-down
 * does, without fetching teammates' records that are not here yet. Null when
 * one is already running. Stops at the first review or when offline.
 */
export async function syncAllTeams(): Promise<(TeamSyncOutcome & { teams: number }) | null> {
  if (allRunning) return null;
  allRunning = true;
  try {
    return await withSyncProgress(async () => {
      const out = { sent: 0, merged: 0, mergedFrom: [] as string[], changes: [] as TeamSyncOutcome['changes'], imported: 0, review: false, queued: false, teams: 0 };
      for (const team of listTeams()) {
        if (!(await hasSecret(team.team_id))) continue;
        const linked = rows<{ n: number }>(`SELECT COUNT(*) AS n FROM sync_links WHERE team_id = ?`, [team.team_id])[0]?.n ?? 0;
        if (!linked) continue;
        out.teams += 1;
        const r = await syncTeamNow(team.team_id, { pull: false });
        out.sent += r.sent;
        out.merged += r.merged;
        out.mergedFrom.push(...r.mergedFrom);
        out.changes.push(...r.changes);
        if (r.queued || r.review) return { ...out, queued: r.queued, review: r.review };
      }
      return out;
    });
  } finally {
    allRunning = false;
  }
}

async function syncTeamNow(teamId: string, opts: { pull?: boolean } = {}): Promise<TeamSyncOutcome> {
  const out: TeamSyncOutcome = { sent: 0, merged: 0, mergedFrom: [], changes: [], imported: 0, review: false, queued: false };
  // Files that could not be fetched last time, for every record of the team.
  await retryPendingMedia(teamId, localIdOf).catch(() => {});
  const linked = rows<{ record_kind: MergeKind; record_uuid: string }>(
    `SELECT record_kind, record_uuid FROM sync_links WHERE team_id = ? ORDER BY last_synced_at`,
    [teamId],
  );
  for (const [n, l] of linked.entries()) {
    const id = localIdOf(l.record_kind, l.record_uuid);
    if (id == null) continue; // deleted here; cleanup.ts drops the link
    useSyncProgress.getState().update({ recordIndex: n + 1, recordCount: linked.length });
    const r = await syncRecord(teamId, l.record_kind, id, { onlyIfChanged: true });
    if (r.queued) return { ...out, queued: true };
    if (r.uploaded) out.sent += 1;
    out.merged += r.merged;
    out.mergedFrom.push(...r.mergedFrom);
    out.changes.push(...r.changes);
    if (r.review) return { ...out, review: true };
  }
  if (opts.pull !== false) out.imported = (await pullTeamRecords(teamId)).imported;
  return out;
}

/**
 * Bring in the team's records this device does not have yet (a new member's
 * first step). Each lands as a finished record, like any import; reopen it to
 * keep recording. A record that exists here already is linked, and merged on
 * its next 同步.
 */
export function pullTeamRecords(teamId: string): Promise<{ imported: number; linked: number }> {
  return withSyncProgress(() => pullTeamRecordsNow(teamId));
}

async function pullTeamRecordsNow(teamId: string): Promise<{ imported: number; linked: number }> {
  const { team, keys } = await keysOf(teamId);
  const dev = deviceKey(keys.encKey, installId());
  let items: Item[];
  try {
    items = (JSON.parse((await relay(serverOf(team), 'GET', `/v1/t/${keys.teamId}/r`, { token: keys.authToken })).text) as { items: Item[] }).items;
  } catch (e) {
    throw asSyncError(e);
  }
  const known = new Set(rows<{ rec_key: string }>(`SELECT rec_key FROM sync_links WHERE team_id = ?`, [teamId]).map((r) => r.rec_key));
  const newest = new Map<string, Item>();
  for (const it of items) {
    if (!it.rec || known.has(it.rec) || it.dev === dev) continue;
    const cur = newest.get(it.rec);
    if (!cur || it.uploaded > cur.uploaded) newest.set(it.rec, it);
  }
  let imported = 0;
  let linked = 0;
  for (const [rec, it] of newest) {
    let payload: ReadRecordImport;
    try {
      payload = await download(team, keys, rec, it.dev);
    } catch (e) {
      if (e instanceof TeamSyncError && e.code === 'corrupt') continue;
      throw asSyncError(e);
    }
    rememberMember(teamId, it.dev, payload.sync?.author, it.uploaded);
    if (payload.kind === 'collection') continue;
    const kind: MergeKind = payload.kind;
    // Already here (same uuid, or GLORIA's same summit + cycle): link only.
    const hereId =
      payload.kind === 'gloria'
        ? findGloriaSurveyFor(payload.gloria)
        : localIdOf(kind, payload.kind === 'session' ? payload.session.uuid : payload.plot.uuid);
    if (hereId != null) {
      const who = identOf(kind, hereId);
      if (who) {
        link(teamId, kind, who.uuid, rec, null);
        logSync(teamId, 'link', { kind, uuid: who.uuid, id: hereId }, { server: serverOf(team), detail: payload.sync?.author ?? null });
        useSyncProgress.getState().update({ record: recordLabel(kind, hereId) });
        await receiveRecordMedia(teamId, kind, who.uuid, hereId, payload.sync?.media ?? []);
      }
      linked += 1;
      continue;
    }
    let newId: number;
    if (payload.kind === 'session') {
      if (!payload.session.uuid) continue;
      remapUnknownTaxa(payload.session.records);
      newId = importSession(payload.session, { newUuid: false }).sessionId;
    } else if (payload.kind === 'plot') {
      remapUnknownTaxa(payload.plot.species);
      newId = importPlotSurvey(payload.plot, { newUuid: false }).plotId;
    } else {
      if (validateGloriaDoc(payload.gloria).length) continue;
      newId = importGloriaDoc(withoutSenderFiles(payload.gloria)).surveyId;
    }
    // The imported rows are what both sides now share.
    const who = identOf(kind, newId);
    if (!who) continue;
    const stored = kind === 'session' ? localSessionDoc(newId) : kind === 'plot' ? localPlotDoc(newId) : localGloriaDoc(newId);
    if (stored) {
      const side =
        kind === 'session'
          ? sessionSide(stored as NonNullable<ReturnType<typeof localSessionDoc>>)
          : kind === 'plot'
            ? plotSide(stored as NonNullable<ReturnType<typeof localPlotDoc>>)
            : gloriaSide(stored as NonNullable<ReturnType<typeof localGloriaDoc>>);
      setSyncBase(kind, who.uuid, baseOf(side));
    }
    link(teamId, kind, who.uuid, rec, Date.now());
    markSeen(teamId, rec, it.dev, it.etag);
    logSync(teamId, 'import', { kind, uuid: who.uuid, id: newId }, { server: serverOf(team), bytes: it.size, detail: payload.sync?.author ?? null });
    useSyncProgress.getState().update({ record: recordLabel(kind, newId) });
    await receiveRecordMedia(teamId, kind, who.uuid, newId, payload.sync?.media ?? []);
    imported += 1;
  }
  return { imported, linked };
}

/**
 * A teammate's GLORIA document without the file references of THEIR phone
 * (paths that do not exist here). The files come through the record's file
 * manifest instead and are added with this device's paths (mediaSync.ts).
 */
function withoutSenderFiles(g: GloriaDoc): GloriaDoc {
  return {
    ...g,
    survey: { ...g.survey, overview_photos: null, form1_files: null, form2_files: null, form3_files: null, form6s_files: null },
    points: g.points.map((p) => ({ ...p, photo_m2: null, photo_m2f: null, photo_point: null })),
    units: g.units.map((u) => ({ ...u, photo_paths: null })),
    ...(g.photo_checks ? { photo_checks: g.photo_checks.map((c) => ({ ...c, photo_uri: null })) } : {}),
    ...(g.logger_visits
      ? {
          logger_visits: g.logger_visits.map((v) => ({
            ...v,
            form4_files: null,
            loggers: v.loggers.map((l) => ({ ...l, photo_open_uri: null, photo_closed_uri: null, data_files: null })),
          })),
        }
      : {}),
  };
}

export { hrefOf as syncedRecordHref };
