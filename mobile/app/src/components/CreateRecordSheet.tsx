/**
 * 建立新記錄 — the bottom sheet behind ＋ (03-screens-flow.md §2), replacing
 * the old showCreateChooser() ActionSheet and the long-press defaults menu.
 *
 *   await showCreateSheet();                  // first page
 *   await showCreateSheet({ page: 'plot' });  // straight to the plot types
 *
 * Imperative API + root host, like ActionSheet / TextPromptModal: the host
 * (`<CreateSheetHost />`) is mounted once in app/_layout.tsx; its state lives
 * in src/lib/createSheet.ts.
 *
 * Two pages. 樣區調查 does not close the sheet: it slides in the plot-type page
 * (replacing the ActionSheet createPlotPromptAndOpen used to show).
 *
 * An option that creates something CLOSES the sheet first and runs its action
 * only after the Modal has finished dismissing. Several actions open a Modal
 * of their own (the plotid prompt, the file picker), and iOS will not present
 * one while another is still going away — the second one silently never
 * appears.
 */
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';
import { Modal, Pressable, ScrollView, Text, View } from 'react-native';
import Animated, { SlideInLeft, SlideInRight } from 'react-native-reanimated';
import { SafeAreaView } from 'react-native-safe-area-context';

import type { PlotType } from '~/db';
import { useCreateSheet } from '~/lib/createSheet';
import {
  createPlotOfType,
  importRecordPromptAndOpen,
  openMiren,
  openSurveyFrames,
  openNewGloria,
  startCollectionAndOpen,
  startSessionAndOpen,
} from '~/lib/recordCreate';
import { useSettings, type RecordTypeDefault } from '~/stores/settings';
import { useThemeColors, type ThemeColors } from '~/theme/colors';
import { PointCountIcon, TransectIcon } from './PlotTypeIcons';
import { IconDisc } from '~/components/ui/IconDisc';

export { showCreateSheet } from '~/lib/createSheet';

/** Long enough for the slide-out to finish on both platforms. */
const DISMISS_MS = 450;
/** Page-to-page slide. */
const PAGE_MS = 220;

type Kind = 'session' | 'plot' | 'collection';

const MAIN: {
  kind: Kind;
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  desc: string;
  tile: string;
  tint: keyof ThemeColors;
  /** Creates the record — except 樣區調查, which opens the next page. */
  run?: () => unknown;
}[] = [
  {
    kind: 'session',
    icon: 'list',
    label: 'record.kindSession',
    desc: 'create.descSession',
    tile: 'bg-accent-100 dark:bg-accent-900',
    tint: 'accent',
    run: startSessionAndOpen,
  },
  {
    kind: 'plot',
    icon: 'grid-outline',
    label: 'record.kindPlot',
    desc: 'create.descPlot',
    tile: 'bg-acorn-tint dark:bg-gray-800',
    tint: 'acornDeep',
  },
  {
    kind: 'collection',
    icon: 'pricetag-outline',
    label: 'record.kindCollection',
    desc: 'create.descCollection',
    tile: 'bg-gray-100 dark:bg-gray-800',
    tint: 'cupule',
    run: startCollectionAndOpen,
  },
];

const PLOT_TYPES: {
  type: PlotType;
  /** 'transect' / 'pointCount' are drawn (PlotTypeIcons); the rest are Ionicons. */
  icon: keyof typeof Ionicons.glyphMap | 'transect' | 'pointCount';
  label: string;
  desc: string;
  traits: string[];
}[] = [
  {
    type: 'fixed',
    icon: 'grid-outline',
    label: 'map.plotFixed',
    desc: 'create.plotFixedDesc',
    traits: ['create.traitLayers', 'create.traitDefault4', 'create.traitSubplots'],
  },
  {
    type: 'transect',
    icon: 'transect',
    label: 'map.plotTransect',
    desc: 'create.plotTransectDesc',
    traits: ['create.traitSingleLayer', 'create.traitTrack'],
  },
  {
    type: 'point_count',
    icon: 'pointCount',
    label: 'map.plotPointCount',
    desc: 'create.plotPointDesc',
    traits: ['create.traitSingleLayer', 'create.traitRadius'],
  },
];

