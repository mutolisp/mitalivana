/**
 * Every setting the menu tab can show or find (03-screens-flow.md §4c).
 *
 * The grouped page and the search results are both generated from this list,
 * so a row cannot exist in one and be missing from the other. The list only
 * says WHAT is where; reading and writing a value still goes through
 * useSettings, wired per id in app/(tabs)/menu.tsx.
 *
 * Entries with `focus` live on a subpage (the same `route` as the entry with
 * no focus). They are hidden from the grouped page and only surface in search,
 * where tapping one opens the subpage scrolled to that row.
 *
 * Pure data and string helpers: `npm run check:settings-index` imports this
 * file under plain Node, so nothing here may import React Native.
 */
import type { Ionicons } from '@expo/vector-icons';
import type { ComponentProps } from 'react';
import { SURVEY_FORMS_OFFERED } from '../survey/templates/samples';

export type SettingsSection =
  | 'records'
  | 'survey'
  | 'modules'
  | 'lists'
  | 'sync'
  | 'appearance'
  | 'data'
  | 'about';

export type SettingsKind = 'nav' | 'switch' | 'select' | 'action';

/** Icon-tile tint. The three pale ones rotate by section; `alert` is 清除所有資料. */
export type SettingsTone = 'accent' | 'acorn' | 'neutral' | 'alert';

export interface SettingsEntry {
  id: string;
  section: SettingsSection;
  labelKey: string;
  descKey?: string;
  /** Space-separated synonyms, per locale, under `settingsSearch.<id>`. */
  keywordsKey?: string;
  kind: SettingsKind;
  route?: string;
  /** FocusAnchor id on the subpage at `route`. */
  focus?: string;
  icon: ComponentProps<typeof Ionicons>['name'];
  /** Shown only while this boolean setting is on. */
  visibleWhen?: 'module_gloria' | 'module_miren' | 'module_survey';
  tone?: SettingsTone;
}

export const SECTION_ORDER: SettingsSection[] = [
  'records',
  'survey',
  'modules',
  'lists',
  'sync',
  'appearance',
  'data',
  'about',
];

/** Null for the trailing About block, which has no caption. */
export const SECTION_TITLE: Record<SettingsSection, string | null> = {
  records: 'settings.groupRecords',
  survey: 'settings.groupSurvey',
  modules: 'settings.groupModules',
  lists: 'settings.groupLists',
  sync: 'settings.groupSync',
  appearance: 'settings.sectionAppearance',
  data: 'settings.sectionData',
  about: null,
};

export const SECTION_TONE: Record<SettingsSection, SettingsTone> = {
  records: 'accent',
  survey: 'acorn',
  modules: 'neutral',
  lists: 'accent',
  sync: 'acorn',
  appearance: 'neutral',
  data: 'neutral',
  about: 'neutral',
};

const kw = (id: string) => `settingsSearch.${id}`;

