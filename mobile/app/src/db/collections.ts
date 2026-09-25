/**
 * Specimen collecting: a collection trip groups the specimens gathered on one
 * outing, mirroring how `sessions` groups `checklist_records`.
 *
 * ⚠️ Collections deliberately sit OUTSIDE the app-wide single-active invariant.
 * `status` here is collection-local — it only decides which trip an "add to
 * collection" lands in. Nothing in this file touches `sessions` or
 * `plot_surveys`, so starting or reopening a trip never ends an active checklist
 * or plot survey. See `recordCreate.ensureNoConflictingActive` for the invariant
 * that governs those two.
 */
import { getUserDb, withTransaction } from './init';
import { ensureTaxonSelfSufficient } from './taxonCache';
import { retaxonRecord } from './retaxon';
import type { DuplicateRecordOptions } from './duplicate';
import { existingProjectId, resolveProjectIdByName } from './projects';
import { generateUuid } from './plots';
import { createSite, deleteSiteIfUnreferenced, type ImportedSite } from './sites';
import { defaultIdentifierString, defaultSurveyorString } from './surveyors';
import { isoDate } from '~/lib/datetime';
import {
  resolveTaxa,
  EMPTY_TAXON_FIELDS,
  applyAdoptedName,
  resolveAdoptedNames,
  type AdoptionInput,
  type AdoptionStatus,
  type TaxonFields,
} from './taxonLookup';

export type CollectionTrip = {
  id: number;
  uuid: string;
  name: string;
  project_id: number;
  /** Collection-local only — never gates a session/plot. */
  status: 'active' | 'done';
  started_at: number;
  ended_at: number | null;
  /** DwC recordedBy — comma-separated collector names. Inherited by specimens. */
  recorded_by: string | null;
  locality: string | null;
  /** Geographic site this trip is pinned to (v43), or NULL. Mirrors
   *  `sessions.site_id`; no FK, so deleting a site leaves the trip intact. */
  site_id: number | null;
  /** DwC institutionCode — the herbarium this trip's sheets are destined for
   *  (v43). Specimens inherit it unless they set their own. */
  institution_code: string | null;
  notes: string | null;
  created_at: number;
  updated_at: number;
  /** Starred (v34): 0 / 1. Sorts the record above its peers in the list.
   *  Device-local organisation, deliberately not exported. */
  starred: number;
};

export type CollectionTripWithStats = CollectionTrip & {
  specimen_count: number;
  project_name: string;
};

export type Specimen = {
  id: number;
  trip_id: number;
  /** DwC occurrenceID — stable v4 uuid assigned at insert. */
  occurrence_id: string;
  /** Last time the user changed this specimen's content (v32). iNat
   *  bookkeeping writes in `inatSync.ts` deliberately do not count. */
  updated_at: number;
  taxon_id: string;
  /** DwC recordNumber — the collector's number, prefix included. Editable. */
  record_number: string;
  /** Numeric tail of `record_number`, or null when the user typed a
   *  non-numeric one. Drives `nextRecordNumber`. */
  record_number_seq: number | null;
  collected_at: number;
  recorded_by: string | null;
  /** DwC identifiedBy — who determined the name, which is often not the
   *  collector. NULL on specimens recorded before v26. */
  identified_by: string | null;
  date_identified: string | null; // DwC dateIdentified, YYYY-MM-DD
  lat: number | null;
  lng: number | null;
  /** GNSS horizontal accuracy in metres → DwC coordinateUncertaintyInMeters. */
  accuracy: number | null;
  locality: string | null;
  /** DwC degreeOfEstablishment (v33): 'wild' | 'captive' | 'cultivated'.
   *  NULL = not recorded, which is a different statement from an explicit
   *  'wild'. Per-INDIVIDUAL — not to be confused with the taxon-level
   *  `alien_type`. */
  /** DwC verbatimIdentification (v39) — the determination as written in the
   *  field when it is finer than the taxon can express (`sp1` / `sp2` under a
   *  family or genus). NULL = none. */
  verbatim_identification: string | null;
  degree_of_establishment: string | null;
  // DwC species attributes (v20 for sex/life_stage, v19 for the phenology
  // pair). Single-valued enums; the two phenology columns are JSON array
  // strings — see dwcAttributes parse/serializeMultiAttribute.
  sex: string | null;
  life_stage: string | null;
  reproductive_condition: string | null;
  leaf_phenology: string | null;
  /** How many duplicate sheets were taken (v43). NULL = not recorded, which
   *  is a different statement from 1. A count, not a child table: in the field
   *  you know you took three, not which herbaria they will end up in. */
  duplicate_count: number | null;
  /** DwC institutionCode (v43). NULL = inherit the trip's. */
  institution_code: string | null;
  /** DwC otherCatalogNumbers (v43) — free text, whatever numbering the
   *  receiving herbarium or a prior database used. */
  other_catalog_numbers: string | null;
  /** DwC catalogNumber (v44) — the herbarium accession number of this sheet. */
  catalog_number: string | null;
  /** Collecting altitude in metres (v44) → DwC min/maximumElevationInMeters. */
  elevation_m: number | null;
  /** 'gnss' | 'manual' | null (v46) → DwC verticalDatum; see dwcLocation.ts. */
  elevation_source: string | null;
  notes: string | null;
  photo_paths: string | null;
  /** The name this specimen was deliberately determined as (v28). Both NULL =
   *  the taxon's accepted name. */
  used_name_id: number | null;
  used_scientific_name: string | null;
  /** Recorded audio clips (v29) — JSON array of file:// URIs under
   *  documentDirectory/audio/. Same shape as `photo_paths`. */
  audio_paths: string | null;
  /** iNaturalist upload state (v30). See migrations.ts v30 for the contract. */
  inat_observation_id: number | null;
  inat_media_done: number;
  inat_uploaded_at: number | null;
  /** Fingerprint of what iNat last received (v31); see inatPayload.syncFingerprint. */
  inat_sync_hash: string | null;
};

