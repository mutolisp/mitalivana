/**
 * Usage modes (docs/planned/UI_modes.md, UI_modes_impl.md): one codebase,
 * three views of it.
 *
 *   pro     專業調查  every screen and field there is today
 *   vol     志工調查  quick checklist, transect and point count only
 *   casual  隨手記    photo / recording first, identify later
 *
 * A mode only decides what is SHOWN. Tables, export formats and team sync do
 * not depend on it, and records of a hidden kind still open.
 *
 * What each mode shows is a table of capabilities (`CAPS`), not a scatter of
 * `mode === 'vol'` checks: the UI inventory (docs/planned/ui-modes-inventory.json)
 * is the specification, and each capability covers one or more of its rows.
 * `npm run check:modes` keeps the table honest: every capability has a value
 * for all three modes, is used somewhere outside the table, and is never
 * hidden in pro mode unless it is listed in `SIMPLE_ONLY` (something only the
 * simpler modes have, such as volunteers' direct transect card).
 *
 * Pure: scripts/check-modes.mjs imports this file under plain Node, so nothing
 * here may import React Native or use the `~/` alias.
 */
import type { RecordTypeDefault } from '../stores/settings';

export type UsageMode = 'pro' | 'vol' | 'casual';
export const USAGE_MODES: readonly UsageMode[] = ['pro', 'vol', 'casual'];

/** show = on screen; adv = folded into the screen's 進階 section; hide = gone. */
export type Vis = 'show' | 'adv' | 'hide';
export type ModeVis = Record<UsageMode, Vis>;

/**
 * Whether the mode choice is offered at all. Off in release builds until the
 * volunteer and casual screens exist (M2–M5): until then a release build
 * stays in pro mode and never shows the first-launch choice.
 */
export const USAGE_MODES_OFFERED: boolean = typeof __DEV__ !== 'undefined' && __DEV__;

export function parseUsageMode(raw: string | null | undefined): UsageMode | null {
  return raw === 'pro' || raw === 'vol' || raw === 'casual' ? raw : null;
}

export type Cap =
  | 'plusDefaultAsk'
  | 'plusDefaultSession'
  | 'plusDefaultPlot'
  | 'plusDefaultCollection'
  | 'plusDefaultTransect'
  | 'plusDefaultPointCount'
  | 'createPlotTypes'
  | 'createTransectPoint'
  | 'createCollection'
  | 'createModules'
  | 'importTile'
  | 'importPlanButton'
  | 'importAnyKind'
  | 'addToCollection'
  | 'recordKindsAll'
  | 'crossPlotStats'
  | 'diversityInLists'
  | 'plotDiversity'
  | 'projectExport'
  | 'analysisReport'
  | 'mergeRecords'
  | 'recordVersions'
  | 'mergeLog'
  | 'batchImport'
  | 'batchImportFile'
  | 'newProjectInSheet'
  | 'geoSites'
  | 'customTaxon'
  | 'nameUsagePick'
  | 'speciesSourceLit'
  | 'verbatimLabel'
  | 'keyChip'
  | 'recordElevation'
  | 'speciesAttributes'
  | 'recordMeta'
  | 'endTimeLater'
  | 'plotEnvExtra'
  | 'plotTotalCover'
  | 'plotRange'
  | 'trackStop'
  | 'abundanceUnit'
  | 'detectionOnRow'
  | 'observationNotes'
  | 'teamAdmin'
  | 'teamServers'
  | 'teamLog'
  | 'exportAnalysis'
  | 'backupSafety'
  | 'inatManualToken'
  | 'inatTags';

