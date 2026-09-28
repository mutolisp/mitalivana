/**
 * Read-only research report. `kind` selects the unit (plot for now; project
 * and session follow), `id` the record.
 *
 * The screen only assembles and renders — all figures come from the pure
 * report model, so what is on screen and what an export writes are the same
 * numbers by construction.
 */
import { File, Paths } from 'expo-file-system';
import { Stack, useLocalSearchParams } from 'expo-router';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { showActionSheet } from '~/components/ActionSheet';
import { pickExportLanguage } from '~/lib/pickExportLanguage';
import { ExportProgressOverlay } from '~/components/ExportProgressOverlay';
import { ReportView } from '~/components/report/ReportView';
import i18n from '~/i18n';
import { sanitizeFilename } from '~/lib/bundleExport';
import { DOC_FORMATS } from '~/lib/docFormat';
import { useSettings } from '~/stores/settings';
import { BackHeaderLeft } from '~/lib/goBack';
import {
  collectGloriaProjectReportInput,
  collectGloriaReportInput,
  collectPlotReportInput,
  collectProjectReportInput,
  collectSessionReportInput,
} from '~/lib/reportData';
import { buildGloriaProjectReport, buildGloriaReport, type GloriaReportFilter } from '~/lib/reportGloria';
import type { UnitKind } from '~/modules/gloria/model/stats';
import type { Direction } from '~/modules/gloria/model/units';
import {
  buildPlotReport,
  buildProjectReport,
  buildSessionReport,
  type Report,
  type Translate,
} from '~/lib/reportModel';
import { buildReportHtml } from '~/lib/reportHtml';
import { HeaderIconButton } from '~/components/HeaderIconButton';
import { useExportShare } from '~/lib/useExportShare';

/** Build the report in an arbitrary language — the same model code, with a
 *  translator pinned to `lang` instead of the UI's. */
const NO_FILTER: GloriaReportFilter = { dirs: [], types: [], summitIds: [] };

function buildFor(kind: string, id: number, tr: Translate, gloria: GloriaReportFilter = NO_FILTER): Report | null {
  if (kind === 'gloria') {
    const input = collectGloriaReportInput(id);
    return input ? buildGloriaReport(input, gloria, tr) : null;
  }
  if (kind === 'gloriaProject') {
    const input = collectGloriaProjectReportInput(id);
    return input ? buildGloriaProjectReport(input, gloria, tr) : null;
  }
  if (kind === 'plot') {
    const input = collectPlotReportInput(id);
    return input ? buildPlotReport(input, tr) : null;
  }
  if (kind === 'project') {
    const input = collectProjectReportInput(id);
    return input ? buildProjectReport(input, tr) : null;
  }
  if (kind === 'session') {
    const input = collectSessionReportInput(id);
    return input ? buildSessionReport(input, tr) : null;
  }
  return null;
}

export default function ReportScreen() {
  const { t } = useTranslation();
  const docFormat = useSettings((s) => s.export_doc_format);
  const { kind, id } = useLocalSearchParams<{ kind: string; id: string }>();
  const numericId = Number(id);
  const { busy, progress, shareBundle } = useExportShare();
  // GLORIA reports: which directions, unit types and (project) summits count.
  const isGloria = kind === 'gloria' || kind === 'gloriaProject';
  const [gloriaFilter, setGloriaFilter] = useState<GloriaReportFilter>(NO_FILTER);
  const summitOptions = useMemo(
    () =>
      kind === 'gloriaProject'
        ? (collectGloriaProjectReportInput(numericId)?.summits.map((s) => ({ id: s.summit.id, code: s.summit.full_code })) ?? [])
        : [],
    [kind, numericId],
  );

  const report: Report | null = useMemo(() => {
    if (!Number.isFinite(numericId)) return null;
    return buildFor(kind, numericId, t, gloriaFilter);
    // `t` is included so the whole report re-renders in the new language when
    // the user switches it — the model bakes translated strings in.
  }, [kind, numericId, t, gloriaFilter]);

  /**
   * Export flow: pick a format, then a language (current UI language first, so
   * the common case is two taps), then render and share. Shares the language
   * sheet with the checklist exports (`pickExportLanguage`), which follow the
   * same rule: prose and headings translate, names and DwC terms do not.
   */
  const handleShare = async () => {
    if (!report) return;
    const fmtIdx = await showActionSheet({
      title: t('report.exportFormat'),
      options: [
        { label: t('report.formatHtml') },
        { label: t(docFormat === 'odt' ? 'report.formatOdt' : 'report.formatDocx') },
      ],
    });
    if (fmtIdx < 0) return;
    const doc = fmtIdx === 1 ? DOC_FORMATS[docFormat] : null;

    const lang = await pickExportLanguage(t, 'report.exportLanguage');
    if (!lang) return;
    await shareBundle(async () => {
      // getFixedT gives a translator pinned to `lang` without touching the
      // UI's own language.
      const tr = i18n.getFixedT(lang) as unknown as Translate;
      const localised = buildFor(kind, numericId, tr, gloriaFilter) ?? report;
      const base = sanitizeFilename(localised.title);
      const filename = `${base}.${doc ? doc.ext : 'html'}`;
      const file = new File(Paths.cache, filename);
      if (file.exists) file.delete();
      file.create();
      // `write` takes bytes or a string; the document path is a real
      // OOXML / ODF package, the HTML path a single self-contained document.
      file.write(doc ? doc.report(localised) : buildReportHtml(localised, lang));
      return {
        uri: file.uri,
        filename,
        mimeType: doc ? doc.mime : 'text/html',
        UTI: doc ? doc.uti : 'public.html',
      };
    });
  };

  return (
    <SafeAreaView edges={['bottom']} className="flex-1 bg-gray-50 dark:bg-gray-950">
      <ExportProgressOverlay progress={progress} />
      <Stack.Screen
        options={{
          title: t('report.navTitle'),
          headerLeft: BackHeaderLeft,
          headerRight: () =>
            report ? (
              <HeaderIconButton
                icon="share-outline"
                onPress={handleShare}
                disabled={busy}
                label={t('common.export')}
              />
            ) : null,
        }}
      />
      {isGloria ? (
        <GloriaFilterBar value={gloriaFilter} onChange={setGloriaFilter} summits={summitOptions} />
      ) : null}
      {report ? (
        <ReportView report={report} />
      ) : (
        <View className="flex-1 items-center justify-center px-8">
          <Text className="text-center text-sm text-gray-500 dark:text-gray-400">
            {t('report.notAvailable')}
          </Text>
        </View>
      )}
    </SafeAreaView>
  );
}

