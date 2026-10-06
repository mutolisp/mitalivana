/**
 * App-owned media file names inside a stored reference. Pure.
 *
 * A column may hold a plain URI, a JSON array of URIs, or JSON objects with a
 * `uri` field (GLORIA overview photos). App-owned files live under photos/ or
 * audio/; only their NAME is compared, because the absolute path changes on
 * reinstall (appFiles.ts). Photo-library references (ph://…) are not app
 * files and yield nothing.
 */
const NAME_RE = /(?:^|\/)(?:photos|audio|files)\/([^/"'\s\\,\]}]+)/g;

export function mediaNamesIn(value: string): string[] {
  const out: string[] = [];
  for (const m of value.matchAll(NAME_RE)) {
    let name = m[1];
    try {
      name = decodeURIComponent(name);
    } catch {
      // A literal % in a file name: keep it as stored.
    }
    out.push(name);
  }
  return out;
}

/**
 * Every column that stores photo / audio references (plain URI, JSON array or
 * JSON objects). The one list both the orphan scan and the "is this file still
 * used" check read — `check:storage` fails when the schema gains a column that
 * looks like media and is neither here nor in NOT_MEDIA.
 */
export const MEDIA_COLUMNS: ReadonlyArray<readonly [table: string, column: string]> = [
  ['checklist_records', 'photo_paths'],
  ['checklist_records', 'audio_paths'],
  ['plot_species_records', 'photo_paths'],
  ['plot_species_records', 'audio_paths'],
  ['collection_specimens', 'photo_paths'],
  ['collection_specimens', 'audio_paths'],
  ['plot_surveys', 'env_photos_json'],
  ['photo_fix', 'uri'],
  ['gloria_units', 'photo_paths'],
  // Fixed-plot 1×1 m quadrats (v77).
  ['plot_quadrats', 'photo_paths'],
  // Survey framework (v80): one file per row.
  ['fw_media', 'uri'],
  // A permanent plot's morphospecies photo (v83).
  ['fw_frame_labels', 'photo_uri'],
  ['gloria_points', 'photo_m2'],
  ['gloria_points', 'photo_m2f'],
  ['gloria_points', 'photo_point'],
  ['gloria_surveys', 'overview_photos'],
  ['gloria_photo_checks', 'photo_uri'],
  // Temperature loggers (v65): position photos and attached files (Documents/files/).
  ['gloria_loggers', 'photo_open_uri'],
  ['gloria_loggers', 'photo_closed_uri'],
  ['gloria_loggers', 'data_files'],
  ['gloria_logger_visits', 'form4_files'],
  // Scans of the paper forms 1, 2, 3, 6-S (v69).
  ['gloria_surveys', 'form1_files'],
  ['gloria_surveys', 'form2_files'],
  ['gloria_surveys', 'form3_files'],
  ['gloria_surveys', 'form6s_files'],
  // MIREN (v68): plot photos.
  ['miren_plots', 'photo_paths'],
  // Casual mode's observations awaiting a name (v92); they move to the record when named.
  ['pending_observations', 'photo_paths'],
  ['pending_observations', 'audio_paths'],
];

/** Media-looking column names that hold no file reference, and why. */
export const NOT_MEDIA: Readonly<Record<string, string>> = {
  'checklist_records.inat_media_done': 'iNat upload progress counter',
  'plot_species_records.inat_media_done': 'iNat upload progress counter',
  'collection_specimens.inat_media_done': 'iNat upload progress counter',
  'pending_observations.inat_media_done': 'iNat upload progress counter',
  'gloria_loggers.photo_open': 'Form 4 photo check tick (1 / null); the photo is photo_open_uri',
  'gloria_loggers.photo_closed': 'Form 4 photo check tick (1 / null); the photo is photo_closed_uri',
  'miren_sites.photo_point': 'where the repeat photo is taken from (coordinates), not a photo',
  'media_hash.uri': 'hash cache of files sent or received by team sync (v72); the record columns hold the references, and a cached path whose file is gone is skipped',
};