export const CAPS: Record<Cap, ModeVis> = {
  // What ＋ does without asking (settings 「按下 ＋ 時」, the create sheet's
  // segments). Casual mode's ＋ always opens the capture sheet (M5), so it has
  // none; volunteers get transect and point count in place of 樣區 (M2).
  plusDefaultAsk: { pro: 'show', vol: 'show', casual: 'hide' },
  plusDefaultSession: { pro: 'show', vol: 'show', casual: 'hide' },
  plusDefaultPlot: { pro: 'show', vol: 'hide', casual: 'hide' },
  plusDefaultCollection: { pro: 'show', vol: 'hide', casual: 'hide' },
  plusDefaultTransect: { pro: 'hide', vol: 'show', casual: 'hide' },
  plusDefaultPointCount: { pro: 'hide', vol: 'show', casual: 'hide' },
  // The create sheet (design 02 / 18f). Volunteers get transect and point
  // count as cards of their own instead of the plot-type page, which also
  // offers 固定樣區.
  createPlotTypes: { pro: 'show', vol: 'hide', casual: 'hide' },
  createTransectPoint: { pro: 'hide', vol: 'show', casual: 'hide' },
  createCollection: { pro: 'show', vol: 'hide', casual: 'hide' },
  createModules: { pro: 'show', vol: 'hide', casual: 'hide' },
  // Importing: a tile under 其他 in pro; volunteers, who have no 其他 row,
  // get one button for the file a project hands out.
  importTile: { pro: 'show', vol: 'hide', casual: 'hide' },
  importPlanButton: { pro: 'hide', vol: 'show', casual: 'hide' },
  // A file's kind decides what an import creates, whatever the entry. Without
  // this a volunteer could still import a fixed plot or a GLORIA survey.
  importAnyKind: { pro: 'show', vol: 'hide', casual: 'hide' },
  // 「加入採集」: the long press on 加入記錄 and the add-to sheets' row.
  addToCollection: { pro: 'show', vol: 'hide', casual: 'hide' },

  // Records tab (RL). The kind chips for the kinds volunteers cannot make
  // (採集, GLORIA, 每木, 模組化) and the project page's GLORIA report and
  // MIREN list. Records of those kinds stay in 全部 and still open.
  recordKindsAll: { pro: 'show', vol: 'hide', casual: 'hide' },
  // Cross-plot sampling effort: the project header's Chao2 chip, 取樣努力量
  // in the selection menu, the project page's Chao2 card.
  crossPlotStats: { pro: 'show', vol: 'hide', casual: 'hide' },
  // The S · H′ · J′ line under a record in the list; the species count stays.
  diversityInLists: { pro: 'show', vol: 'hide', casual: 'hide' },
  // A plot's own diversity card (its header's second line).
  plotDiversity: { pro: 'show', vol: 'adv', casual: 'hide' },
  projectExport: { pro: 'show', vol: 'adv', casual: 'hide' },
  analysisReport: { pro: 'show', vol: 'adv', casual: 'hide' },
  mergeRecords: { pro: 'show', vol: 'adv', casual: 'hide' },
  recordVersions: { pro: 'show', vol: 'adv', casual: 'hide' },
  mergeLog: { pro: 'show', vol: 'adv', casual: 'hide' },

  // Quick checklist (QS) and the species sheets.
  batchImport: { pro: 'show', vol: 'adv', casual: 'hide' },
  batchImportFile: { pro: 'show', vol: 'hide', casual: 'hide' },
  newProjectInSheet: { pro: 'show', vol: 'adv', casual: 'hide' },
  // 地理樣區: kept for the GPX a project hands out, but out of the way.
  geoSites: { pro: 'show', vol: 'adv', casual: 'hide' },
  customTaxon: { pro: 'show', vol: 'adv', casual: 'hide' },
  nameUsagePick: { pro: 'show', vol: 'adv', casual: 'hide' },
  // The species page's 來源文獻 (alien-status citations): folded, not open.
  speciesSourceLit: { pro: 'show', vol: 'adv', casual: 'hide' },
  verbatimLabel: { pro: 'show', vol: 'adv', casual: 'hide' },
  keyChip: { pro: 'show', vol: 'adv', casual: 'hide' },
  recordElevation: { pro: 'show', vol: 'adv', casual: 'hide' },
  // 進階（物種屬性）: sex, life stage, phenology, wild or not. A plant's
  // flowering state moves to the observation notes where those show.
  speciesAttributes: { pro: 'show', vol: 'adv', casual: 'adv' },
  // occurrenceID, iNaturalist ID, last updated.
  recordMeta: { pro: 'show', vol: 'adv', casual: 'hide' },
  // 結束時間「先不記錄」, for typing in paper sheets later.
  endTimeLater: { pro: 'show', vol: 'hide', casual: 'hide' },

  // Transect and point count (PL). 基本資料 keeps the fields a volunteer
  // fills; method, size, terrain and ground cover fold into 進階.
  plotEnvExtra: { pro: 'show', vol: 'adv', casual: 'hide' },
  plotTotalCover: { pro: 'show', vol: 'hide', casual: 'hide' },
  plotRange: { pro: 'show', vol: 'adv', casual: 'hide' },
  // A transect's 停止 (pause stays): ending the plot stops the track anyway.
  trackStop: { pro: 'show', vol: 'hide', casual: 'hide' },
  // Volunteers count individuals; no cover, Braun-Blanquet, DBH or own unit.
  abundanceUnit: { pro: 'show', vol: 'hide', casual: 'hide' },
  // 目視／鳴叫／飛過 on the species row itself; pro sets it in the value sheet.
  detectionOnRow: { pro: 'hide', vol: 'show', casual: 'hide' },
  // Observation notes with tips by group (18l). Not in pro (user, 2026-10-05).
  observationNotes: { pro: 'hide', vol: 'show', casual: 'show' },

  // Team sync (SF): volunteers join, sync and leave; the coordinator, in pro
  // mode, creates the team, invites, deletes cloud data and deploys.
  teamAdmin: { pro: 'show', vol: 'hide', casual: 'hide' },
  teamServers: { pro: 'show', vol: 'adv', casual: 'hide' },
  teamLog: { pro: 'show', vol: 'adv', casual: 'hide' },
  // Export settings: vegan / JUICE / DwC-A and the matrix values.
  exportAnalysis: { pro: 'show', vol: 'hide', casual: 'hide' },
  backupSafety: { pro: 'show', vol: 'adv', casual: 'adv' },
  inatManualToken: { pro: 'show', vol: 'adv', casual: 'adv' },
  inatTags: { pro: 'show', vol: 'adv', casual: 'adv' },
};

