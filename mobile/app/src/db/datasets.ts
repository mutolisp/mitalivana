/**
 * Registry of checklist modules: one logical dataset (Taiwan checklist / Japan
 * checklist / Taiwan identification keys) per SQLite file that can be
 * downloaded, updated and deleted on its own.
 *
 * The two layers are deliberate:
 *   - **spec** (compile time): what the module *is* — which taxon_id prefix it
 *     owns, which tables it has, what its scope clause looks like. The code has
 *     to know these, so it is a union rather than plain data.
 *   - **install record** (runtime): where the file *currently is*. During the
 *     transition all three logical modules can point at the same
 *     `twnamelist.db`, so the handle cache is keyed by **file**, not by module —
 *     that file is opened exactly once.
 *
 * ## Three rules that must hold
 *
 * 1. **`open()` silently creates an empty DB for a missing file.** op-sqlite
 *    uses `SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE` (cpp/bridge.cpp:96), so
 *    "module not installed" does not come back as an error: you get an empty
 *    database that only blows up at query time with `no such table`, and it
 *    leaves an empty file behind for the next reconciliation to mistake for an
 *    install. So this module **always confirms the file exists before opening**
 *    (`poiLocation()` uses the same trick).
 * 2. **Modules are read-only content**: `PRAGMA query_only = ON` right after
 *    opening. Nothing in the whole repo writes to a checklist DB, and this
 *    guard makes a future accidental write fail loudly instead of quietly
 *    editing a file that can be replaced wholesale at any time.
 * 3. **Native modules are touched inside function bodies only** (`open` /
 *    `File` / `Directory` / `Paths` all go through lazy `nativeXxx()`).
 *    `scripts/check-*.mjs` import the TS modules directly under Node, where
 *    neither op-sqlite nor expo-file-system exists; touching a native module at
 *    the top level would break every check script at load time.
 *    `configureDatasetOpener()` is the test seam for those scripts.
 */
import type { DB } from '@op-engineering/op-sqlite';
import type { RegionCode } from '~/stores/settings';

export type DatasetId = 'tw-taicol' | 'jp-ylist' | 'tw-keys';

/** Tables a checklist module provides. `scopeClause` is the scope condition
 *  carried over verbatim from `taxonomy.ts`. */
export type NamesTables = {
  kind: 'names';
  names: string;
  fuzzyIndex: string | null;
  /** Older modules may not have the `pinyin` column, so the loader still probes
 *  for it (see fuzzy.ts). */
  fuzzyHasPinyin: boolean;
  /** Cross-region crosswalk; a module only carries rows for its own region. */
  xref: string | null;
  scopeClause: string;
};

export type KeysTables = {
  kind: 'keys';
  keys: 'identification_keys';
  couplets: 'key_couplets';
  features: 'key_features';
  taxonFeatures: 'key_taxon_features';
};

export type DatasetSpec = {
  id: DatasetId;
  /** The taxon_id prefix this module owns; the keys module has no taxa of its
 *  own. */
  idPrefix: 't' | 'y' | null;
  /** The region it belongs to; keys follow the checklist module in `requires`. */
  region: RegionCode | null;
  /** Modules that must be available alongside it. Every tw-keys lead target is a
 *  `t…`, so it is meaningless on its own. */
  requires: DatasetId[];
  defaultFile: string;
  tables: NamesTables | KeysTables;
};

/** One row of `datasets/installed.json`. */
export type DatasetInstall = {
  id: DatasetId;
  /** 'datasets' = its own directory; 'documents' = the shared legacy bundle file
 *  during the transition. */
  location: 'datasets' | 'documents';
  file: string;
  /** Manifest version; a legacy file from the transition is recorded as
 *  `legacy:<asset hash>`. */
  version: string;
  bytes: number;
  installedAt: number;
  /** Other modules sharing this same file (only non-empty during the
 *  transition). */
  sharedWith: DatasetId[];
};

