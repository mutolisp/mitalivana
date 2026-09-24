/**
 * Collection (採集) round-trip import — the yml half.
 *
 * Reads the document emitted by `buildCollectionYamlDoc`: an `event:` block in
 * DwC camelCase, a top-level `project` / `site:`, and a `specimens:` array of
 * DwC occurrence items. Produces an `ImportedCollectionTrip` for
 * `importCollectionTrip` (src/db/collections.ts).
 *
 * Pure, like `sessionImport.ts` and `plotImport.ts` — no DB, no i18n, no file
 * IO — so `check:roundtrip` can drive the real parser.
 *
 * Collections were the one record type that exported but could not be brought
 * back: the reader threw `unsupportedCollection` outright. That made every
 * collection export a one-way trip, including the app's own backups of it.
 *
 * ## The shape is the specimen's, not the record's
 *
 * A specimen is not a checklist row with extra columns. `recordNumber` is the
 * collector's number and the label's identity, `identifiedBy`/`dateIdentified`
 * describe a determination that is often not the collector's and often later,
 * and `duplicate_count` counts sheets. None of those exist on a session
 * record, which is why this is its own parser rather than a flag on
 * `sessionFromDoc`.
 */
import yaml from 'js-yaml';

import { ImportError } from './importError';
import { num, parseSiteBlock, pipeToJson, pipeToList, str } from './plotImport';
import type { ImportedCollectionTrip, ImportedSpecimen } from '~/db';

/**
 * ISO-8601 (with local offset, as `localIso` writes it) → epoch ms.
 *
 * Same tolerance as `sessionImport.isoToMs`, and for the same reason: YAML 1.1
 * has a timestamp type, so an unquoted date comes back from js-yaml already
 * parsed, while our own dump quotes it. Both forms are in the wild.
 */
function isoToMs(v: unknown): number | null {
  if (v instanceof Date) return Number.isFinite(v.getTime()) ? v.getTime() : null;
  if (typeof v === 'number' && Number.isFinite(v)) return v; // tolerate raw ms
  if (typeof v !== 'string' || !v) return null;
  const ms = Date.parse(v);
  return Number.isFinite(ms) ? ms : null;
}

/** `specimens:` is what tells a collection document apart from a session one —
 *  both carry an `event:` block. Exported for `docKind` in recordImportZip. */
export function isCollectionDoc(doc: Record<string, unknown> | null): boolean {
  return Array.isArray(doc?.specimens);
}

export function parseCollectionYaml(text: string): ImportedCollectionTrip {
  return collectionFromDoc(yaml.load(text) as Record<string, unknown> | null);
}

export function collectionFromDoc(
  doc: Record<string, unknown> | null,
): ImportedCollectionTrip {
  const ev = (doc?.event ?? null) as Record<string, unknown> | null;
  const specimens = Array.isArray(doc?.specimens)
    ? (doc!.specimens as Record<string, unknown>[])
    : null;
  if (!doc || (!ev && !specimens)) throw new ImportError('invalidYml');

  const name = str(ev?.eventID) ?? str(doc.project) ?? '';
  if (!name) throw new ImportError('missingFields');

  const startedAt = isoToMs(ev?.startedAt) ?? isoToMs(ev?.eventDate) ?? Date.now();

  const rows: ImportedSpecimen[] = (specimens ?? [])
    .map((s) => ({
      occurrence_id: str(s.occurrenceID),
      taxon_id: String(s.taxonID ?? ''),
      name: str(s.scientificName),
      family: str(s.family),
      // The collector's number is the specimen's identity on the label. A
      // blank one is tolerated rather than fatal — `importCollectionTrip`
      // mints the next in the series, which is better than dropping the row.
      record_number: str(s.recordNumber),
      collected_at: isoToMs(s.eventDate),
      recorded_by: str(s.recordedBy),
      identified_by: str(s.identifiedBy),
      date_identified: str(s.dateIdentified),
      lat: num(s.decimalLatitude),
      lng: num(s.decimalLongitude),
      accuracy: num(s.coordinateUncertaintyInMeters),
      locality: str(s.locality),
      sex: str(s.sex),
      life_stage: str(s.lifeStage),
      reproductive_condition: pipeToJson(s.reproductiveCondition),
      leaf_phenology: pipeToJson(s.leafPhenology),
      degree_of_establishment: str(s.degreeOfEstablishment),
      verbatim_identification: str(s.verbatimIdentification),
      // Keeps its own snake_case key in the yml — DwC has no term for it (see
      // dwcMapper). `num` rather than truthiness so a recorded 0 survives.
      duplicate_count: num(s.duplicate_count),
      institution_code: str(s.institutionCode),
      other_catalog_numbers: str(s.otherCatalogNumbers),
      catalog_number: str(s.catalogNumber),
      elevation_m: num(s.minimumElevationInMeters),
      notes: str(s.occurrenceRemarks),
      photo_files: pipeToList(s.associatedMedia),
      // Kept out of associatedMedia so the clips return to audio_paths rather
      // than being mixed into the photo column.
      audio_files: pipeToList(s.audio_files),
      // Name usage: `scientificName` already holds the adopted name, so the id
      // is a hint and the string is the durable half.
      used_name_id: num(s.scientificNameID),
      used_scientific_name: s.taxonomicStatus ? str(s.scientificName) : null,
    }))
    .filter((s) => s.taxon_id);

  return {
    // Pre-uuid exports carry none; the caller mints one (import as new).
    uuid: str(ev?.eventUUID) ?? '',
    name,
    project_name: str(doc.project),
    started_at: startedAt,
    ended_at: isoToMs(ev?.endedAt),
    recorded_by: str(ev?.recordedBy),
    locality: str(ev?.locality),
    institution_code: str(ev?.institutionCode),
    notes: str(ev?.eventRemarks),
    site: parseSiteBlock(doc.site),
    specimens: rows,
  };
}