export type SpecimenWithTaxon = Specimen & TaxonFields & AdoptionStatus;

const SPECIMEN_COLS = `id, trip_id, occurrence_id, taxon_id, record_number, record_number_seq,
  collected_at, recorded_by, identified_by, date_identified, lat, lng, accuracy, locality,
  sex, life_stage, reproductive_condition, leaf_phenology, degree_of_establishment,
  verbatim_identification, duplicate_count, institution_code, other_catalog_numbers,
  catalog_number, elevation_m, elevation_source, notes, photo_paths,
  used_name_id, used_scientific_name,
  audio_paths, inat_observation_id, inat_media_done, inat_uploaded_at, inat_sync_hash,
  updated_at`;

function defaultTripName(now: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
}

// ─────────────────────────────── trips ───────────────────────────────

export function listCollectionTrips(): CollectionTripWithStats[] {
  const db = getUserDb();
  const res = db.executeSync(`
    SELECT c.*,
           p.name AS project_name,
           (SELECT COUNT(*) FROM collection_specimens s WHERE s.trip_id = c.id) AS specimen_count
    FROM collection_trips c
    -- LEFT JOIN for the same reason as listSites / listPlotSurveysWithMeta.
    LEFT JOIN projects p ON p.id = c.project_id
    ORDER BY c.started_at DESC
  `);
  return ((res.rows ?? []) as unknown) as CollectionTripWithStats[];
}

export function getCollectionTrip(id: number): CollectionTrip | null {
  const db = getUserDb();
  const res = db.executeSync(`SELECT * FROM collection_trips WHERE id = ?`, [id]);
  return ((res.rows ?? []) as unknown as CollectionTrip[])[0] ?? null;
}

/** The trip an "add to collection" lands in, or null when none is open. */
export function getActiveCollectionTrip(): CollectionTrip | null {
  const db = getUserDb();
  const res = db.executeSync(
    `SELECT * FROM collection_trips WHERE status = 'active' ORDER BY started_at DESC LIMIT 1`,
  );
  return ((res.rows ?? []) as unknown as CollectionTrip[])[0] ?? null;
}

export type CreateTripInput = {
  name?: string;
  project_id?: number;
  locality?: string | null;
  /** Omit to auto-fill from default surveyors; pass null to force empty. */
  recorded_by?: string | null;
};

export function createCollectionTrip(input: CreateTripInput = {}): number {
  const db = getUserDb();
  const now = Date.now();
  // Only one OPEN trip at a time, so "加入採集" has an unambiguous target.
  // Scoped to collection_trips on purpose — see the file header.
  db.executeSync(
    `UPDATE collection_trips SET status = 'done', ended_at = COALESCE(ended_at, ?), updated_at = ? WHERE status = 'active'`,
    [now, now],
  );
  const res = db.executeSync(
    `INSERT INTO collection_trips
       (uuid, name, project_id, status, started_at, recorded_by, locality, created_at, updated_at)
     VALUES (?, ?, ?, 'active', ?, ?, ?, ?, ?)`,
    [
      generateUuid(),
      input.name ?? defaultTripName(),
      input.project_id ?? 0,
      now,
      input.recorded_by !== undefined ? input.recorded_by : defaultSurveyorString(),
      input.locality ?? null,
      now,
      now,
    ],
  );
  return res.insertId ?? 0;
}

