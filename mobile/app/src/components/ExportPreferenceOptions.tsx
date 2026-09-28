/**
 * Export-preference controls:
 *   - which geo file formats to pack (geojson / gpx / kml, multi-select)
 *   - whether to include photos
 *   - the formatted-document format (DOCX / ODT) and what is written in it
 *
 * Persisted to settings, so the next swipe-export uses the same choices.
 *
 * Chrome-less on purpose: app/settings/export.tsx owns the screen and its
 * scroller. Every control writes through `settings.set` on tap, so there is no
 * save step and nothing to confirm.
 */
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';
import { Pressable, Text, View } from 'react-native';
import { Switch } from '~/components/ui/Switch';
import { DOC_FORMATS, reportFormatLabels } from '~/lib/docFormat';
import { useSettings, type DocFormat, type ReportFormat } from '~/stores/settings';
import { AnalysisExportOptions } from './AnalysisExportOptions';
import type { ConservationField } from '~/lib/markdown';

type GeoFormat = 'geojson' | 'gpx' | 'kml';

const GEO_OPTIONS: Array<{ value: GeoFormat; label: string; hint: string }> = [
  { value: 'kml', label: 'KML', hint: 'Google Earth / Google Maps' },
  { value: 'gpx', label: 'GPX', hint: 'Strava / Garmin / GNSS device' },
  { value: 'geojson', label: 'GeoJSON', hint: 'QGIS / GIS / mapping tools' },
];

const LEVEL_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'kingdom', label: 'rank.kingdom' },
  { value: 'phylum', label: 'rank.phylum' },
  { value: 'class_name', label: 'rank.class' },
  { value: 'order', label: 'rank.order' },
  { value: 'family', label: 'rank.family' },
  { value: 'genus', label: 'rank.genus' },
];

const DOC_FORMAT_OPTIONS: DocFormat[] = ['docx', 'odt'];

/** Labels follow the chosen document format: HTML / ODT / HTML + ODT. */
const REPORT_FORMAT_OPTIONS: ReportFormat[] = ['html', 'docx', 'both'];

const CONSERVATION_OPTIONS: Array<{ value: ConservationField; label: string }> = [
  { value: 'redlist', label: 'exportPref.consRedlist' },
  { value: 'iucn_category', label: 'IUCN' },
  { value: 'cites', label: 'CITES' },
  { value: 'protected', label: 'exportPref.consProtected' },
];