const DEFAULTS: { value: RecordTypeDefault; label: string }[] = [
  { value: 'ask', label: 'create.ask' },
  { value: 'session', label: 'record.kindSession' },
  { value: 'plot', label: 'nav.plot' },
  { value: 'collection', label: 'nav.collection' },
];

export function CreateSheetHost() {
  const { t } = useTranslation();
  const visible = useCreateSheet((s) => s.resolve != null);
  const page = useCreateSheet((s) => s.page);
  const setPage = useCreateSheet((s) => s.setPage);
  const close = useCreateSheet((s) => s.close);

  const choose = (run: () => unknown) => {
    close();
    setTimeout(() => void run(), DISMISS_MS);
  };

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      // Android back: second page → first page; first page → close.
      onRequestClose={() => (page === 'plot' ? setPage('main') : close())}
    >
      <View className="flex-1 justify-end">
        <Pressable
          onPress={close}
          className="absolute inset-0 bg-black/40"
          accessibilityRole="button"
          accessibilityLabel={t('common.close')}
        />
        <SafeAreaView edges={['bottom']} className="overflow-hidden rounded-t-sheet bg-card dark:bg-card-dark">
          {/* Grabber: says "sheet", even though it is not draggable. */}
          <View className="items-center pt-2">
            <View className="h-1.5 w-10 rounded-full bg-gray-300 dark:bg-gray-600" />
          </View>
          {/* Keyed by page, so each page slides in as it mounts: the plot page
              from the right, the first page back from the left. The sheet's
              height follows whichever is showing. */}
          {page === 'plot' ? (
            <Animated.View key="plot" entering={SlideInRight.duration(PAGE_MS)}>
              <PlotPage onBack={() => setPage('main')} onClose={close} choose={choose} />
            </Animated.View>
          ) : (
            <Animated.View key="main" entering={visible ? SlideInLeft.duration(PAGE_MS) : undefined}>
              <MainPage onPlot={() => setPage('plot')} onClose={close} choose={choose} />
            </Animated.View>
          )}
        </SafeAreaView>
      </View>
    </Modal>
  );
}