/**
 * `endTs`: the end time the user chose (src/lib/endTimeChoice) — a time, or
 * null to leave it blank. Omitted (automatic endings): keep an existing time,
 * otherwise now.
 */
export function endCollectionTrip(id: number, endTs?: number | null): void {
  const db = getUserDb();
  const now = Date.now();
  db.executeSync(
    endTs === undefined
      ? `UPDATE collection_trips SET status = 'done', ended_at = COALESCE(ended_at, ?), updated_at = ? WHERE id = ?`
      : `UPDATE collection_trips SET status = 'done', ended_at = ?, updated_at = ? WHERE id = ?`,
    [endTs === undefined ? now : endTs, now, id],
  );
}

export function reopenCollectionTrip(id: number): void {
  const db = getUserDb();
  const now = Date.now();
  db.executeSync(
    `UPDATE collection_trips SET status = 'done', ended_at = COALESCE(ended_at, ?), updated_at = ? WHERE status = 'active' AND id != ?`,
    [now, now, id],
  );
  db.executeSync(
    // The end time stays: finishing again asks whether to keep it or use now.
    `UPDATE collection_trips SET status = 'active', updated_at = ? WHERE id = ?`,
    [now, id],
  );
}

const TRIP_UPDATABLE_KEYS = new Set([
  'name', 'project_id', 'recorded_by', 'locality', 'site_id', 'institution_code', 'notes',
]);

export function updateCollectionTrip(id: number, patch: Partial<CollectionTrip>): void {
  const db = getUserDb();
  const fields: string[] = [];
  const params: (string | number | null)[] = [];
  for (const [k, v] of Object.entries(patch)) {
    if (!TRIP_UPDATABLE_KEYS.has(k)) continue;
    fields.push(`${k} = ?`);
    params.push(v as string | number | null);
  }
  if (fields.length === 0) return;
  fields.push('updated_at = ?');
  params.push(Date.now(), id);
  db.executeSync(`UPDATE collection_trips SET ${fields.join(', ')} WHERE id = ?`, params);
}

export function deleteCollectionTrip(id: number): void {
  const db = getUserDb();
  // 子列在 schema 裡都宣告了 ON DELETE CASCADE，而 FK 強制已於 initDb() 末尾開啟
  // （src/db/init.ts，per-connection、整個 session 有效），所以那些 cascade 現在確實
  // 會觸發，以下手動刪除在正常路徑上是冗餘的。保留是刻意的 belt-and-braces：delete
  // helper 不該依賴呼叫當下的 PRAGMA 狀態，漏刪的下場是看不見卻仍佔用編號的孤兒列。
  // 採集標本尤其要緊：殘留的列仍會被 maxRecordNumberSeq() 與 isRecordNumberTaken()
  // 算進去，導致採集號一直往上跳、也無法重設回來。
  db.executeSync(`DELETE FROM collection_specimens WHERE trip_id = ?`, [id]);
  db.executeSync(`DELETE FROM collection_trips WHERE id = ?`, [id]);
}

// ───────────────────────── collection numbers ─────────────────────────

/** Read a settings row directly so the DB layer stays decoupled from the React
 *  store — same approach as `regions.getEnabledRegions`. */
function readSetting(key: string): string | null {
  try {
    const res = getUserDb().executeSync(`SELECT value FROM settings WHERE key = ? LIMIT 1`, [key]);
    return ((res.rows ?? [])[0] as { value?: string } | undefined)?.value ?? null;
  } catch {
    return null;
  }
}

/** Trailing digits of a collection number, e.g. "CTL-1042" → 1042. */
export function recordNumberSeq(text: string): number | null {
  const m = text.trim().match(/(\d+)\s*$/);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isSafeInteger(n) ? n : null;
}

/**
 * Is this collection number already on another specimen?
 *
 * Checked against the full text (prefix included) and globally, because the
 * series spans trips — `CTL-1042` means one physical gathering no matter which
 * outing it came from. `excludeId` skips the specimen being edited so re-saving
 * an unchanged number doesn't flag itself.
 */