export const SETTINGS_INDEX: SettingsEntry[] = [
  // Records
  { id: 'projects', section: 'records', labelKey: 'nav.projects', descKey: 'menu.projectsDesc', keywordsKey: kw('projects'), kind: 'nav', route: '/projects', icon: 'folder-outline' },
  { id: 'sites', section: 'records', labelKey: 'menu.sites', descKey: 'menu.sitesDesc', keywordsKey: kw('sites'), kind: 'nav', route: '/sites', icon: 'location-outline' },
  { id: 'favorites', section: 'records', labelKey: 'nav.favorites', descKey: 'menu.favoritesDesc', kind: 'nav', route: '/favorites', icon: 'heart-outline' },
  { id: 'surveyors', section: 'records', labelKey: 'settings.surveyors', descKey: 'settings.surveyorsDesc', keywordsKey: kw('surveyors'), kind: 'nav', route: '/surveyors', icon: 'people-outline' },

  // Survey
  { id: 'defaultCreate', section: 'survey', labelKey: 'create.plusDefault', keywordsKey: kw('defaultCreate'), kind: 'select', icon: 'add-circle-outline' },
  { id: 'gpsSession', section: 'survey', labelKey: 'settings.gpsPerSpeciesSession', descKey: 'settings.gpsPerSpeciesSessionDesc', keywordsKey: kw('gpsSession'), kind: 'switch', icon: 'navigate-outline' },
  { id: 'gpsPlot', section: 'survey', labelKey: 'settings.gpsPerSpeciesPlot', descKey: 'settings.gpsPerSpeciesPlotDesc', keywordsKey: kw('gpsPlot'), kind: 'switch', icon: 'locate-outline' },
  { id: 'trackAccuracy', section: 'survey', labelKey: 'settings.trackAccuracy', descKey: 'settings.trackAccuracyDesc', keywordsKey: kw('trackAccuracy'), kind: 'select', icon: 'analytics-outline' },
  { id: 'usageRank', section: 'survey', labelKey: 'settings.searchUsageRank', descKey: 'settings.searchUsageRankDesc', keywordsKey: kw('usageRank'), kind: 'switch', icon: 'trending-up-outline' },
  { id: 'collection', section: 'survey', labelKey: 'settings.sectionCollection', descKey: 'settings.collectionDesc', keywordsKey: kw('collection'), kind: 'nav', route: '/settings/collection', icon: 'pricetag-outline' },
  { id: 'collectionCollector', section: 'survey', labelKey: 'settings.defaultCollector', descKey: 'settings.defaultCollectorDesc', kind: 'nav', route: '/settings/collection', focus: 'collector', icon: 'person-outline' },
  { id: 'collectionDeterminer', section: 'survey', labelKey: 'settings.defaultDeterminer', descKey: 'settings.defaultDeterminerDesc', kind: 'nav', route: '/settings/collection', focus: 'determiner', icon: 'person-outline' },
  { id: 'collectionPrefix', section: 'survey', labelKey: 'collection.numberPrefix', keywordsKey: kw('collectionNumber'), kind: 'nav', route: '/settings/collection', focus: 'number', icon: 'pricetag-outline' },
  { id: 'collectionStart', section: 'survey', labelKey: 'collection.numberStart', keywordsKey: kw('collectionNumber'), kind: 'nav', route: '/settings/collection', focus: 'number', icon: 'pricetag-outline' },
  { id: 'collectionPad', section: 'survey', labelKey: 'collection.numberPad', keywordsKey: kw('collectionNumber'), kind: 'nav', route: '/settings/collection', focus: 'pad', icon: 'pricetag-outline' },

  // Survey modules
  { id: 'moduleGloria', section: 'modules', labelKey: 'settings.moduleGloria', descKey: 'settings.moduleGloriaDesc', keywordsKey: kw('moduleGloria'), kind: 'switch', icon: 'triangle-outline' },
  { id: 'gloriaSummits', section: 'modules', labelKey: 'gloria.summitImport.listTitle', descKey: 'gloria.summitImport.listDesc', kind: 'nav', route: '/gloria/summits', icon: 'flag-outline', visibleWhen: 'module_gloria' },
  { id: 'moduleMiren', section: 'modules', labelKey: 'settings.moduleMiren', descKey: 'settings.moduleMirenDesc', keywordsKey: kw('moduleMiren'), kind: 'switch', icon: 'trail-sign-outline' },
  { id: 'mirenRegions', section: 'modules', labelKey: 'miren.regions.title', descKey: 'miren.regions.desc', kind: 'nav', route: '/miren', icon: 'git-branch-outline', visibleWhen: 'module_miren' },
  { id: 'moduleSurvey', section: 'modules', labelKey: 'settings.moduleSurvey', descKey: 'settings.moduleSurveyDesc', keywordsKey: kw('moduleSurvey'), kind: 'switch', icon: 'apps-outline' },
  { id: 'surveyFrames', section: 'modules', labelKey: 'survey.frames.title', descKey: 'survey.frames.desc', kind: 'nav', route: '/survey', icon: 'map-outline', visibleWhen: 'module_survey' },
  // The builder (2D-a), offered with the checklist / plot-style surveys.
  ...(SURVEY_FORMS_OFFERED
    ? [{ id: 'surveyTemplates', section: 'modules', labelKey: 'builder.title', descKey: 'builder.desc', kind: 'nav', route: '/survey/templates', icon: 'construct-outline', visibleWhen: 'module_survey' } as const]
    : []),

  // Lists and maps
  { id: 'regionPacks', section: 'lists', labelKey: 'settings.regionPacks', descKey: 'settings.regionPacksDesc', keywordsKey: kw('regionPacks'), kind: 'nav', route: '/regionpacks', icon: 'library-outline' },
  { id: 'offlineMap', section: 'lists', labelKey: 'offlinemap.title', keywordsKey: kw('offlineMap'), kind: 'nav', route: '/settings/offlinemap', icon: 'map-outline' },
  { id: 'vernacular', section: 'lists', labelKey: 'vernacular.title', keywordsKey: kw('vernacular'), kind: 'nav', route: '/settings/vernacular', icon: 'chatbubble-ellipses-outline' },
  { id: 'intermediateRanks', section: 'lists', labelKey: 'settings.intermediateRanks', keywordsKey: kw('intermediateRanks'), kind: 'select', icon: 'git-network-outline' },

  // Sync and export
  { id: 'backup', section: 'sync', labelKey: 'nav.backup', descKey: 'menu.backupDesc', keywordsKey: kw('backup'), kind: 'nav', route: '/backup', icon: 'save-outline' },
  { id: 'gdrive', section: 'sync', labelKey: 'settings.gdrive', descKey: 'settings.gdriveDesc', keywordsKey: kw('gdrive'), kind: 'nav', route: '/gdrive', icon: 'cloud-outline' },
  { id: 'inaturalist', section: 'sync', labelKey: 'settings.inaturalist', descKey: 'settings.inaturalistDesc', keywordsKey: kw('inaturalist'), kind: 'nav', route: '/inaturalist', icon: 'leaf-outline' },
  { id: 'teamSync', section: 'sync', labelKey: 'teamSync.title', descKey: 'teamSync.menuDesc', keywordsKey: kw('teamSync'), kind: 'nav', route: '/settings/team-sync', icon: 'sync-outline' },
  { id: 'export', section: 'sync', labelKey: 'exportPref.title', descKey: 'settings.exportPrefDesc', keywordsKey: kw('export'), kind: 'nav', route: '/settings/export', icon: 'share-outline' },
  { id: 'exportGeo', section: 'sync', labelKey: 'exportPref.geoFormats', descKey: 'exportPref.geoFormatsHint', keywordsKey: kw('exportGeo'), kind: 'nav', route: '/settings/export', focus: 'geo', icon: 'share-outline' },
  { id: 'exportPhoto', section: 'sync', labelKey: 'exportPref.photo', descKey: 'exportPref.includePhotosHint', kind: 'nav', route: '/settings/export', focus: 'photo', icon: 'share-outline' },
  { id: 'exportDoc', section: 'sync', labelKey: 'exportPref.docFormat', descKey: 'exportPref.docFileFormatHint', keywordsKey: kw('exportDoc'), kind: 'nav', route: '/settings/export', focus: 'doc', icon: 'share-outline' },
  { id: 'exportLevels', section: 'sync', labelKey: 'exportPref.levels', kind: 'nav', route: '/settings/export', focus: 'levels', icon: 'share-outline' },
  { id: 'exportCons', section: 'sync', labelKey: 'exportPref.consFields', keywordsKey: kw('exportCons'), kind: 'nav', route: '/settings/export', focus: 'levels', icon: 'share-outline' },
  { id: 'exportAnalysis', section: 'sync', labelKey: 'projectExport.prefSection', keywordsKey: kw('exportAnalysis'), kind: 'nav', route: '/settings/export', focus: 'analysis', icon: 'share-outline' },
  { id: 'provenance', section: 'sync', labelKey: 'settings.provenance', descKey: 'settings.provenanceDesc', keywordsKey: kw('provenance'), kind: 'nav', route: '/settings/provenance', icon: 'finger-print-outline' },

  // Appearance and controls
  { id: 'language', section: 'appearance', labelKey: 'settings.language', keywordsKey: kw('language'), kind: 'nav', route: '/settings/language', icon: 'language-outline' },
  { id: 'theme', section: 'appearance', labelKey: 'settings.theme', keywordsKey: kw('theme'), kind: 'select', icon: 'contrast-outline' },
  { id: 'fontSize', section: 'appearance', labelKey: 'settings.fontSize', keywordsKey: kw('fontSize'), kind: 'select', icon: 'text-outline' },
  { id: 'cardDensity', section: 'appearance', labelKey: 'settings.cardDensity', keywordsKey: kw('cardDensity'), kind: 'select', icon: 'reorder-four-outline' },
  { id: 'fabSide', section: 'appearance', labelKey: 'settings.fabSide', descKey: 'settings.fabSideDesc', keywordsKey: kw('fabSide'), kind: 'select', icon: 'hand-left-outline' },
  { id: 'undoDuration', section: 'appearance', labelKey: 'settings.undoDuration', keywordsKey: kw('undoDuration'), kind: 'select', icon: 'arrow-undo-outline' },

  // Data
  { id: 'storage', section: 'data', labelKey: 'storage.title', descKey: 'storage.menuDesc', keywordsKey: kw('storage'), kind: 'nav', route: '/settings/storage', icon: 'pie-chart-outline' },
  { id: 'integrity', section: 'data', labelKey: 'settings.integrityCheck', descKey: 'settings.integrityDesc', kind: 'action', icon: 'shield-checkmark-outline' },
  { id: 'clearHistory', section: 'data', labelKey: 'settings.clearHistory', kind: 'action', icon: 'time-outline' },
  { id: 'clearAll', section: 'data', labelKey: 'settings.clearAll', descKey: 'settings.clearAllDesc', kind: 'action', icon: 'trash-outline', tone: 'alert' },

  // (no caption)
  { id: 'about', section: 'about', labelKey: 'nav.about', kind: 'nav', route: '/about', icon: 'information-circle-outline' },
  { id: 'privacy', section: 'about', labelKey: 'nav.privacy', kind: 'nav', route: '/privacy', icon: 'lock-closed-outline' },
];