const SPECS: Record<DatasetId, DatasetSpec> = {
  'tw-taicol': {
    id: 'tw-taicol',
    idPrefix: 't',
    region: 'TW',
    requires: [],
    defaultFile: 'tw-taicol.db',
    tables: {
      kind: 'names',
      names: 'taicol_names',
      fuzzyIndex: 'cname_fuzzy_index',
      fuzzyHasPinyin: true,
      xref: 'species_xref',
      scopeClause: "is_in_taiwan LIKE '%true%'",
    },
  },
  'jp-ylist': {
    id: 'jp-ylist',
    idPrefix: 'y',
    region: 'JP',
    requires: [],
    defaultFile: 'jp-ylist.db',
    tables: {
      kind: 'names',
      names: 'jp_names',
      fuzzyIndex: 'cname_fuzzy_index_jp',
      fuzzyHasPinyin: false,
      xref: 'species_xref',
      scopeClause: "region='JP'",
    },
  },
  'tw-keys': {
    id: 'tw-keys',
    idPrefix: null,
    region: null,
    requires: ['tw-taicol'],
    defaultFile: 'tw-keys.db',
    tables: {
      kind: 'keys',
      keys: 'identification_keys',
      couplets: 'key_couplets',
      features: 'key_features',
      taxonFeatures: 'key_taxon_features',
    },
  },
};

/** Display order of the checklist modules = merge precedence (TaiCOL beats
 *  YList, matching idPreference). */
const NAME_DATASET_ORDER: DatasetId[] = ['tw-taicol', 'jp-ylist'];

export const DATASETS_DIR = 'datasets';
const INSTALL_FILE = 'installed.json';
/** The merged legacy file: all three modules still live inside it. */
const LEGACY_FILE = 'twnamelist.db';
const LEGACY_VERSION_FILE = 'twnamelist.db.version';

export function getSpec(id: DatasetId): DatasetSpec {
  return SPECS[id];
}

export function allSpecs(): DatasetSpec[] {
  return [SPECS['tw-taicol'], SPECS['jp-ylist'], SPECS['tw-keys']];
}

// ── Lazy access to native modules (see rule 3 in the file header) ──────────

type Opener = (params: { name: string; location: string }) => DB;
let opener: Opener | null = null;

/** Test seam: lets a check script under Node inject a `node:sqlite` adapter. */
export function configureDatasetOpener(fn: Opener | null): void {
  opener = fn;
  closeAllDatasetDbs();
}

function nativeOpen(name: string, location: string): DB {
  if (!opener) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    opener = (require('@op-engineering/op-sqlite') as { open: Opener }).open;
  }
  return opener({ name, location });
}

type FsModule = typeof import('expo-file-system');
let fsModule: FsModule | null = null;

/** Test seam, paired with `configureDatasetOpener`: there is no
 *  expo-file-system under Node. */
export function configureDatasetFs(mod: FsModule | null): void {
  fsModule = mod;
  installs = null;
  closeAllDatasetDbs();
}

function fs(): FsModule {
  if (!fsModule) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    fsModule = require('expo-file-system') as FsModule;
  }
  return fsModule;
}

// ── File locations ────────────────────────────────────────────────────────

/** `Documents/datasets/`. Marked as excluded from OS backup while being
 *  created — **on every call**, like `ensureVectorRoot`, or anyone who installed
 *  before the native module shipped would never get the flag. */
export function ensureDatasetsDir(): InstanceType<FsModule['Directory']> {
  const { Directory, Paths } = fs();
  const dir = new Directory(Paths.document, DATASETS_DIR);
  if (!dir.exists) dir.create({ intermediates: true });
  try {
    // Lazy require (rule 3): this wrapper imports expo-modules-core, and a
    // top-level import would break the Node check scripts at load time.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('../../modules/backup-exclusion') as {
      excludeFromBackup?: (uri: string) => boolean;
    };
    mod.excludeFromBackup?.(dir.uri);
  } catch {
    // A missing native module (Android, or a dev client not yet rebuilt) is not an
    // error.
  }
  return dir;
}

/** The actual file an install record points at. Creates nothing. */
function installFile(rec: DatasetInstall): InstanceType<FsModule['File']> {
  const { Directory, File, Paths } = fs();
  if (rec.location === 'documents') return new File(Paths.document, rec.file);
  const dir = new Directory(new Directory(Paths.document, DATASETS_DIR), rec.id);
  return new File(dir, rec.file);
}

// ── Install list ──────────────────────────────────────────────────────────

let installs: Map<DatasetId, DatasetInstall> | null = null;

