/**
 * 名錄模組登錄表：一個邏輯資料集（臺灣名錄 / 日本名錄 / 臺灣檢索表）對應一個
 * 可獨立下載、更新、刪除的 SQLite 檔。
 *
 * 分成兩層是刻意的：
 *   - **spec**（編譯期）：這個模組「是什麼」——擁有哪個 taxon_id 前綴、有哪些
 *     表、scope 條件長什麼樣。程式必須認得，所以是 union 而不是純資料。
 *   - **install record**（執行期）：檔案「現在在哪」。過渡期三個邏輯模組可以
 *     同時指向同一個 `twnamelist.db`，所以 handle 快取以**檔案**為鍵而不是以
 *     模組為鍵——那個檔只會被開一次。
 *
 * ## 三條必須守住的規則
 *
 * 1. **`open()` 對不存在的檔案會靜默建立空 DB。** op-sqlite 用
 *    `SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE`（cpp/bridge.cpp:96），所以
 *    「模組沒安裝」不會回錯誤，而是給你一個空資料庫，等到查詢才炸
 *    `no such table`，還留下一個空檔讓下次對帳誤判成已安裝。因此這裡**一律先
 *    確認檔案存在才 open**（`poiLocation()` 用的是同一招）。
 * 2. **模組是唯讀內容**：開檔後補 `PRAGMA query_only = ON`。實測全 repo 沒有
 *    任何一處寫入名錄 DB，這道防呆讓日後誤寫立刻爆，而不是默默改掉一個隨時
 *    會被整包覆蓋的檔。
 * 3. **原生模組只在函式內碰**（`open` / `File` / `Directory` / `Paths` 都走
 *    `nativeXxx()` 惰性取得）。`scripts/check-*.mjs` 會在 Node 下直接 import
 *    TS 模組，那裡沒有 op-sqlite 也沒有 expo-file-system；頂層碰原生等於讓
 *    所有檢查腳本在載入期就壞掉。`configureDatasetOpener()` 是給那些腳本用的
 *    測試縫。
 */
import type { DB } from '@op-engineering/op-sqlite';
import type { RegionCode } from '~/stores/settings';

export type DatasetId = 'tw-taicol' | 'jp-ylist' | 'tw-keys';

/** 名錄模組提供的表。`scopeClause` 逐字沿用 `taxonomy.ts` 原本的 scope 條件。 */
export type NamesTables = {
  kind: 'names';
  names: string;
  fuzzyIndex: string | null;
  /** 舊版模組可能沒有 `pinyin` 欄，載入端仍要自己探測（見 fuzzy.ts）。 */
  fuzzyHasPinyin: boolean;
  /** 跨區對照表；模組只帶自己 region 的列。 */
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
  /** 這個模組擁有的 taxon_id 前綴；檢索表模組沒有自己的 taxon。 */
  idPrefix: 't' | 'y' | null;
  /** 對應的區域；檢索表跟著 `requires` 的名錄模組走。 */
  region: RegionCode | null;
  /** 必須同時可用的模組。tw-keys 的 lead target 全是 `t…`，單獨存在沒有意義。 */
  requires: DatasetId[];
  defaultFile: string;
  tables: NamesTables | KeysTables;
};

