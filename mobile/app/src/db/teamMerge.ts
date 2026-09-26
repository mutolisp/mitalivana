/**
 * Team merge, DB half, for checklists (sessions) and plot surveys: this
 * device's side of a record, and writing the reviewed ops back.
 * GLORIA has its own in src/modules/gloria/merge.ts.
 *
 * This device's side is built exactly as an export would be (same builders,
 * dumped to yml and parsed back) so it hashes like the sender's file does.
 *
 * Writes only touch the rows the ops name. The record keeps its id, status,
 * project, site, lock and active state — merging into the record in progress
 * leaves it in progress (single-active untouched).
 */
import yaml from 'js-yaml';
import { buildPlotYamlDoc, buildSessionYamlDoc } from '~/lib/bundleYaml';
import type { MergeOp, Row } from '~/lib/mergeEngine';
import { plotFromDoc } from '~/lib/plotImport';
import { sessionFromDoc } from '~/lib/sessionImport';
import { getUserDb, withTransaction } from './init';
import {
  getPlotLayers,
  getPlotSurvey,
  getSubplotLayers,
  LAYERS,
  listPlotSpecies,
  listSubplots,
  TRANSECT_LAYER,
  type ImportedPlot,
  type Layer,
} from './plots';
import { getProject } from './projects';
import { listSessionRecords } from './records';
import { getSession, type ImportedSession } from './sessions';
import { ensureTaxonSelfSufficient } from './taxonCache';
import { generateUuid } from './uuid';

type Scalar = string | number | null;

/** As a file would carry it: dump + load, so both sides normalize alike. */
function viaYaml(doc: Record<string, unknown>): Record<string, unknown> {
  return yaml.load(yaml.dump(doc, { lineWidth: -1, noRefs: true })) as Record<string, unknown>;
}

export function localSessionDoc(sessionId: number): ImportedSession | null {
  const session = getSession(sessionId);
  if (!session) return null;
  const doc = buildSessionYamlDoc({
    session,
    projectName: getProject(session.project_id)?.name ?? '',
    records: listSessionRecords(sessionId),
    site: null,
  });
  return sessionFromDoc(viaYaml(doc));
}

export function localPlotDoc(plotId: number): ImportedPlot | null {
  const plot = getPlotSurvey(plotId);
  if (!plot) return null;
  const subplots = listSubplots(plotId);
  const doc = buildPlotYamlDoc({
    plot,
    projectName: '',
    species: listPlotSpecies(plotId),
    layers: plot.plot_type === 'fixed' ? getPlotLayers(plotId) : [],
    subplots: subplots.map((s) => ({ ...s, layers: getSubplotLayers(s.id) })),
    subplotLabelById: new Map(subplots.map((s) => [s.id, s.label])),
    site: null,
  });
  return plotFromDoc(viaYaml(doc));
}

// ── writing ────────────────────────────────────────────────────────────────

const columnCache = new Map<string, Set<string>>();
function columnsOf(table: string): Set<string> {
  let cols = columnCache.get(table);
  if (!cols) {
    const res = getUserDb().executeSync(`PRAGMA table_info(${table});`);
    cols = new Set(((res.rows ?? []) as { name?: string }[]).map((r) => String(r.name ?? '')));
    columnCache.set(table, cols);
  }
  return cols;
}

/** Only real columns get written; a field the file has and this table lacks is dropped. */
function toColumns(table: string, values: Row): Array<[string, Scalar]> {
  const cols = columnsOf(table);
  return Object.entries(values)
    .filter(([k]) => cols.has(k) && k !== 'id')
    .map(([k, v]) => [k, (v === undefined ? null : v) as Scalar]);
}