function SheetHeader({
  title,
  subtitle,
  onBack,
  onClose,
}: {
  title: string;
  subtitle?: string;
  onBack?: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const c = useThemeColors();
  return (
    <View className="mb-3 flex-row items-center">
      {onBack ? (
        <View className="mr-1">
          <IconDisc icon="back" onPress={onBack} accessibilityLabel={t('common.back')} edge="left" />
        </View>
      ) : null}
      <View className="flex-1">
        <Text className="text-2xl font-bold text-gray-900 dark:text-gray-100">{title}</Text>
        {subtitle ? <Text className="text-sm text-gray-500 dark:text-gray-400">{subtitle}</Text> : null}
      </View>
      <Pressable
        onPress={onClose}
        accessibilityRole="button"
        accessibilityLabel={t('common.close')}
        className="h-11 w-11 items-center justify-center rounded-full active:bg-gray-100 dark:active:bg-gray-800"
      >
        <Ionicons name="close" size={24} color={c.ink2} />
      </Pressable>
    </View>
  );
}

function MainPage({
  onPlot,
  onClose,
  choose,
}: {
  onPlot: () => void;
  onClose: () => void;
  choose: (run: () => unknown) => void;
}) {
  const { t } = useTranslation();
  const c = useThemeColors();
  const recordTypeDefault = useSettings((s) => s.record_type_default);
  const setSetting = useSettings((s) => s.set);
  const gloria = useSettings((s) => s.module_gloria);
  const miren = useSettings((s) => s.module_miren);
  const survey = useSettings((s) => s.module_survey);

  const others: { key: string; icon: keyof typeof Ionicons.glyphMap; label: string; run: () => unknown }[] = [
    ...(gloria ? [{ key: 'gloria', icon: 'triangle-outline' as const, label: 'GLORIA', run: openNewGloria }] : []),
    ...(miren ? [{ key: 'miren', icon: 'trail-sign-outline' as const, label: 'MIREN', run: openMiren }] : []),
    ...(survey ? [{ key: 'survey', icon: 'apps-outline' as const, label: t('survey.create'), run: openSurveyFrames }] : []),
    { key: 'import', icon: 'download-outline', label: t('create.importFile'), run: importRecordPromptAndOpen },
  ];

  return (
    <ScrollView contentContainerStyle={{ padding: 16, paddingTop: 12 }} bounces={false}>
      <SheetHeader title={t('record.createChooserTitle')} onClose={onClose} />

      <View className="gap-2">
        {MAIN.map((m) => {
          const isDefault = recordTypeDefault === m.kind;
          const run = m.run;
          return (
            <Pressable
              key={m.kind}
              onPress={() => (run ? choose(run) : onPlot())}
              accessibilityRole="button"
              // The default is filled in, not just outlined: it is what ＋
              // does without asking, so it should read as chosen.
              className={`flex-row items-center rounded-card px-3 ${
                isDefault
                  ? 'border-[1.5px] border-accent-600 bg-accent-50 active:bg-accent-100 dark:border-accent-400 dark:bg-accent-950 dark:active:bg-accent-900'
                  : 'border border-line active:bg-gray-100 dark:border-line-dark dark:active:bg-gray-800'
              }`}
              style={{ minHeight: 76 }}
            >
              <View
                className={`mr-3 h-12 w-12 items-center justify-center rounded-xl ${
                  isDefault ? 'bg-accent-600 dark:bg-accent-400' : m.tile
                }`}
              >
                <Ionicons name={m.icon} size={24} color={isDefault ? c.onAccent : c[m.tint]} />
              </View>
              <View className="flex-1 py-3">
                <Text className="text-lg font-bold text-gray-900 dark:text-gray-100">{t(m.label)}</Text>
                <Text className="mt-0.5 text-sm text-gray-500 dark:text-gray-400">{t(m.desc)}</Text>
              </View>
              {isDefault ? (
                <View className="ml-2 rounded-full bg-accent-100 px-2.5 py-0.5 dark:bg-accent-900">
                  <Text className="text-xs font-bold text-accent-700 dark:text-accent-300">
                    {t('create.isDefault')}
                  </Text>
                </View>
              ) : null}
              {/* A next page, not an immediate create. */}
              {run ? null : <Ionicons name="chevron-forward" size={20} color={c.ink3} style={{ marginLeft: 4 }} />}
            </Pressable>
          );
        })}
      </View>

      <Text className="mb-2 mt-4 text-sm font-medium text-gray-600 dark:text-gray-400">{t('create.others')}</Text>
      <View className="flex-row gap-2">
        {others.map((o) => (
          <Pressable
            key={o.key}
            onPress={() => choose(o.run)}
            accessibilityRole="button"
            accessibilityLabel={o.label}
            className="flex-1 items-center justify-center rounded-card border border-line bg-paper active:bg-gray-100 dark:border-line-dark dark:bg-paper-dark dark:active:bg-gray-800"
            style={{ minHeight: 64 }}
          >
            <Ionicons name={o.icon} size={20} color={c.ink2} />
            <Text className="mt-1 text-sm font-semibold text-gray-900 dark:text-gray-100" numberOfLines={1}>
              {o.label}
            </Text>
          </Pressable>
        ))}
        {/* Keep tiles a third wide however many modules are on. */}
        {others.length < 3
          ? Array.from({ length: 3 - others.length }, (_, i) => <View key={`pad-${i}`} className="flex-1" />)
          : null}
      </View>

      <View className="mt-4 h-px bg-line dark:bg-line-dark" />
      <Text className="mb-2 mt-4 text-sm font-medium text-gray-600 dark:text-gray-400">
        {t('create.plusDefault')}
      </Text>
      <View accessibilityRole="radiogroup" className="flex-row rounded-2xl bg-gray-100 p-1 dark:bg-gray-800">
        {DEFAULTS.map((d) => {
          const selected = recordTypeDefault === d.value;
          return (
            <Pressable
              key={d.value}
              onPress={() => setSetting('record_type_default', d.value)}
              accessibilityRole="radio"
              accessibilityState={{ selected }}
              className={`flex-1 items-center justify-center rounded-xl px-1 ${
                selected ? 'bg-card dark:bg-card-dark' : ''
              }`}
              style={
                selected
                  ? {
                      minHeight: 44,
                      elevation: 2,
                      shadowColor: 'black',
                      shadowOpacity: 0.08,
                      shadowRadius: 3,
                      shadowOffset: { width: 0, height: 1 },
                    }
                  : { minHeight: 44 }
              }
            >
              <Text
                numberOfLines={1}
                className={`text-sm ${
                  selected ? 'font-bold text-gray-900 dark:text-gray-100' : 'font-medium text-gray-600 dark:text-gray-300'
                }`}
              >
                {t(d.label)}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </ScrollView>
  );
}

/**
 * 樣區調查 → which kind of plot (design 02b). Choosing one closes the sheet
 * and hands over to createPlotOfType: the conflict check, then the plotid
 * prompt (TextPromptModal — a keyboard does not belong in a bottom sheet).
 */
function PlotPage({
  onBack,
  onClose,
  choose,
}: {
  onBack: () => void;
  onClose: () => void;
  choose: (run: () => unknown) => void;
}) {
  const { t } = useTranslation();
  const c = useThemeColors();
  return (
    <ScrollView contentContainerStyle={{ padding: 16, paddingTop: 12 }} bounces={false}>
      <SheetHeader
        title={t('record.kindPlot')}
        subtitle={t('create.plotPageSubtitle')}
        onBack={onBack}
        onClose={onClose}
      />
      <View className="gap-2">
        {PLOT_TYPES.map((p) => (
          <Pressable
            key={p.type}
            onPress={() => choose(() => createPlotOfType(p.type))}
            accessibilityRole="button"
            className="flex-row items-center rounded-card border border-line px-3 active:bg-gray-100 dark:border-line-dark dark:active:bg-gray-800"
            style={{ minHeight: 92 }}
          >
            <View className="mr-3 h-12 w-12 items-center justify-center rounded-xl bg-acorn-tint dark:bg-gray-800">
              {p.icon === 'transect' ? (
                <TransectIcon size={24} color={c.acornDeep} />
              ) : p.icon === 'pointCount' ? (
                <PointCountIcon size={24} color={c.acornDeep} />
              ) : (
                <Ionicons name={p.icon} size={24} color={c.acornDeep} />
              )}
            </View>
            <View className="flex-1 py-3">
              <Text className="text-lg font-bold text-gray-900 dark:text-gray-100">{t(p.label)}</Text>
              <Text className="mt-0.5 text-sm text-gray-500 dark:text-gray-400">{t(p.desc)}</Text>
              <View className="mt-1.5 flex-row flex-wrap gap-1">
                {p.traits.map((k) => (
                  <View key={k} className="rounded bg-gray-100 px-1.5 dark:bg-gray-800">
                    <Text className="text-xs font-bold text-gray-600 dark:text-gray-300">{t(k)}</Text>
                  </View>
                ))}
              </View>
            </View>
            <Ionicons name="chevron-forward" size={20} color={c.ink3} style={{ marginLeft: 4 }} />
          </Pressable>
        ))}
      </View>
      <Pressable
        onPress={() => choose(importRecordPromptAndOpen)}
        accessibilityRole="button"
        className="mt-3 flex-row items-center justify-center rounded-card border border-line bg-paper active:bg-gray-100 dark:border-line-dark dark:bg-paper-dark dark:active:bg-gray-800"
        style={{ minHeight: 52 }}
      >
        <Ionicons name="download-outline" size={18} color={c.ink2} />
        <Text className="ml-2 text-sm font-semibold text-gray-900 dark:text-gray-100">
          {t('create.importPlot')}
        </Text>
        <Text className="ml-1 text-sm text-gray-500 dark:text-gray-400">· .yml / .zip</Text>
      </Pressable>
    </ScrollView>
  );
}