/** Capabilities only the simpler modes have: allowed to be hidden in pro. */
export const SIMPLE_ONLY: ReadonlySet<Cap> = new Set<Cap>([
  'plusDefaultTransect',
  'plusDefaultPointCount',
  'createTransectPoint',
  'importPlanButton',
  'detectionOnRow',
  'observationNotes',
]);

export function vis(mode: UsageMode, cap: Cap): Vis {
  return CAPS[cap][mode];
}

export function shows(mode: UsageMode, cap: Cap): boolean {
  return CAPS[cap][mode] !== 'hide';
}

const RECORD_DEFAULT_CAP: Record<RecordTypeDefault, Cap> = {
  ask: 'plusDefaultAsk',
  session: 'plusDefaultSession',
  plot: 'plusDefaultPlot',
  collection: 'plusDefaultCollection',
  transect: 'plusDefaultTransect',
  point_count: 'plusDefaultPointCount',
};

/** The ＋ defaults a mode offers, in display order. */
export function allowedRecordTypeDefaults(mode: UsageMode): RecordTypeDefault[] {
  return (Object.keys(RECORD_DEFAULT_CAP) as RecordTypeDefault[]).filter((d) => shows(mode, RECORD_DEFAULT_CAP[d]));
}

/**
 * The ＋ default to keep after switching to `mode`: the current one if the mode
 * still offers it, else 「每次詢問」. Without this a pro user who set ＋ to
 * 採集 and switched to volunteer mode would still get a collection on ＋.
 */
export function settleRecordTypeDefault(mode: UsageMode, current: RecordTypeDefault): RecordTypeDefault {
  return allowedRecordTypeDefaults(mode).includes(current) ? current : 'ask';
}

/**
 * A field label as the mode shows it. In the simpler modes the Darwin Core
 * term some labels carry in parentheses — 「數量 (organismQuantity)」 — is
 * dropped, and so is one that opens a longer note: 「花/果 (reproductiveCondition，
 * 可複選)」 keeps 「(可複選)」. A term is a camelCase identifier: lower-case
 * first, three letters or more. Units and abbreviations are not terms, so
 * 「寬 (m)」, 「覆蓋度 (%)」 and 「胸高直徑 (DBH, cm)」 keep their parentheses.
 */
export function fieldLabel(label: string, mode: UsageMode): string {
  if (mode === 'pro') return label;
  return label
    .replace(/\s*[(（][a-z][A-Za-z]{2,}[)）]\s*$/, '')
    .replace(/([(（])[a-z][A-Za-z]{2,}\s*[，、,]\s*/, '$1');
}
