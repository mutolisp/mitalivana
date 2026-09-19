/**
 * Google Drive v3 REST calls.
 *
 * Every function takes the access token as its first argument rather than
 * fetching one itself, so this file never imports `googleAuth.ts` and the two
 * cannot form a cycle (`inatApi.ts` / `inatAuth.ts` are arranged the same
 * way). The layer above — `driveBackup.ts` — is what calls
 * `ensureAccessToken()` and passes the result down.
 *
 * Scope is `drive.file`, so every call here can only ever see files this app
 * created. Nothing else in the user's Drive is readable, which is the whole
 * reason that scope was chosen.
 */
import { File } from 'expo-file-system';
import {
  FileSystemUploadType,
  createDownloadResumable,
  createUploadTask,
} from 'expo-file-system/legacy';
import { ApiError, USER_AGENT, getJson, postJson, qs, sendJson } from './apiFetch';
import {
  DRIVE_ABOUT_URL,
  DRIVE_FILES_URL,
  DRIVE_FOLDER_MIME,
  DRIVE_ROOT_FOLDER_NAME,
  DRIVE_UPLOAD_URL,
  ROLE_KEY,
  childrenQuery,
  folderQuery,
  parseBackupMeta,
  type BackupMeta,
  type FolderRole,
} from './googleDevice';

/** Google wants the bearer prefix here (iNaturalist notably does not). */
function authHeaders(accessToken: string): Record<string, string> {
  return { Authorization: `Bearer ${accessToken}` };
}

/**
 * A backup zip is well under a minute on any usable connection, but a field
 * user's "usable connection" can be one bar of 3G. Long enough not to punish
 * that, short enough that a dead socket does not hang the screen forever.
 */
const UPLOAD_TIMEOUT_MS = 300_000;

// ── account ──────────────────────────────────────────────────────────────────

/**
 * The email of the account the token belongs to, for display on the account
 * screen. `about.get` accepts `drive.file` and requires an explicit `fields`.
 *
 * Returns '' rather than throwing when Drive answers without a user record:
 * a link that works but cannot name itself is still a working link.
 */
export async function fetchAccountEmail(accessToken: string): Promise<string> {
  const json = await getJson(
    'gdrive',
    `${DRIVE_ABOUT_URL}?fields=user(emailAddress,displayName)`,
    undefined,
    undefined,
    0,
    authHeaders(accessToken),
  );
  const user = json.user as { emailAddress?: string; displayName?: string } | undefined;
  return user?.emailAddress ?? user?.displayName ?? '';
}

// ── folders ──────────────────────────────────────────────────────────────────

export type DriveFolders = { rootId: string; backupsId: string };

/**
 * Resolved once per app run. Not persisted on purpose: a stored id survives
 * the user renaming the folder (fine) but also survives them trashing it or
 * linking a different account, and then uploads "succeed" into the trash or
 * fail with a 404 that looks like a bug. Re-resolving costs one `files.list`.
 */
let folderCache: DriveFolders | null = null;

/** Called when the account is unlinked — the next link may be a different Drive. */
export function resetDriveFolderCache(): void {
  folderCache = null;
}

async function findFolder(accessToken: string, role: FolderRole, parentId?: string): Promise<string | null> {
  const url = `${DRIVE_FILES_URL}?${qs({
    q: folderQuery(role, parentId),
    fields: 'files(id,name)',
    pageSize: '10',
    spaces: 'drive',
  })}`;
  const json = await getJson('gdrive', url, undefined, undefined, 0, authHeaders(accessToken));
  const files = json.files as { id?: string }[] | undefined;
  return files?.[0]?.id ?? null;
}

async function createFolder(
  accessToken: string,
  name: string,
  role: FolderRole,
  parentId?: string,
): Promise<string> {
  const json = await postJson(
    'gdrive',
    `${DRIVE_FILES_URL}?fields=id`,
    {
      name,
      mimeType: DRIVE_FOLDER_MIME,
      appProperties: { [ROLE_KEY]: role },
      ...(parentId ? { parents: [parentId] } : {}),
    },
    { headers: authHeaders(accessToken) },
  );
  const id = json.id as string | undefined;
  if (!id) throw new ApiError('gdrive', 'parse', 'files.create returned no id');
  return id;
}