export function isRecordNumberTaken(text: string, excludeId?: number): boolean {
  const value = text.trim();
  if (!value) return false;
  const db = getUserDb();
  const res =
    excludeId === undefined
      ? db.executeSync(`SELECT 1 FROM collection_specimens WHERE record_number = ? LIMIT 1`, [value])
      : db.executeSync(
          `SELECT 1 FROM collection_specimens WHERE record_number = ? AND id != ? LIMIT 1`,
          [value, excludeId],
        );
  return (res.rows?.length ?? 0) > 0;
}

/** Numbers currently carried by more than one specimen, for the ⚠ badge.
 *  One grouped query per reload rather than a per-row lookup. */
export function duplicateRecordNumbers(): Set<string> {
  const db = getUserDb();
  const res = db.executeSync(
    `SELECT record_number FROM collection_specimens
      GROUP BY record_number HAVING COUNT(*) > 1`,
  );
  const out = new Set<string>();
  for (const row of (res.rows ?? []) as Array<{ record_number?: string }>) {
    if (row.record_number) out.add(row.record_number);
  }
  return out;
}

/** Hard stop for the scan below. Only reachable with pathological data (tens of
 *  thousands of consecutive numbers already taken); returning the last candidate
 *  is better than hanging the UI thread. */
const MAX_NUMBER_SCAN = 10000;

/**
 * Next free collection number in the collector's global series.
 *
 * Derived from the highest number actually stored rather than a saved cursor,
 * so deleting or importing specimens can't leave the counter drifting. The
 * configured start acts as a floor, which is what lets someone resume an
 * existing career series (set start = 1042 on a fresh install).
 *
 * Occupied numbers are skipped, so every automatic path (new specimen,
 * duplicate, import) is collision-free by construction — a hand-typed number is
 * the only way to create a duplicate, and that path warns.
 */
/** 目前資料庫中最大的採集序號；尚無記錄時回傳 0。 */
export function maxRecordNumberSeq(): number {
  const db = getUserDb();
  const res = db.executeSync(`SELECT MAX(record_number_seq) AS m FROM collection_specimens`);
  return Number((res.rows?.[0] as { m?: number | null })?.m ?? 0);
}

/**
 * 依目前的前綴與補零設定，把序號格式化成完整採集號。
 *
 * 補零位數 0 是合法值（不補零），所以不能用 or-fallback 取預設值 —— 那會把
 * 使用者刻意設的 0 換成 4。位數不足時 padStart 是 no-op，序號超過設定位數
 * 會自然變長而不會被截斷。
 */
export function formatRecordNumber(seq: number): string {
  const prefix = readSetting('collection_number_prefix') ?? '';
  const rawPad = readSetting('collection_number_pad');
  const padNum = Math.floor(Number(rawPad));
  const pad = rawPad != null && Number.isFinite(padNum) && padNum >= 0 ? padNum : 4;
  return `${prefix}${String(seq).padStart(pad, '0')}`;
}

export function nextRecordNumber(): { text: string; seq: number } {
  const maxSeq = maxRecordNumberSeq();
  const start = Number(readSetting('collection_number_start') ?? '1') || 1;

  let seq = Math.max(maxSeq + 1, start);
  for (let i = 0; i < MAX_NUMBER_SCAN && isRecordNumberTaken(formatRecordNumber(seq)); i++) {
    seq += 1;
  }
  return { text: formatRecordNumber(seq), seq };
}

// ───────────────────────────── specimens ─────────────────────────────

export function listSpecimens(tripId: number): SpecimenWithTaxon[] {
  const db = getUserDb();
  const res = db.executeSync(
    `SELECT ${SPECIMEN_COLS} FROM collection_specimens WHERE trip_id = ? ORDER BY collected_at ASC, id ASC`,
    [tripId],
  );
  const rows = (res.rows ?? []) as unknown as Specimen[];
  if (rows.length === 0) return [];
  const taxa = resolveTaxa(rows.map((r) => r.taxon_id));
  const adopted = resolveAdoptedNames(rows);
  return rows.map((r) => ({
    ...r,
    ...applyAdoptedName(taxa.get(r.taxon_id) ?? EMPTY_TAXON_FIELDS, r, adopted),
  }));
}

export function getSpecimen(id: number): SpecimenWithTaxon | null {
  const db = getUserDb();
  const res = db.executeSync(`SELECT ${SPECIMEN_COLS} FROM collection_specimens WHERE id = ?`, [id]);
  const row = ((res.rows ?? []) as unknown as Specimen[])[0];
  if (!row) return null;
  const taxa = resolveTaxa([row.taxon_id]);
  const adopted = resolveAdoptedNames([row]);
  return {
    ...row,
    ...applyAdoptedName(taxa.get(row.taxon_id) ?? EMPTY_TAXON_FIELDS, row, adopted),
  };
}