export function toneOf(e: SettingsEntry): SettingsTone {
  return e.tone ?? SECTION_TONE[e.section];
}

/** The page a subpage entry lives on: the entry sharing its route, without focus. */
export function parentOf(e: SettingsEntry): SettingsEntry | undefined {
  if (!e.focus) return undefined;
  return SETTINGS_INDEX.find((p) => p.route === e.route && !p.focus);
}

/**
 * Case-folded, 臺 → 台. Index-preserving (one output char per input char) so a
 * match found in the folded string can be highlighted in the original.
 */
export function fold(s: string): string {
  let out = '';
  for (const ch of s) {
    if (ch === '臺') {
      out += '台';
      continue;
    }
    const lower = ch.toLowerCase();
    // A few characters lower-case to two code units (İ → i̇); keep them as they
    // are rather than shift every later index.
    out += lower.length === ch.length ? lower : ch;
  }
  return out;
}

export interface SettingsHit {
  entry: SettingsEntry;
  /** True when the label matched; description/keyword-only hits sort after. */
  labelHit: boolean;
}

/**
 * Entries matching `query`, label hits first, registry order within each
 * half. `translate` returns '' for a missing key so a locale without synonyms
 * for an entry just has none. `visible` drops entries whose module is off.
 */
export function searchSettings(
  query: string,
  translate: (key: string) => string,
  visible: (e: SettingsEntry) => boolean,
): SettingsHit[] {
  const q = fold(query.trim());
  if (!q) return [];
  const labelHits: SettingsHit[] = [];
  const otherHits: SettingsHit[] = [];
  for (const entry of SETTINGS_INDEX) {
    if (!visible(entry)) continue;
    if (fold(translate(entry.labelKey)).includes(q)) {
      labelHits.push({ entry, labelHit: true });
      continue;
    }
    const rest = [entry.descKey, entry.keywordsKey]
      .filter((k): k is string => !!k)
      .map((k) => fold(translate(k)))
      .join('\n');
    if (rest.includes(q)) otherHits.push({ entry, labelHit: false });
  }
  return [...labelHits, ...otherHits];
}

/** [before, match, after] segments of `text` for the first hit of `query`. */
export function splitMatch(text: string, query: string): [string, string, string] | null {
  const q = fold(query.trim());
  if (!q) return null;
  const i = fold(text).indexOf(q);
  if (i < 0) return null;
  // fold() is index-preserving per code point; slice by code points to match.
  const chars = Array.from(text);
  const qLen = Array.from(q).length;
  const at = Array.from(fold(text).slice(0, i)).length;
  return [chars.slice(0, at).join(''), chars.slice(at, at + qLen).join(''), chars.slice(at + qLen).join('')];
}