async function ensureFolder(
  accessToken: string,
  name: string,
  role: FolderRole,
  parentId?: string,
): Promise<string> {
  return (
    (await findFolder(accessToken, role, parentId)) ??
    (await createFolder(accessToken, name, role, parentId))
  );
}

/** `Mitalivana/backups/` in the user's Drive, created on first use. */
export async function ensureFolders(accessToken: string): Promise<DriveFolders> {
  if (folderCache) return folderCache;
  const rootId = await ensureFolder(accessToken, DRIVE_ROOT_FOLDER_NAME, 'root');
  const backupsId = await ensureFolder(accessToken, 'backups', 'backups', rootId);
  folderCache = { rootId, backupsId };
  return folderCache;
}

// ── upload ───────────────────────────────────────────────────────────────────

function fileSize(uri: string): number | null {
  try {
    return new File(uri).size ?? null;
  } catch {
    return null;
  }
}

/**
 * Open a resumable upload session and return its URI.
 *
 * Raw `fetch`, not `postJson`: the session URI arrives in the `Location`
 * RESPONSE HEADER, and the shared helpers return the parsed body only.
 */
async function startResumableSession(
  accessToken: string,
  metadata: Record<string, unknown>,
  mimeType: string,
  sizeBytes: number | null,
): Promise<string> {
  const url = `${DRIVE_UPLOAD_URL}?uploadType=resumable&fields=id,name,size,createdTime`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        ...authHeaders(accessToken),
        'Content-Type': 'application/json; charset=UTF-8',
        'User-Agent': USER_AGENT,
        'X-Upload-Content-Type': mimeType,
        ...(sizeBytes != null ? { 'X-Upload-Content-Length': String(sizeBytes) } : {}),
      },
      body: JSON.stringify(metadata),
    });
  } catch (e) {
    throw new ApiError('gdrive', 'network', String((e as Error)?.message ?? e));
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new ApiError('gdrive', 'http', `HTTP ${res.status}`, res.status, detail.slice(0, 300));
  }
  const location = res.headers.get('location');
  if (!location) throw new ApiError('gdrive', 'parse', 'resumable session returned no Location');
  return location;
}

export type UploadArgs = {
  fileUri: string;
  filename: string;
  mimeType: string;
  parentId: string;
  appProperties?: Record<string, string>;
  onProgress?: (sent: number, total: number) => void;
};

/**
 * Upload one local file into a Drive folder.
 *
 * Resumable rather than multipart because multipart is documented for 5 MB or
 * less and a backup can exceed that; the file is streamed from disk by the
 * native layer, so nothing here scales with file size.
 *
 * `createUploadTask` rather than `uploadAsync`: it reports byte progress AND
 * can be cancelled, which is how the timeout below is enforced. `inatApi.ts`
 * had to race a promise instead precisely because `uploadAsync` cannot be
 * stopped.
 *
 * A failure is not resumed mid-stream — the whole session is simply re-opened
 * on the next attempt. Partial re-sends would mean bypassing `createUploadTask`
 * entirely, which is not worth it for a file this size.
 */
export async function uploadFile(accessToken: string, args: UploadArgs): Promise<{ id: string }> {
  const size = fileSize(args.fileUri);
  const sessionUri = await startResumableSession(
    accessToken,
    {
      name: args.filename,
      parents: [args.parentId],
      ...(args.appProperties ? { appProperties: args.appProperties } : {}),
    },
    args.mimeType,
    size,
  );

  const task = createUploadTask(
    sessionUri,
    args.fileUri,
    {
      httpMethod: 'PUT',
      uploadType: FileSystemUploadType.BINARY_CONTENT,
      // No Authorization: the session URI carries its own credentials.
      headers: { 'Content-Type': args.mimeType },
    },
    (p) => args.onProgress?.(p.totalBytesSent, p.totalBytesExpectedToSend),
  );

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    void task.cancelAsync();
  }, UPLOAD_TIMEOUT_MS);

  let res;
  try {
    res = await task.uploadAsync();
  } catch (e) {
    if (timedOut) throw new ApiError('gdrive', 'timeout', `upload timed out after ${UPLOAD_TIMEOUT_MS} ms`);
    throw new ApiError('gdrive', 'network', String((e as Error)?.message ?? e));
  } finally {
    clearTimeout(timer);
  }

  if (!res) {
    throw new ApiError('gdrive', timedOut ? 'timeout' : 'aborted', 'upload cancelled');
  }
  if (res.status < 200 || res.status >= 300) {
    throw new ApiError('gdrive', 'http', `HTTP ${res.status}`, res.status, res.body?.slice(0, 300));
  }
  let id: string | undefined;
  try {
    id = (JSON.parse(res.body) as { id?: string }).id;
  } catch {
    // Fall through to the error below — a 2xx we cannot read still means we do
    // not know what was created.
  }
  if (!id) throw new ApiError('gdrive', 'parse', 'upload response carried no file id');
  return { id };
}