export function writeUpdate(table: string, values: Row, where: string, args: Scalar[], stamp: boolean): void {
  const pairs = toColumns(table, values);
  if (stamp && columnsOf(table).has('updated_at')) pairs.push(['updated_at', Date.now()]);
  if (pairs.length === 0) return;
  getUserDb().executeSync(
    `UPDATE ${table} SET ${pairs.map(([k]) => `${k} = ?`).join(', ')} WHERE ${where}`,
    [...pairs.map(([, v]) => v), ...args],
  );
}

export function writeInsert(table: string, values: Row): number {
  const pairs = toColumns(table, values);
  const res = getUserDb().executeSync(
    `INSERT INTO ${table} (${pairs.map(([k]) => k).join(', ')}) VALUES (${pairs.map(() => '?').join(', ')})`,
    pairs.map(([, v]) => v),
  );
  return Number(res.insertId ?? 0);
}

export type MergeMedia = { photoUriByName?: Map<string, string>; audioUriByName?: Map<string, string> };

function mediaJson(files: unknown, byName: Map<string, string> | undefined): string | null {
  const uris = (Array.isArray(files) ? (files as string[]) : [])
    .map((f) => byName?.get(f) ?? null)
    .filter((u): u is string => u !== null);
  return uris.length ? JSON.stringify(uris) : null;
}

/** A row key minted by mergeDocs for a keyless row (older file) is not an id. */
const occurrenceIdOf = (key: string) => (key.startsWith('row-') ? generateUuid() : key);

const byTable = (ops: MergeOp[], tbl: string) => ops.filter((o) => o.tbl === tbl);

export function applySessionMerge(sessionId: number, ops: MergeOp[], media: MergeMedia): void {
  withTransaction(() => {
    const db = getUserDb();
    for (const op of byTable(ops, 'record')) {
      if (op.op === 'update') writeUpdate('sessions', { ...op.data, ...op.extra }, 'id = ?', [sessionId], false);
    }
    const now = Date.now();
    for (const op of byTable(ops, 'rec')) {
      if (op.op === 'delete') {
        db.executeSync(`DELETE FROM checklist_records WHERE session_id = ? AND occurrence_id = ?`, [sessionId, op.key]);
      } else if (op.op === 'update') {
        writeUpdate('checklist_records', op.data, 'session_id = ? AND occurrence_id = ?', [sessionId, op.key], true);
      } else {
        const r = op.row;
        const taxonId = String(r.data.taxon_id ?? '');
        if (taxonId) ensureTaxonSelfSufficient(taxonId);
        writeInsert('checklist_records', {
          ...r.data,
          session_id: sessionId,
          occurrence_id: occurrenceIdOf(r.key),
          observed_at: r.data.observed_at ?? now,
          photo_paths: mediaJson(r.extra?.photo_files, media.photoUriByName),
          audio_paths: mediaJson(r.extra?.audio_files, media.audioUriByName),
          updated_at: now,
        });
      }
    }
  });
}