const TYPE_KEYS: Array<[UnitKind, string]> = [
  ['quadrat', 'report.gloria.typeQuadrat'],
  ['sas', 'report.gloria.typeSas'],
  ['square', 'report.gloria.typeSquare'],
];
const DIR_KEYS: Direction[] = ['E', 'N', 'S', 'W'];

/** Toggle chips; an empty selection means "all". */
function GloriaFilterBar({
  value,
  onChange,
  summits,
}: {
  value: GloriaReportFilter;
  onChange: (f: GloriaReportFilter) => void;
  summits: Array<{ id: number; code: string }>;
}) {
  const { t } = useTranslation();
  const toggle = <T,>(list: T[], v: T) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);
  const chip = (label: string, on: boolean, press: () => void, key: string) => (
    <Pressable
      key={key}
      onPress={press}
      accessibilityRole="button"
      accessibilityState={{ selected: on }}
      className={`mr-1.5 rounded-full border px-3 py-1 ${on ? 'border-accent-600 bg-accent-600' : 'border-gray-300 dark:border-gray-600'}`}
    >
      <Text className={`text-xs ${on ? 'font-semibold text-white' : 'text-gray-700 dark:text-gray-300'}`}>{label}</Text>
    </Pressable>
  );
  const row = (label: string, children: React.ReactNode) => (
    <View className="flex-row items-center py-1">
      <Text className="w-14 text-[11px] text-gray-500 dark:text-gray-400">{label}</Text>
      <ScrollView horizontal showsHorizontalScrollIndicator={false}>
        {children}
      </ScrollView>
    </View>
  );
  return (
    <View className="border-b border-gray-200 bg-card px-3 py-1.5 dark:border-gray-800 dark:bg-gray-900">
      {row(t('report.gloria.types'), [
        chip(t('report.gloria.all'), value.types.length === 0, () => onChange({ ...value, types: [] }), 'all'),
        ...TYPE_KEYS.map(([k, key]) => chip(t(key), value.types.includes(k), () => onChange({ ...value, types: toggle(value.types, k) }), k)),
      ])}
      {row(t('report.gloria.directions'), [
        chip(t('report.gloria.all'), value.dirs.length === 0, () => onChange({ ...value, dirs: [] }), 'all'),
        ...DIR_KEYS.map((d) => chip(d, value.dirs.includes(d), () => onChange({ ...value, dirs: toggle(value.dirs, d) }), d)),
      ])}
      {summits.length > 1
        ? row(t('report.gloria.summits'), [
            chip(t('report.gloria.all'), value.summitIds.length === 0, () => onChange({ ...value, summitIds: [] }), 'all'),
            ...summits.map((s) =>
              chip(s.code, value.summitIds.includes(s.id), () => onChange({ ...value, summitIds: toggle(value.summitIds, s.id) }), String(s.id)),
            ),
          ])
        : null}
    </View>
  );
}