function installsFile(): InstanceType<FsModule['File']> {
  const { Directory, File, Paths } = fs();
  return new File(new Directory(Paths.document, DATASETS_DIR), INSTALL_FILE);
}

function readInstalls(): Map<DatasetId, DatasetInstall> {
  const out = new Map<DatasetId, DatasetInstall>();
  try {
    const f = installsFile();
    if (!f.exists) return out;
    const parsed = JSON.parse(f.textSync()) as unknown;
    if (!Array.isArray(parsed)) return out;
    for (const raw of parsed) {
      const rec = raw as DatasetInstall;
      if (!rec || typeof rec.id !== 'string' || !(rec.id in SPECS)) continue;
      // Reconcile: no file means not installed (Android clear-data, iOS cleanup, an
      // interrupted install).
      if (!installFile(rec).exists) continue;
      out.set(rec.id, {
        ...rec,
        sharedWith: Array.isArray(rec.sharedWith) ? rec.sharedWith : [],
      });
    }
  } catch {
    // A corrupt list counts as "nothing installed"; the download screen will offer
    // to install again.
  }
  return out;
}

function writeInstalls(): void {
  try {
    ensureDatasetsDir();
    const f = installsFile();
    if (f.exists) f.delete();
    f.write(JSON.stringify([...(installs ?? new Map()).values()], null, 2));
  } catch {
    // Failing to write must not fail a query; the next launch reconciles again.
  }
}

/** Load (or reload) the install list. `initDb()` calls this before migrations. */
export function loadDatasetManifest(): void {
  installs = readInstalls();
}

function state(): Map<DatasetId, DatasetInstall> {
  if (!installs) installs = readInstalls();
  return installs;
}

export function getInstall(id: DatasetId): DatasetInstall | null {
  return state().get(id) ?? null;
}

export function isInstalled(id: DatasetId): boolean {
  return state().has(id);
}

/**
 * Transition: register the existing `Documents/twnamelist.db` as one file shared
 * by all three modules.
 *
 * Runs once, only when there is no install record yet and the legacy file
 * exists, and **only counts tables the file actually has** — a 0.4.x file
 * without `jp_names` registers TW and the keys alone and honestly lands on
 * "Japan checklist not installed". Step 6 of §9 replaces this with "cache the
 * names → delete the legacy file → download wizard" when the bundled DB is
 * removed.
 */
export function adoptLegacyBundle(): void {
  const current = state();
  if (current.size > 0) return;

  const { File, Paths } = fs();
  const legacy = new File(Paths.document, LEGACY_FILE);
  if (!legacy.exists) return;

  let version = 'legacy';
  try {
    const vf = new File(Paths.document, LEGACY_VERSION_FILE);
    if (vf.exists) version = `legacy:${(vf.textSync() ?? '').trim()}`;
  } catch {
    // 版本檔讀不到不影響採用，只是版本字串較不精確
  }

  const db = openFileHandle(LEGACY_FILE, dirUri(Paths.document.uri));
  if (!db) return;
  const present = new Set<string>();
  try {
    const res = db.executeSync(`SELECT name FROM sqlite_master WHERE type IN ('table','view')`);
    for (const row of (res.rows ?? []) as { name?: string }[]) {
      if (row.name) present.add(row.name);
    }
  } catch {
    return;
  }

  const adopted: DatasetId[] = [];
  for (const spec of allSpecs()) {
    const probe =
      spec.tables.kind === 'names' ? spec.tables.names : spec.tables.keys;
    if (present.has(probe)) adopted.push(spec.id);
  }
  if (adopted.length === 0) return;

  const bytes = legacy.size ?? 0;
  const now = Date.now();
  for (const id of adopted) {
    current.set(id, {
      id,
      location: 'documents',
      file: LEGACY_FILE,
      version,
      bytes,
      installedAt: now,
      sharedWith: adopted.filter((other) => other !== id),
    });
  }
  writeInstalls();
}

// ── handle 快取（以檔案為鍵） ───────────────────────────────────────────────

const handles = new Map<string, DB>();
const handleOwners = new Map<string, Set<DatasetId>>();

function dirUri(uri: string): string {
  return uri.replace(/\/$/, '');
}