export function ExportPreferenceOptions() {
  const { t } = useTranslation();
  const formats = useSettings((s) => s.export_geo_formats);
  const includePhotos = useSettings((s) => s.export_include_photos);
  const mergeDuplicates = useSettings((s) => s.export_merge_duplicate_taxa);
  const includeDocx = useSettings((s) => s.export_include_docx);
  const docFormat = useSettings((s) => s.export_doc_format);
  const includeReport = useSettings((s) => s.export_include_report);
  const reportFormat = useSettings((s) => s.export_report_format);
  const levels = useSettings((s) => s.export_levels);
  const conservationFields = useSettings((s) => s.export_conservation_fields);
  const hideLowConcern = useSettings((s) => s.export_conservation_hide_lc);
  const setSetting = useSettings((s) => s.set);

  const toggleFormat = (f: GeoFormat) => {
    const next = formats.includes(f) ? formats.filter((x) => x !== f) : [...formats, f];
    // Don't let the user disable everything — keep at least one format.
    if (next.length === 0) return;
    setSetting('export_geo_formats', next);
  };

  const toggleLevel = (l: string) => {
    // Empty selection is valid — it means "use each taxon group's default".
    setSetting('export_levels', levels.includes(l) ? levels.filter((x) => x !== l) : [...levels, l]);
  };

  const toggleConservation = (c: ConservationField) => {
    setSetting(
      'export_conservation_fields',
      conservationFields.includes(c)
        ? conservationFields.filter((x) => x !== c)
        : [...conservationFields, c],
    );
  };

  return (
    <>
      <Text className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
        {t('exportPref.geoFormats')}
      </Text>
      <Text className="mb-2 text-xs text-gray-500 dark:text-gray-400">
        {t('exportPref.geoFormatsHint')}
      </Text>
      <View className="mb-4">
        {GEO_OPTIONS.map((opt) => {
          const on = formats.includes(opt.value);
          return (
            <Pressable
              key={opt.value}
              onPress={() => toggleFormat(opt.value)}
              className="flex-row items-center border-b border-gray-100 dark:border-gray-800 py-3 active:bg-gray-50 dark:active:bg-gray-800"
            >
              <View
                className={`mr-3 h-6 w-6 items-center justify-center rounded ${on ? 'bg-accent-500' : 'border border-gray-300 dark:border-gray-700'}`}
              >
                {on ? <Ionicons name="checkmark" size={16} color="white" /> : null}
              </View>
              <View className="flex-1">
                <Text className="text-sm font-medium text-gray-900 dark:text-gray-100">{opt.label}</Text>
                <Text className="text-xs text-gray-500 dark:text-gray-400">{opt.hint}</Text>
              </View>
            </Pressable>
          );
        })}
      </View>

      <Text className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
        {t('exportPref.photo')}
      </Text>
      <View className="mb-4 flex-row items-center justify-between border-b border-gray-100 dark:border-gray-800 py-3">
        <View className="flex-1 pr-3">
          <Text className="text-sm font-medium text-gray-900 dark:text-gray-100">{t('exportPref.includePhotos')}</Text>
          <Text className="text-xs text-gray-500 dark:text-gray-400">
            {t('exportPref.includePhotosHint')}
          </Text>
        </View>
        <Switch
          value={includePhotos}
          onValueChange={(v) => setSetting('export_include_photos', v)}
        />
      </View>

      <Text className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
        {t('exportPref.checklistDoc')}
      </Text>
      <View className="mb-4 flex-row items-center justify-between border-b border-gray-100 dark:border-gray-800 py-3">
        <View className="flex-1 pr-3">
          <Text className="text-sm font-medium text-gray-900 dark:text-gray-100">
            {t('exportPref.mergeDuplicates')}
          </Text>
          <Text className="text-xs text-gray-500 dark:text-gray-400">
            {t('exportPref.mergeDuplicatesHint')}
          </Text>
        </View>
        <Switch
          value={mergeDuplicates}
          onValueChange={(v) => setSetting('export_merge_duplicate_taxa', v)}
        />
      </View>

      <Text className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
        {t('exportPref.docFormat')}
      </Text>
      <View className="border-b border-gray-100 dark:border-gray-800 py-3">
        <Text className="text-sm font-medium text-gray-900 dark:text-gray-100">{t('exportPref.docFileFormat')}</Text>
        <Text className="text-xs text-gray-500 dark:text-gray-400">{t('exportPref.docFileFormatHint')}</Text>
        <View className="flex-row flex-wrap gap-1.5 pt-2">
          {DOC_FORMAT_OPTIONS.map((value) => (
            <Chip
              key={value}
              label={DOC_FORMATS[value].label}
              on={docFormat === value}
              onPress={() => setSetting('export_doc_format', value)}
            />
          ))}
        </View>
      </View>
      <View className="mb-4 flex-row items-center justify-between border-b border-gray-100 dark:border-gray-800 py-3">
        <View className="flex-1 pr-3">
          <Text className="text-sm font-medium text-gray-900 dark:text-gray-100">{t('exportPref.includeDocx')}</Text>
          <Text className="text-xs text-gray-500 dark:text-gray-400">
            {t('exportPref.includeDocxHint')}
          </Text>
        </View>
        <Switch
          value={includeDocx}
          onValueChange={(v) => setSetting('export_include_docx', v)}
        />
      </View>

      <Text className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
        {t('exportPref.report')}
      </Text>
      <View className="flex-row items-center justify-between border-b border-gray-100 dark:border-gray-800 py-3">
        <View className="flex-1 pr-3">
          <Text className="text-sm font-medium text-gray-900 dark:text-gray-100">{t('exportPref.includeReport')}</Text>
          <Text className="text-xs text-gray-500 dark:text-gray-400">
            {t('exportPref.includeReportHint')}
          </Text>
        </View>
        <Switch
          value={includeReport}
          onValueChange={(v) => setSetting('export_include_report', v)}
        />
      </View>
      {/* Format chips only matter once the report is on. */}
      {includeReport ? (
        <View className="mb-4 flex-row flex-wrap gap-1.5 pt-2">
          {REPORT_FORMAT_OPTIONS.map((value) => (
            <Chip
              key={value}
              label={reportFormatLabels(value, docFormat).join(' + ')}
              on={reportFormat === value}
              onPress={() => setSetting('export_report_format', value)}
            />
          ))}
        </View>
      ) : (
        <View className="mb-4" />
      )}

      <Text className="mb-1 text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
        {t('exportPref.levels')}
      </Text>
      <Text className="mb-2 text-xs text-gray-500 dark:text-gray-400">
        {levels.length === 0
          ? t('exportPref.levelsHintDefault')
          : t('exportPref.levelsHintCustom')}
      </Text>
      <View className="mb-4 flex-row flex-wrap gap-1.5">
        {LEVEL_OPTIONS.map((opt) => {
          const on = levels.includes(opt.value);
          return (
            <Pressable
              key={opt.value}
              onPress={() => toggleLevel(opt.value)}
              className={`rounded-full border px-3 py-1.5 ${on ? 'border-accent-500 bg-accent-500' : 'border-gray-300 dark:border-gray-600 bg-card dark:bg-gray-900'}`}
            >
              <Text className={`text-xs font-medium ${on ? 'text-white' : 'text-gray-700 dark:text-gray-300'}`}>
                {t(opt.label)}
              </Text>
            </Pressable>
          );
        })}
      </View>

      <Text className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
        {t('exportPref.consFields')}
      </Text>
      <View className="mb-4 flex-row flex-wrap gap-1.5">
        {CONSERVATION_OPTIONS.map((opt) => {
          const on = conservationFields.includes(opt.value);
          return (
            <Pressable
              key={opt.value}
              onPress={() => toggleConservation(opt.value)}
              className={`rounded-full border px-3 py-1.5 ${on ? 'border-emerald-500 bg-emerald-500' : 'border-gray-300 dark:border-gray-600 bg-card dark:bg-gray-900'}`}
            >
              <Text className={`text-xs font-medium ${on ? 'text-white' : 'text-gray-700 dark:text-gray-300'}`}>
                {t(opt.label)}
              </Text>
            </Pressable>
          );
        })}
      </View>
      <View className="mb-4 flex-row items-center justify-between border-b border-gray-100 dark:border-gray-800 py-3">
        <View className="flex-1 pr-3">
          <Text className="text-sm font-medium text-gray-900 dark:text-gray-100">
            {t('exportPref.consHideLc')}
          </Text>
          <Text className="text-xs text-gray-500 dark:text-gray-400">
            {t('exportPref.consHideLcHint')}
          </Text>
        </View>
        <Switch
          value={hideLowConcern}
          onValueChange={(v) => setSetting('export_conservation_hide_lc', v)}
        />
      </View>

        <View className="mb-3 border-t border-gray-200 dark:border-gray-700 pt-3">
          <Text className="mb-2 text-sm font-semibold text-gray-900 dark:text-gray-100">
            {t('projectExport.prefSection')}
          </Text>
          <AnalysisExportOptions />
        </View>
    </>
  );
}

/** Single-select pill, shared by the document-format and report-format rows. */
function Chip({ label, on, onPress }: { label: string; on: boolean; onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      className={`rounded-full border px-3 py-1.5 ${
        on
          ? 'border-emerald-600 bg-emerald-50 dark:bg-emerald-900/30'
          : 'border-gray-300 dark:border-gray-700'
      }`}
    >
      <Text
        className={`text-xs ${
          on ? 'font-semibold text-emerald-700 dark:text-emerald-300' : 'text-gray-600 dark:text-gray-400'
        }`}
      >
        {label}
      </Text>
    </Pressable>
  );
}