export type AddSpecimenInput = {
  trip_id: number;
  taxon_id: string;
  /** Set only when the user deliberately chose a non-accepted name (v28). */
  adopted?: AdoptionInput | null;
  /** Omit to take the next number in the series. */
  record_number?: string;
  collected_at?: number;
  /** Omit to inherit the trip's collectors. */
  recorded_by?: string | null;
  /** Omit to take the default determiner from settings. */
  identified_by?: string | null;
  lat?: number | null;
  lng?: number | null;
  accuracy?: number | null;
  elevation_m?: number | null;
  /** Where `elevation_m` came from; defaults to 'manual' when it is set. */
  elevation_source?: 'gnss' | 'manual' | null;
  locality?: string | null;
  notes?: string | null;
  /** How many duplicate sheets. Omit = not recorded. */
  duplicate_count?: number | null;
  /** Omit to inherit the trip's herbarium. */
  institution_code?: string | null;
  other_catalog_numbers?: string | null;
};

export function addSpecimen(input: AddSpecimenInput): number {
  ensureTaxonSelfSufficient(input.taxon_id);
  const db = getUserDb();
  const now = Date.now();
  const number = input.record_number ?? nextRecordNumber().text;
  // Two fields inherit from the trip, so the lookup happens when EITHER is
  // left unspecified rather than only for the collector.
  const needsTrip = input.recorded_by === undefined || input.institution_code === undefined;
  const trip = needsTrip ? getCollectionTrip(input.trip_id) : null;
  const res = db.executeSync(
    `INSERT INTO collection_specimens
       (trip_id, occurrence_id, taxon_id, record_number, record_number_seq,
        collected_at, recorded_by, identified_by, date_identified,
        lat, lng, accuracy, elevation_m, elevation_source, locality, notes,
        duplicate_count, institution_code, other_catalog_numbers,
        used_name_id, used_scientific_name, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      input.trip_id,
      generateUuid(),
      input.taxon_id,
      number,
      recordNumberSeq(number),
      input.collected_at ?? now,
      input.recorded_by !== undefined ? input.recorded_by : (trip?.recorded_by ?? null),
      // Same shape as the collector above: an explicit value (including null)
      // wins, otherwise the starred names from the identifier list.
      input.identified_by !== undefined
        ? input.identified_by
        : defaultIdentifierString(),
      // Determination date travels with the determiner — a determiner with no
      // date says nothing about whether this is the original call or a later
      // revision. Uses the collection date, not "now": for a specimen entered
      // in the field they are the same moment, and for one entered afterwards
      // the field determination is what the label should carry.
      isoDate(input.collected_at ?? now),
      input.lat ?? null,
      input.lng ?? null,
      input.accuracy ?? null,
      input.elevation_m ?? null,
      input.elevation_m != null ? (input.elevation_source ?? 'manual') : null,
      input.locality ?? null,
      input.notes ?? null,
      input.duplicate_count ?? null,
      // Same shape as the collector: an explicit value (including null) wins,
      // otherwise the trip's default herbarium.
      input.institution_code !== undefined
        ? input.institution_code
        : (trip?.institution_code ?? null),
      input.other_catalog_numbers ?? null,
      input.adopted?.name_id ?? null,
      input.adopted?.scientific_name ?? null,
      now,
      now,
    ],
  );
  return res.insertId ?? 0;
}

// `taxon_id` is deliberately NOT here: re-identifying has to write the adoption
// pair in the same statement and copy the incoming taxon into the local caches,
// so it goes through `updateSpecimenTaxon`. Leaving it in this whitelist left a
// trap that carried the previous determination's adopted name onto the new one.
const SPECIMEN_UPDATABLE_KEYS = new Set([
  'record_number', 'collected_at', 'recorded_by', 'identified_by', 'date_identified',
  'lat', 'lng', 'accuracy',
  'locality', 'sex', 'life_stage', 'reproductive_condition', 'leaf_phenology',
  'degree_of_establishment', 'verbatim_identification',
  'duplicate_count', 'institution_code', 'other_catalog_numbers', 'catalog_number',
  'elevation_m', 'elevation_source', 'notes',
]);

export function updateSpecimen(id: number, patch: Partial<Specimen>): void {
  const db = getUserDb();
  const fields: string[] = [];
  const params: (string | number | null)[] = [];
  for (const [k, v] of Object.entries(patch)) {
    if (!SPECIMEN_UPDATABLE_KEYS.has(k)) continue;
    fields.push(`${k} = ?`);
    params.push(v as string | number | null);
    // Keep the numeric tail in sync so the series continues from a hand-edit.
    if (k === 'record_number') {
      fields.push('record_number_seq = ?');
      params.push(recordNumberSeq(String(v ?? '')));
    }
  }
  if (fields.length === 0) return;
  fields.push('updated_at = ?');
  params.push(Date.now(), id);
  db.executeSync(`UPDATE collection_specimens SET ${fields.join(', ')} WHERE id = ?`, params);
}

/**
 * Re-determine a specimen: swap the taxon, keep the gathering.
 *
 * Separate from `updateSpecimen` even though its whitelist allows `taxon_id`:
 * a bare patch leaves the adoption columns pointing at the previous name and
 * never copies the new taxon into external_taxa / taxon_name_cache.
 *
 * `occurrence_id` is deliberately untouched: it identifies the observation, not
 * the determination. The adoption columns ARE rewritten — they record the name
 * the record was filed under, so after a re-identification the old pair
 * describes a name no longer on the record. No `adopted` clears them, which is
 * correct for a plain accepted name.
 */
export function updateSpecimenTaxon(
  id: number,
  taxonId: string,
  adopted?: AdoptionInput | null,
): void {
  retaxonRecord('collection', id, taxonId, adopted);
  // A new determination is a new determiner and a new date. Leaving
  // `identified_by` on the previous person is not a display glitch — it is a
  // false attribution that ships in the exported record and on the herbarium
  // label. So the determination columns move together with the name.
  //
  // Automatic, not a prompt: in the field this happens while holding the
  // specimen, and an extra sheet per re-identification is the kind of friction
  // that makes people stop correcting names. A wrong determiner is editable on
  // the detail page; an uncorrected name is not visible at all.
  //
  // No default identifier set → NULL, which is honest. It does not inherit the
  // stale value, because "unknown determiner" is true and "the previous one"
  // is false.
  getUserDb().executeSync(
    `UPDATE collection_specimens SET identified_by = ?, date_identified = ? WHERE id = ?`,
    [defaultIdentifierString(), isoDate(Date.now()), id],
  );
}

export function updateSpecimenLocation(
  id: number,
  lat: number | null,
  lng: number | null,
  accuracy: number | null = null,
): void {
  const db = getUserDb();
  db.executeSync(
    `UPDATE collection_specimens SET lat = ?, lng = ?, accuracy = ?, updated_at = ? WHERE id = ?`,
    [lat, lng, accuracy, Date.now(), id],
  );
}

export function updateSpecimenPhotos(id: number, paths: string[]): void {
  const db = getUserDb();
  const value = paths.length > 0 ? JSON.stringify(paths) : null;
  db.executeSync(`UPDATE collection_specimens SET photo_paths = ?, updated_at = ? WHERE id = ?`, [value, Date.now(), id]);
}

export function updateSpecimenAudio(id: number, paths: string[]): void {
  const db = getUserDb();
  const value = paths.length > 0 ? JSON.stringify(paths) : null;
  db.executeSync(`UPDATE collection_specimens SET audio_paths = ?, updated_at = ? WHERE id = ?`, [value, Date.now(), id]);
}

/**
 * Start a second gathering of the same taxon — the swipe-left 複製 action.
 *
 * Carries the species and the collector only. Locality, coordinates, phenology,
 * notes and photos are deliberately left blank: they describe one physical
 * gathering, and silently inheriting them would attach the previous specimen's
 * description to a different plant. Number and time take their defaults (next
 * free number, now).
 *
 * Returns the new specimen's id, or null if the source is gone.
 */
export function duplicateSpecimen(id: number): number | null {
  const source = getSpecimen(id);
  if (!source) return null;
  return addSpecimen({
    trip_id: source.trip_id,
    taxon_id: source.taxon_id,
    recorded_by: source.recorded_by,
  });
}

export function deleteSpecimen(id: number): void {
  const db = getUserDb();
  db.executeSync(`DELETE FROM collection_specimens WHERE id = ?`, [id]);
}

// ── 複製採集記錄 ────────────────────────────────────────────────────────────

/**
 * Copy a collection trip as the next outing.
 *
 * `opts.includeSpecies` is deliberately IGNORED here, and the UI hides the
 * switch for 採集: a specimen is a physical gathering that owns a number from
 * the collector's career series, and `nextRecordNumber()` derives that series
 * from the rows actually stored. Pre-creating a trip's worth of specimens
 * would burn that many real numbers on gatherings nobody made, and they can
 * never be reclaimed. `duplicateSpecimen` burning ONE number is a different
 * act — there, a second gathering really happened.
 *
 * Trips sit outside the app-wide single-active invariant, so `activate` closes
 * other open TRIPS only and never touches a session or plot survey.
 */
export function duplicateCollectionTrip(
  id: number,
  opts: DuplicateRecordOptions,
): number | null {
  return withTransaction(() => duplicateCollectionTripTx(id, opts));
}

function duplicateCollectionTripTx(id: number, opts: DuplicateRecordOptions): number | null {
  const source = getCollectionTrip(id);
  if (!source) return null;
  const name = opts.name.trim();
  if (!name) return null;
  const db = getUserDb();
  const now = Date.now();

  if (opts.activate) {
    // Only one OPEN trip at a time, so 「加入採集」 has an unambiguous target.
    db.executeSync(
      `UPDATE collection_trips SET status = 'done', ended_at = COALESCE(ended_at, ?), updated_at = ? WHERE status = 'active'`,
      [now, now],
    );
  }

  const res = db.executeSync(
    `INSERT INTO collection_trips
       (uuid, name, project_id, status, started_at, ended_at, recorded_by, locality, notes, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      generateUuid(),
      name,
      existingProjectId(source.project_id),
      opts.activate ? 'active' : 'done',
      now,
      opts.activate ? null : now,
      source.recorded_by,
      opts.includeEnv ? source.locality : null,
      opts.includeEnv ? source.notes : null,
      now,
      now,
    ],
  );
  const newId = res.insertId ?? 0;
  if (newId === 0) return null;

  return newId;
}