function fileKeyOf(rec: DatasetInstall): { key: string; name: string; location: string } {
  const { Directory, Paths } = fs();
  const location =
    rec.location === 'documents'
      ? dirUri(Paths.document.uri)
      : dirUri(new Directory(new Directory(Paths.document, DATASETS_DIR), rec.id).uri);
  return { key: `${location}/${rec.file}`, name: rec.file, location };
}

/** 真正開檔。**檔案不存在就回 null**，絕不讓 op-sqlite 生出空 DB（規則 1）。 */
function openFileHandle(name: string, location: string): DB | null {
  const key = `${location}/${name}`;
  const cached = handles.get(key);
  if (cached) return cached;

  const { File } = fs();
  const f = new File(`${location}/${name}`);
  if (!f.exists) return null;

  let db: DB;
  try {
    db = nativeOpen(name, location);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn(`[datasets] open failed for ${name}:`, e);
    return null;
  }
  try {
    // 名錄模組一律唯讀（規則 2）
    db.executeSync('PRAGMA query_only = ON;');
  } catch {
    // 舊版 SQLite 不支援時不是致命錯誤
  }
  handles.set(key, db);
  return db;
}

/**
 * 取得某個模組的 handle。**永不 throw**：沒安裝、檔案不見、開檔失敗一律回
 * `null`，呼叫端必須寫明沒有資料時要怎麼辦。
 */
export function getDatasetDb(id: DatasetId): DB | null {
  const rec = state().get(id);
  if (!rec) return null;
  const { key, name, location } = fileKeyOf(rec);
  const db = openFileHandle(name, location);
  if (!db) {
    // 檔案被刪了：把紀錄也清掉，UI 才會回到「未安裝」
    state().delete(id);
    writeInstalls();
    return null;
  }
  let owners = handleOwners.get(key);
  if (!owners) {
    owners = new Set();
    handleOwners.set(key, owners);
  }
  owners.add(id);
  return db;
}

/** 關掉某個模組的 handle；同一個檔還有其他模組在用就只是退訂。 */
export function closeDatasetDb(id: DatasetId): void {
  const rec = state().get(id);
  if (!rec) return;
  const { key } = fileKeyOf(rec);
  const owners = handleOwners.get(key);
  owners?.delete(id);
  if (owners && owners.size > 0) return;
  handles.get(key)?.close();
  handles.delete(key);
  handleOwners.delete(key);
}

export function closeAllDatasetDbs(): void {
  for (const db of handles.values()) {
    try {
      db.close();
    } catch {
      // 已經關掉的 handle 不必在意
    }
  }
  handles.clear();
  handleOwners.clear();
}

// ── 可用性 ──────────────────────────────────────────────────────────────────

/**
 * 「可用」= 已安裝 ∧ 相依模組都在 ∧（沒有 region 或該 region 已啟用）。
 *
 * region 的啟用狀態由 `regions.ts` 提供，這裡用 late import 避免 import cycle
 * （regions.ts 反過來會用本檔的 `datasetForTaxonId`）。
 */
export function isAvailable(id: DatasetId): boolean {
  if (!isInstalled(id)) return false;
  const spec = SPECS[id];
  for (const need of spec.requires) {
    if (!isInstalled(need)) return false;
  }
  if (spec.region && !regionRequested(spec.region)) return false;
  return true;
}

let regionReader: ((region: RegionCode) => boolean) | null = null;

/** `regions.ts` 在載入時註冊，避免兩個模組互相 import。 */
export function configureRegionReader(fn: (region: RegionCode) => boolean): void {
  regionReader = fn;
}

function regionRequested(region: RegionCode): boolean {
  return regionReader ? regionReader(region) : true;
}

/** 已可用的名錄模組，TaiCOL 優先——這個順序就是合併時的優先序。 */
export function availableNameDatasets(): DatasetSpec[] {
  return NAME_DATASET_ORDER.filter((id) => isAvailable(id)).map((id) => SPECS[id]);
}

export function hasAnyNamesDataset(): boolean {
  return NAME_DATASET_ORDER.some((id) => isInstalled(id));
}

/** 已安裝且該 region 有名錄模組的區域。 */
export function installedRegions(): RegionCode[] {
  const out: RegionCode[] = [];
  for (const id of NAME_DATASET_ORDER) {
    const region = SPECS[id].region;
    if (region && isInstalled(id)) out.push(region);
  }
  return out;
}