/** `datasets/installed.json` 的一列。 */
export type DatasetInstall = {
  id: DatasetId;
  /** 'datasets' = 自己的目錄；'documents' = 過渡期共用的舊 bundle 檔。 */
  location: 'datasets' | 'documents';
  file: string;
  /** manifest 版本；過渡期的舊檔記成 `legacy:<asset hash>`。 */
  version: string;
  bytes: number;
  installedAt: number;
  /** 與這一筆共用同一個檔的其他模組（過渡期才會非空）。 */
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

/** 名錄模組的顯示順序 = 合併時的優先序（TaiCOL 勝過 YList，與 idPreference 一致）。 */
const NAME_DATASET_ORDER: DatasetId[] = ['tw-taicol', 'jp-ylist'];

export const DATASETS_DIR = 'datasets';
const INSTALL_FILE = 'installed.json';
/** 過渡期的合併檔：三個模組都還住在裡面。 */
const LEGACY_FILE = 'twnamelist.db';
const LEGACY_VERSION_FILE = 'twnamelist.db.version';

export function getSpec(id: DatasetId): DatasetSpec {
  return SPECS[id];
}

export function allSpecs(): DatasetSpec[] {
  return [SPECS['tw-taicol'], SPECS['jp-ylist'], SPECS['tw-keys']];
}

// ── 原生模組的惰性取得（見檔頭規則 3） ──────────────────────────────────────

type Opener = (params: { name: string; location: string }) => DB;
let opener: Opener | null = null;

/** 測試縫：讓 Node 下的檢查腳本塞一個 `node:sqlite` 的 adapter 進來。 */
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

/** 測試縫，與 `configureDatasetOpener` 成對：Node 下沒有 expo-file-system。 */
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

// ── 檔案位置 ────────────────────────────────────────────────────────────────

/** `Documents/datasets/`。建立時順便標記不進 OS 備份——與 `ensureVectorRoot`
 *  同樣**每次呼叫都標**，否則在原生模組出貨前就安裝的使用者永遠補不到。 */
export function ensureDatasetsDir(): InstanceType<FsModule['Directory']> {
  const { Directory, Paths } = fs();
  const dir = new Directory(Paths.document, DATASETS_DIR);
  if (!dir.exists) dir.create({ intermediates: true });
  try {
    // 惰性 require（規則 3）：這個 wrapper 會 import expo-modules-core，
    // 頂層 import 會讓 Node 下的檢查腳本在載入期就壞掉。
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('../../modules/backup-exclusion') as {
      excludeFromBackup?: (uri: string) => boolean;
    };
    mod.excludeFromBackup?.(dir.uri);
  } catch {
    // 原生模組缺席（Android / 尚未重建的 dev client）時不是錯誤
  }
  return dir;
}

/** 某一筆安裝紀錄對應的實際檔案。不建立任何東西。 */
function installFile(rec: DatasetInstall): InstanceType<FsModule['File']> {
  const { Directory, File, Paths } = fs();
  if (rec.location === 'documents') return new File(Paths.document, rec.file);
  const dir = new Directory(new Directory(Paths.document, DATASETS_DIR), rec.id);
  return new File(dir, rec.file);
}

// ── 安裝清單 ────────────────────────────────────────────────────────────────

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
      // 對帳：檔案不在就不算安裝（Android 清除資料、iOS 清理、安裝中斷）。
      if (!installFile(rec).exists) continue;
      out.set(rec.id, {
        ...rec,
        sharedWith: Array.isArray(rec.sharedWith) ? rec.sharedWith : [],
      });
    }
  } catch {
    // 壞掉的清單等同「什麼都沒裝」，下載頁會重新提供安裝
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
    // 寫不進去不該讓查詢失敗；下次啟動會重新對帳
  }
}

/** 讀入（或重讀）安裝清單。`initDb()` 在 migrations 之前呼叫。 */
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
 * 過渡期：把既有的 `Documents/twnamelist.db` 註冊成三個模組共用的一個檔。
 *
 * 只在還沒有任何安裝紀錄、而舊檔存在時跑一次，並且**只認檔案裡真的有的表**
 * ——沒有 `jp_names` 的舊版（0.4.x）就只會註冊 TW 與檢索表，誠實地落在
 * 「日本名錄未安裝」。這段在 §9 步驟 6 拆掉內建時會被「備份名稱快取 → 刪舊檔
 * → 下載精靈」取代。
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
    for (const row of (res.rows ?? []) as Array<{ name?: string }>) {
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

export function markDatasetInstalled(rec: DatasetInstall): void {
  state().set(rec.id, rec);
  writeInstalls();
  invalidateDatasetCaches();
}

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