// ───────────────────────── round-trip import ─────────────────────────

/** One specimen as it comes out of a yml. Everything is optional because an
 *  export from an older build simply has fewer keys. */
export type ImportedSpecimen = {
  occurrence_id: string | null;
  taxon_id: string;
  name?: string | null;
  family?: string | null;
  record_number?: string | null;
  collected_at?: number | null;
  recorded_by?: string | null;
  identified_by?: string | null;
  date_identified?: string | null;
  lat?: number | null;
  lng?: number | null;
  accuracy?: number | null;
  locality?: string | null;
  sex?: string | null;
  life_stage?: string | null;
  reproductive_condition?: string | null;
  leaf_phenology?: string | null;
  degree_of_establishment?: string | null;
  verbatim_identification?: string | null;
  duplicate_count?: number | null;
  institution_code?: string | null;
  other_catalog_numbers?: string | null;
  catalog_number?: string | null;
  elevation_m?: number | null;
  elevation_source?: string | null;
  notes?: string | null;
  photo_files?: string[];
  audio_files?: string[];
  used_name_id?: number | null;
  used_scientific_name?: string | null;
};

export type ImportedCollectionTrip = {
  uuid: string;
  name: string;
  project_name?: string | null;
  started_at: number;
  ended_at?: number | null;
  recorded_by?: string | null;
  locality?: string | null;
  institution_code?: string | null;
  notes?: string | null;
  site?: ImportedSite | null;
  specimens: ImportedSpecimen[];
};

