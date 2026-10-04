/**
 * An occurrence of a checklist-style survey in the shape 快速名錄's species
 * card and detail sheet read (2G-c): the same columns under the same names
 * (fw_occurrences follows checklist_records), its photos and recordings as
 * the JSON lists a record keeps, and no iNaturalist link (a survey is not
 * uploaded record by record).
 */
import type { RecordWithTaxon } from '~/db';
import type { OccurrenceView } from './useSurveyForm';

export function occurrenceRecord(o: OccurrenceView): RecordWithTaxon {
  return {
    ...o,
    session_id: o.survey_id,
    occurrence_id: o.uuid,
    photo_paths: o.photos.length ? JSON.stringify(o.photos) : null,
    audio_paths: o.audio.length ? JSON.stringify(o.audio) : null,
    inat_observation_id: null,
    inat_media_done: 0,
    inat_uploaded_at: null,
    inat_sync_hash: null,
  };
}