export function applyPlotMerge(plotId: number, ops: MergeOp[], media: MergeMedia): void {
  withTransaction(() => {
    const db = getUserDb();
    const now = Date.now();
    for (const op of byTable(ops, 'record')) {
      if (op.op === 'update') writeUpdate('plot_surveys', { ...op.data, ...op.extra }, 'id = ?', [plotId], true);
    }
    const plot = getPlotSurvey(plotId);
    if (!plot) throw new Error(`plot ${plotId} not found`);

    for (const op of byTable(ops, 'layer')) {
      const idx = Number(op.op === 'insert' ? op.row.key : op.key);
      if (op.op === 'delete') {
        db.executeSync(`DELETE FROM plot_survey_layers WHERE plot_survey_id = ? AND layer_index = ?`, [plotId, idx]);
      } else if (op.op === 'update') {
        writeUpdate('plot_survey_layers', op.data, 'plot_survey_id = ? AND layer_index = ?', [plotId, idx], false);
      } else {
        db.executeSync(`DELETE FROM plot_survey_layers WHERE plot_survey_id = ? AND layer_index = ?`, [plotId, idx]);
        writeInsert('plot_survey_layers', { ...op.row.data, plot_survey_id: plotId, layer_index: idx });
      }
    }

    // Species of a deleted subplot are kept, unassigned — same as shrinking
    // the subplot count (setSubplotCount).
    const subplotId = (idx: number) =>
      (db.executeSync(`SELECT id FROM plot_subplots WHERE plot_survey_id = ? AND idx = ?`, [plotId, idx]).rows?.[0] as
        | { id: number }
        | undefined)?.id ?? null;
    for (const op of byTable(ops, 'subplot')) {
      const idx = Number(op.op === 'insert' ? op.row.key : op.key);
      const sid = subplotId(idx);
      if (op.op === 'delete') {
        if (sid != null) {
          db.executeSync(`UPDATE plot_species_records SET subplot_id = NULL WHERE subplot_id = ?`, [sid]);
          db.executeSync(`DELETE FROM plot_subplots WHERE id = ?`, [sid]);
        }
      } else if (op.op === 'update') {
        if (sid != null) writeUpdate('plot_subplots', op.data, 'id = ?', [sid], false);
      } else if (sid == null) {
        writeInsert('plot_subplots', { ...op.row.data, plot_survey_id: plotId, idx, created_at: now });
      }
    }
    for (const op of byTable(ops, 'sublayer')) {
      const [idx, layer] = (op.op === 'insert' ? op.row.key : op.key).split(':').map(Number);
      const sid = subplotId(idx);
      if (sid == null) continue;
      if (op.op === 'delete') {
        db.executeSync(`DELETE FROM subplot_layers WHERE subplot_id = ? AND layer_index = ?`, [sid, layer]);
      } else if (op.op === 'update') {
        writeUpdate('subplot_layers', op.data, 'subplot_id = ? AND layer_index = ?', [sid, layer], false);
      } else {
        db.executeSync(`DELETE FROM subplot_layers WHERE subplot_id = ? AND layer_index = ?`, [sid, layer]);
        writeInsert('subplot_layers', { ...op.row.data, subplot_id: sid, layer_index: layer });
      }
    }

    const subplotByLabel = new Map(listSubplots(plotId).map((s) => [s.label, s.id]));
    const fallbackLayer: Layer = plot.plot_type === 'fixed' ? 'E1' : TRANSECT_LAYER;
    const layerOf = (v: unknown): Layer =>
      typeof v === 'string' && (LAYERS as string[]).concat(TRANSECT_LAYER).includes(v) ? (v as Layer) : fallbackLayer;
    // The file names a subplot by label; the column holds this device's id.
    const species = (data: Row): Row => {
      const out: Row = { ...data };
      if ('subplot' in data) out.subplot_id = data.subplot ? (subplotByLabel.get(String(data.subplot)) ?? null) : null;
      if ('layer' in data) out.layer = layerOf(data.layer);
      return out;
    };
    for (const op of byTable(ops, 'sp')) {
      if (op.op === 'delete') {
        db.executeSync(`DELETE FROM plot_species_records WHERE plot_survey_id = ? AND occurrence_id = ?`, [plotId, op.key]);
      } else if (op.op === 'update') {
        writeUpdate('plot_species_records', species(op.data), 'plot_survey_id = ? AND occurrence_id = ?', [plotId, op.key], true);
      } else {
        const r = op.row;
        const taxonId = String(r.data.taxon_id ?? '');
        if (taxonId) ensureTaxonSelfSufficient(taxonId);
        writeInsert('plot_species_records', {
          ...species(r.data),
          layer: layerOf(r.data.layer),
          plot_survey_id: plotId,
          occurrence_id: occurrenceIdOf(r.key),
          observed_at: r.data.observed_at ?? now,
          photo_paths: mediaJson(r.extra?.photo_files, media.photoUriByName),
          audio_paths: mediaJson(r.extra?.audio_files, media.audioUriByName),
          created_at: now,
          updated_at: now,
        });
      }
    }
  });
}