export function getCollectionTripByUuid(uuid: string): CollectionTrip | null {
  const res = getUserDb().executeSync(`SELECT * FROM collection_trips WHERE uuid = ? LIMIT 1`, [
    uuid,
  ]);
  return ((res.rows ?? []) as unknown as CollectionTrip[])[0] ?? null;
}

export function importCollectionTrip(
  data: ImportedCollectionTrip,
  opts: {
    newUuid: boolean;
    photoUriByName?: Map<string, string>;
    audioUriByName?: Map<string, string>;
  },
): { tripId: number; name: string } {
  // Overwrite deletes the previous copy first, so the whole thing has to be
  // atomic — same reasoning as importSession / importPlotSurvey.
  return withTransaction(() => importCollectionTripTx(data, opts));
}

function importCollectionTripTx(
  data: ImportedCollectionTrip,
  opts: {
    newUuid: boolean;
    photoUriByName?: Map<string, string>;
    audioUriByName?: Map<string, string>;
  },
): { tripId: number; name: string } {
  const db = getUserDb();
  const now = Date.now();
  const uuid = opts.newUuid ? generateUuid() : data.uuid;

  const resolveMedia = (
    files: string[] | undefined,
    byName: Map<string, string> | undefined,
  ): string | null => {
    const uris = (files ?? [])
      .map((f) => byName?.get(f) ?? null)
      .filter((u): u is string => u !== null);
    return uris.length > 0 ? JSON.stringify(uris) : null;
  };

  let prevSiteId: number | null = null;
  if (!opts.newUuid) {
    const prev = getCollectionTripByUuid(uuid);
    if (prev) {
      if (prev.site_id !== null) prevSiteId = prev.site_id;
      deleteCollectionTrip(prev.id);
    }
  }

  const projectId = resolveProjectIdByName(data.project_name, { create: true });

  // An imported trip is always finished. `status` is collection-local and does
  // not gate the app-wide single-active invariant, but an import that arrived
  // as 'active' would still hijack every later "add to collection".
  // A blank end time is kept blank (v54: finished no longer needs one).
  const endedAt = data.ended_at ?? null;

  const res = db.executeSync(
    `INSERT INTO collection_trips (
       uuid, name, project_id, status, started_at, ended_at,
       recorded_by, locality, institution_code, notes, created_at, updated_at
     ) VALUES (?, ?, ?, 'done', ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      uuid,
      data.name,
      projectId,
      data.started_at,
      endedAt,
      data.recorded_by ?? null,
      data.locality ?? null,
      data.institution_code ?? null,
      data.notes ?? null,
      now,
      now,
    ],
  );
  const tripId = res.insertId ?? 0;
  if (tripId === 0) throw new Error('importCollectionTrip: insert failed');

  for (const sp of data.specimens) {
    // The taxon has to survive without the dataset module that produced it,
    // exactly as `addSpecimen` ensures for a hand-entered one.
    ensureTaxonSelfSufficient(sp.taxon_id);
    // A blank collector's number is filled from the series rather than left
    // empty: `record_number` is NOT NULL, and a specimen with no number is
    // useless on a label.
    const number = sp.record_number?.trim() || nextRecordNumber().text;
    db.executeSync(
      `INSERT INTO collection_specimens (
         trip_id, occurrence_id, taxon_id, record_number, record_number_seq,
         collected_at, recorded_by, identified_by, date_identified,
         lat, lng, accuracy, locality, sex, life_stage,
         reproductive_condition, leaf_phenology, degree_of_establishment,
         verbatim_identification, duplicate_count, institution_code,
         other_catalog_numbers, catalog_number, elevation_m, elevation_source, notes, photo_paths,
         audio_paths, used_name_id, used_scientific_name, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        tripId,
        // Import-as-new means new occurrences, as in importSession: the same
        // occurrenceID on two rows would make the copy indistinguishable from
        // the original everywhere downstream (iNat, DwC, photo binding).
        opts.newUuid ? generateUuid() : (sp.occurrence_id ?? generateUuid()),
        sp.taxon_id,
        number,
        recordNumberSeq(number),
        sp.collected_at ?? data.started_at,
        sp.recorded_by ?? null,
        sp.identified_by ?? null,
        sp.date_identified ?? null,
        sp.lat ?? null,
        sp.lng ?? null,
        sp.accuracy ?? null,
        sp.locality ?? null,
        sp.sex ?? null,
        sp.life_stage ?? null,
        sp.reproductive_condition ?? null,
        sp.leaf_phenology ?? null,
        sp.degree_of_establishment ?? null,
        sp.verbatim_identification ?? null,
        sp.duplicate_count ?? null,
        sp.institution_code ?? null,
        sp.other_catalog_numbers ?? null,
        sp.catalog_number ?? null,
        sp.elevation_m ?? null,
        sp.elevation_source ?? null,
        sp.notes ?? null,
        resolveMedia(sp.photo_files, opts.photoUriByName),
        resolveMedia(sp.audio_files, opts.audioUriByName),
        sp.used_name_id ?? null,
        sp.used_scientific_name ?? null,
        now,
        now,
      ],
    );
  }

  if (data.site) {
    const siteId = createSite({
      project_id: projectId,
      name: data.site.name,
      geometry: data.site.geometry,
      notes: data.site.notes,
    });
    db.executeSync(`UPDATE collection_trips SET site_id = ? WHERE id = ?`, [siteId, tripId]);
  }
  if (prevSiteId !== null) deleteSiteIfUnreferenced(prevSiteId);

  return { tripId, name: data.name };
}