// ── listing / deleting ───────────────────────────────────────────────────────

export type DriveFile = {
  id: string;
  name: string;
  sizeBytes: number | null;
  createdAtMs: number | null;
  meta: BackupMeta;
};

/**
 * Backups in the folder, newest first.
 *
 * `orderBy=createdTime` is what a backup list means (the official guidance to
 * prefer `modifiedTime` is about very large collections; this one is capped at
 * 50). `size` comes back as a STRING in v3 and has to be converted.
 */
export async function listBackups(accessToken: string, backupsId: string): Promise<DriveFile[]> {
  const url = `${DRIVE_FILES_URL}?${qs({
    q: childrenQuery(backupsId),
    orderBy: 'createdTime desc',
    fields: 'files(id,name,size,createdTime,appProperties)',
    pageSize: '50',
    spaces: 'drive',
  })}`;
  const json = await getJson('gdrive', url, undefined, undefined, 0, authHeaders(accessToken));
  const files = (json.files ?? []) as {
    id?: string;
    name?: string;
    size?: string;
    createdTime?: string;
    appProperties?: Record<string, string>;
  }[];
  return files
    .filter((f): f is typeof f & { id: string; name: string } => Boolean(f.id && f.name))
    .map((f) => {
      const size = Number(f.size);
      const created = f.createdTime ? Date.parse(f.createdTime) : NaN;
      return {
        id: f.id,
        name: f.name,
        sizeBytes: Number.isFinite(size) ? size : null,
        createdAtMs: Number.isFinite(created) ? created : null,
        meta: parseBackupMeta(f.appProperties, f.name),
      };
    });
}

/**
 * Download one Drive file to a local path.
 *
 * `createDownloadResumable` for the same reason gbifDownload.ts uses it: it is
 * the one path that reports byte progress, since RN's fetch cannot stream a
 * body. The Authorization header is fixed when the task is created, so the
 * caller must obtain the token immediately before calling — an hour of
 * validity is ample for one download.
 */
export async function downloadFile(
  accessToken: string,
  fileId: string,
  destUri: string,
  onProgress?: (received: number, total: number | null) => void,
): Promise<void> {
  const dest = new File(destUri);
  if (dest.exists) dest.delete();
  const dl = createDownloadResumable(
    `${DRIVE_FILES_URL}/${fileId}?alt=media`,
    destUri,
    { headers: { ...authHeaders(accessToken), 'User-Agent': USER_AGENT } },
    (p) =>
      onProgress?.(
        p.totalBytesWritten,
        p.totalBytesExpectedToWrite > 0 ? p.totalBytesExpectedToWrite : null,
      ),
  );
  let res: { status: number } | undefined;
  try {
    res = await dl.downloadAsync();
  } catch (e) {
    if (dest.exists) dest.delete();
    throw new ApiError('gdrive', 'network', String((e as Error)?.message ?? e));
  }
  if (!res || res.status < 200 || res.status >= 300) {
    // A failed download leaves a partial file that would look like a valid zip
    // to the restore path.
    if (dest.exists) dest.delete();
    throw new ApiError('gdrive', 'http', `HTTP ${res?.status ?? '?'}`, res?.status);
  }
}

export async function deleteFile(accessToken: string, fileId: string): Promise<void> {
  await sendJson('gdrive', 'DELETE', `${DRIVE_FILES_URL}/${fileId}`, undefined, {
    headers: authHeaders(accessToken),
  });
}
