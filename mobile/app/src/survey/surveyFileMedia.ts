/**
 * The photos and recordings of a survey file (Phase 2E-a) written to this
 * device, and the document pointing at them (export/surveyExportCore.ts
 * docFromFile). A file names its media; a merge backup or a record version of
 * this device names paths, kept when the file is still here.
 */
import { getUserDb } from '~/db/init';
import { importAudioClips } from '~/lib/audioCapture';
import type { Row } from '~/lib/mergeEngine';
import { importPhotosToLibrary } from '~/lib/photoCapture';
import type { ImportedPhotoBlob } from '~/lib/recordImportZip';
import { fileHere, putBackSurveyMedia, type SurveyDoc } from './db/surveyDocs';
import { docFromFile } from './export/surveyExportCore';

/** Write the media the document names (those `wanted`) and return it pointing at them; rows whose file is missing go. */
export async function writeSurveyFiles(
  doc: SurveyDoc,
  photos: readonly ImportedPhotoBlob[],
  audio: readonly ImportedPhotoBlob[],
  wanted: (m: Row) => boolean = () => true,
): Promise<{ doc: SurveyDoc; skipped: number }> {
  const want = new Set([...doc.media.filter(wanted).map((m) => m.file), ...doc.frame_labels.map((l) => l.photo_file)].filter((f): f is string => typeof f === 'string'));
  const { uriByName, skipped } = await importPhotosToLibrary(photos.filter((p) => want.has(p.name)));
  const clips = await importAudioClips(audio.filter((a) => want.has(a.name)));
  return { doc: docFromFile(doc, (file, kind) => (kind === 'audio' ? clips.get(file) : uriByName.get(file)) ?? null, fileHere), skipped };
}

/** After a merge: the file's photos and recordings not here yet, added where their unit or occurrence now is. */
export async function addSurveyFileMedia(surveyId: number, doc: SurveyDoc, photos: readonly ImportedPhotoBlob[], audio: readonly ImportedPhotoBlob[]): Promise<number> {
  const here = new Set(((getUserDb().executeSync(`SELECT uuid FROM fw_media WHERE survey_id = ?`, [surveyId]).rows ?? []) as { uuid: string }[]).map((r) => r.uuid));
  const { doc: local } = await writeSurveyFiles(doc, photos, audio, (m) => !here.has(String(m.uuid)));
  return putBackSurveyMedia(surveyId, local);
}