/** taxon_id 前綴 → 擁有它的模組。`g…`（外部／pack）與未知前綴回 null。 */
export function datasetForTaxonId(taxonId: string): DatasetSpec | null {
  const prefix = taxonId.charAt(0);
  if (!prefix) return null;
  for (const id of NAME_DATASET_ORDER) {
    if (SPECS[id].idPrefix === prefix) return SPECS[id];
  }
  return null;
}

/** 快取鍵：模組集合或版本一變，分類樹 / 搜尋快取就必須失效。 */
export function datasetScopeSig(): string {
  return allSpecs()
    .filter((spec) => isAvailable(spec.id))
    .map((spec) => `${spec.id}@${state().get(spec.id)?.version ?? '?'}`)
    .join(',');
}

// ── 變更通知 ────────────────────────────────────────────────────────────────

const invalidators = new Set<() => void>();

/** 由各快取持有者註冊（fuzzy index、分類樹、檢索表清單、搜尋結果…）。 */
export function onDatasetsChanged(fn: () => void): void {
  invalidators.add(fn);
}

/** 安裝 / 更新 / 刪除模組後，把所有由內容衍生的快取一次清掉。 */
export function invalidateDatasetCaches(): void {
  for (const fn of invalidators) {
    try {
      fn();
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn('[datasets] cache invalidator failed:', e);
    }
  }
}

// ── 安裝 / 更新 / 刪除 ──────────────────────────────────────────────────────

/**
 * 把暫存檔換成某個模組的正式檔。
 *
 * 換檔前一定要先關掉指向該檔的 handle 並清 journal sidecar，否則會撞上
 * "database disk image is malformed"（`backup.ts` 換 user.db 時的同一套順序）。
 * 若該模組原本與別人共用一個檔（過渡期的 bundle），這裡只把自己搬走，其餘模組
 * 仍指向舊檔；等最後一個搬完，`removeLegacyBundleIfUnused()` 才會刪掉它。
 */
export function replaceDataset(
  id: DatasetId,
  stagedPath: string,
  version: string,
  bytes: number,
): void {
  const { Directory, File, Paths } = fs();
  closeDatasetDb(id);

  const dir = new Directory(new Directory(Paths.document, DATASETS_DIR), id);
  if (!dir.exists) dir.create({ intermediates: true });
  ensureDatasetsDir();

  const target = new File(dir, SPECS[id].defaultFile);
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    const f = new File(dir, `${SPECS[id].defaultFile}${suffix}`);
    if (f.exists) f.delete();
  }
  new File(stagedPath).move(target);

  const previous = state().get(id);
  state().set(id, {
    id,
    location: 'datasets',
    file: SPECS[id].defaultFile,
    version,
    bytes,
    installedAt: Date.now(),
    sharedWith: [],
  });
  // 從舊的共用檔上退訂，讓最後一個離開的人可以把它刪掉
  if (previous && previous.sharedWith.length > 0) {
    for (const other of previous.sharedWith) {
      const rec = state().get(other);
      if (rec) rec.sharedWith = rec.sharedWith.filter((x) => x !== id);
    }
  }
  writeInstalls();
  invalidateDatasetCaches();
}

/** 刪除一個模組的檔案與紀錄。呼叫端負責在此之前備份記錄用到的名稱。 */
export function removeDataset(id: DatasetId): void {
  const rec = state().get(id);
  if (!rec) return;
  closeDatasetDb(id);

  // 共用檔（過渡期）只退訂，不刪檔——別的模組還在用
  if (rec.sharedWith.length === 0) {
    const { File } = fs();
    const { location } = fileKeyOf(rec);
    for (const suffix of ['', '-wal', '-shm', '-journal']) {
      const f = new File(`${location}/${rec.file}${suffix}`);
      if (f.exists) f.delete();
    }
  } else {
    for (const other of rec.sharedWith) {
      const peer = state().get(other);
      if (peer) peer.sharedWith = peer.sharedWith.filter((x) => x !== id);
    }
  }
  state().delete(id);
  writeInstalls();
  invalidateDatasetCaches();
}
