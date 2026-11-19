/**
 * Durability for the in-memory databases: whole-file snapshots in IndexedDB.
 *
 *   - One IndexedDB database `mitalivana-gloria` with stores:
 *       db      user.db / user.db.prev / regionpacks.db snapshots
 *       media   photo and file Blobs (mediaStore.ts)
 *       meta    small bookkeeping (last export / backup times)
 *       species downloaded species database (datasetsHost.ts)
 *   - A write marks the DB dirty; a flush runs 300 ms after the last write,
 *     at most 2 s after the first unsaved one, and at once when the page is
 *     hidden (switching apps on a phone is the usual way a PWA dies).
 *   - Each flush writes the new copy and moves the old one to `<key>.prev` in
 *     a single transaction, so a crash mid-write leaves one good copy.
 *   - Only one tab may own the database (Web Lock); a second tab's snapshots
 *     would overwrite the first's.
 */

export type Snapshot = { bytes: Uint8Array; schemaVersion: number; savedAt: number };
export type SaveState = 'saved' | 'pending' | 'saving' | 'error';

const IDB_NAME = 'mitalivana-gloria';
const IDB_VERSION = 1;
export const STORES = ['db', 'media', 'meta', 'species'] as const;
export type StoreName = (typeof STORES)[number];

let idbPromise: Promise<IDBDatabase> | null = null;

export function openIdb(): Promise<IDBDatabase> {
  if (idbPromise) return idbPromise;
  idbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, IDB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const s of STORES) if (!db.objectStoreNames.contains(s)) db.createObjectStore(s);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('IndexedDB upgrade blocked by another tab'));
  });
  return idbPromise;
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('transaction aborted'));
  });
}

function reqValue<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function idbGet<T>(store: StoreName, key: string): Promise<T | undefined> {
  const db = await openIdb();
  return reqValue(db.transaction(store, 'readonly').objectStore(store).get(key)) as Promise<T | undefined>;
}

export async function idbPut(store: StoreName, key: string, value: unknown): Promise<void> {
  const db = await openIdb();
  const tx = db.transaction(store, 'readwrite', { durability: 'strict' });
  tx.objectStore(store).put(value, key);
  await done(tx);
}

export async function idbDelete(store: StoreName, key: string): Promise<void> {
  const db = await openIdb();
  const tx = db.transaction(store, 'readwrite');
  tx.objectStore(store).delete(key);
  await done(tx);
}

export async function idbKeys(store: StoreName): Promise<string[]> {
  const db = await openIdb();
  return (await reqValue(db.transaction(store, 'readonly').objectStore(store).getAllKeys())) as string[];
}

export function readSnapshot(key: string): Promise<Snapshot | undefined> {
  return idbGet<Snapshot>('db', key);
}

/** Write `key`, keeping the previous copy as `<key>.prev`, in one transaction. */
export async function writeSnapshot(key: string, snap: Snapshot): Promise<void> {
  const db = await openIdb();
  const tx = db.transaction('db', 'readwrite', { durability: 'strict' });
  const store = tx.objectStore('db');
  const cur = store.get(key);
  cur.onsuccess = () => {
    if (cur.result) store.put(cur.result, `${key}.prev`);
    store.put(snap, key);
  };
  await done(tx);
}

// ── Flush scheduling ──────────────────────────────────────────────────────

export type Flusher = {
  /** Something changed; flush soon. */
  schedule(): void;
  /** Flush now if anything is unsaved. */
  flushNow(): Promise<void>;
  state(): SaveState;
  subscribe(fn: (s: SaveState) => void): () => void;
};

export function createFlusher(
  key: string,
  take: () => Snapshot | null,
  opts: { debounceMs?: number; maxDelayMs?: number } = {},
): Flusher {
  const debounceMs = opts.debounceMs ?? 300;
  const maxDelayMs = opts.maxDelayMs ?? 2000;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let firstPendingAt = 0;
  let pending = false;
  let running: Promise<void> | null = null;
  let current: SaveState = 'saved';
  const subs = new Set<(s: SaveState) => void>();

  const set = (s: SaveState) => {
    if (s === current) return;
    current = s;
    for (const fn of subs) fn(s);
  };

  const run = async (): Promise<void> => {
    if (timer) clearTimeout(timer);
    timer = null;
    if (running) {
      await running;
      if (!pending) return;
    }
    if (!pending) return;
    pending = false;
    firstPendingAt = 0;
    set('saving');
    running = (async () => {
      try {
        const snap = take();
        if (snap) await writeSnapshot(key, snap);
        set(pending ? 'pending' : 'saved');
      } catch (e) {
        pending = true;
        set('error');
        console.error('[persist] snapshot failed', e);
      }
    })();
    try {
      await running;
    } finally {
      running = null;
    }
    // Writes that arrived during the flush get their own.
    if (pending) schedule();
  };

  const schedule = () => {
    pending = true;
    if (current !== 'saving') set('pending');
    const now = Date.now();
    if (!firstPendingAt) firstPendingAt = now;
    if (timer) clearTimeout(timer);
    const wait = Math.max(0, Math.min(debounceMs, firstPendingAt + maxDelayMs - now));
    timer = setTimeout(() => void run(), wait);
  };

  return {
    schedule,
    flushNow: run,
    state: () => current,
    subscribe(fn) {
      subs.add(fn);
      return () => subs.delete(fn);
    },
  };
}

/** Flush every registered flusher when the page is hidden or about to unload. */
export function flushOnHide(flushers: Flusher[]): void {
  if (typeof document === 'undefined') return;
  const all = () => void Promise.all(flushers.map((f) => f.flushNow()));
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') all();
  });
  window.addEventListener('pagehide', all);
}

// ── Single tab, persistence ───────────────────────────────────────────────

/**
 * Hold the database lock for the life of the page. Resolves false when another
 * tab already holds it. Browsers without Web Locks get true (no way to tell).
 */
export function acquireTabLock(name = 'gloria-db'): Promise<boolean> {
  if (!('locks' in navigator)) return Promise.resolve(true);
  return new Promise((resolve) => {
    void navigator.locks.request(name, { ifAvailable: true }, (lock) => {
      if (!lock) {
        resolve(false);
        return undefined;
      }
      resolve(true);
      // Never settles: the lock is released when the page goes away.
      return new Promise<void>(() => {});
    });
  });
}

export type StorageStatus = { persisted: boolean | null; usage: number | null; quota: number | null };

export async function requestPersistence(): Promise<boolean | null> {
  if (!navigator.storage?.persist) return null;
  try {
    if (await navigator.storage.persisted()) return true;
    return await navigator.storage.persist();
  } catch {
    return null;
  }
}

export async function storageStatus(): Promise<StorageStatus> {
  const s = navigator.storage;
  const persisted = s?.persisted ? await s.persisted().catch(() => null) : null;
  const est = s?.estimate ? await s.estimate().catch(() => null) : null;
  return { persisted, usage: est?.usage ?? null, quota: est?.quota ?? null };
}
