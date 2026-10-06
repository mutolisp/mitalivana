/**
 * 建立新記錄 — the bottom sheet behind ＋ (03-screens-flow.md §2), replacing
 * the old showCreateChooser() ActionSheet and the long-press defaults menu.
 *
 *   await showCreateSheet();                  // first page
 *   await showCreateSheet({ page: 'plot' });  // straight to the plot types
 *
 * Imperative API + root host, like TextPromptModal: the host
 * (`<CreateSheetHost />`) is mounted once in app/_layout.tsx; its state lives
 * in src/lib/createSheet.ts. Drawn in the 15C card sheet's frame
 * (ChoiceSheet.tsx, 07-action-sheet.md §3), its pages its own.
 *
 * Pages. 樣區調查 does not close the sheet: it slides in the plot-type page
 * (replacing the ActionSheet createPlotPromptAndOpen used to show). The
 * survey-framework tile does the same while the test templates are offered:
 * one entry, its forms side by side (swipe left / right).
 *
 * An option that creates something CLOSES the sheet first and runs its action
 * only after the Modal has finished dismissing. Several actions open a Modal
 * of their own (the plotid prompt, the file picker), and iOS will not present
 * one while another is still going away — the second one silently never
 * appears.
 */
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';
import { useState } from 'react';
import { Pressable, ScrollView, Text, useWindowDimensions, View } from 'react-native';
import Animated, { SlideInLeft, SlideInRight } from 'react-native-reanimated';

import type { PlotType } from '~/db';
import { useCreateSheet } from '~/lib/createSheet';
import {
  createPlotOfType,
  importRecordPromptAndOpen,
  openMiren,
  openSurveyFrames,
  openNewGloria,
  startCollectionAndOpen,
  startModularOnFrameAndOpen,
  startModularSurveyAndOpen,
  startSessionAndOpen,
} from '~/lib/recordCreate';
import { templateName } from '~/survey/form/text';
import { SURVEY_FORMS_OFFERED } from '~/survey/templates/samples';
import { createTemplateFlow, templateIcon, templatesHref, userTemplates } from '~/survey/builder/drafts';
import { startCensusWithTemplate } from '~/survey/builder/start';
import { styleName } from '~/survey/builder/words';
import { labelText } from '~/survey/components/editors/shared';
import { router } from 'expo-router';
import { allowedRecordTypeDefaults, shows, type Cap } from '~/lib/usageMode';
import { useUsageMode } from '~/lib/useUsageMode';
import { useSettings, type RecordTypeDefault } from '~/stores/settings';
import { useThemeColors, type ThemeColors } from '~/theme/colors';
import { PointCountIcon, TransectIcon } from './PlotTypeIcons';
import { CHOICE_SHEET_MAX_WIDTH, ChoiceSheetFrame, ChoiceSheetHeader as SheetHeader, DISMISS_MS } from './ChoiceSheet';

export { showCreateSheet } from '~/lib/createSheet';

/** Page-to-page slide. */
const PAGE_MS = 220;

type Kind = 'session' | 'plot' | 'collection' | 'transect' | 'point_count';

const MAIN: {
  kind: Kind;
  /** 'transect' / 'pointCount' are drawn (PlotTypeIcons); the rest are Ionicons. */
  icon: keyof typeof Ionicons.glyphMap | 'transect' | 'pointCount';
  label: string;
  desc: string;
  tile: string;
  tint: keyof ThemeColors;
  /** Creates the record — except 樣區調查, which opens the next page. */
  run?: () => unknown;
  /** Shown only where the usage mode offers it (src/lib/usageMode.ts). */
  cap?: Cap;
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
    cap: 'createPlotTypes',
  },
  // Volunteer mode (18f): the two plot types it has, straight from the first
  // page, since the plot-type page also offers 固定樣區.
  {
    kind: 'transect',
    icon: 'transect',
    label: 'map.plotTransect',
    desc: 'create.plotTransectDesc',
    tile: 'bg-acorn-tint dark:bg-gray-800',
    tint: 'acornDeep',
    run: () => createPlotOfType('transect'),
    cap: 'createTransectPoint',
  },
  {
    kind: 'point_count',
    icon: 'pointCount',
    label: 'map.plotPointCount',
    desc: 'create.plotPointDesc',
    tile: 'bg-acorn-tint dark:bg-gray-800',
    tint: 'acornDeep',
    run: () => createPlotOfType('point_count'),
    cap: 'createTransectPoint',
  },
  {
    kind: 'collection',
    icon: 'pricetag-outline',
    label: 'record.kindCollection',
    desc: 'create.descCollection',
    tile: 'bg-gray-100 dark:bg-gray-800',
    tint: 'cupule',
    run: startCollectionAndOpen,
    cap: 'createCollection',
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
  { value: 'transect', label: 'map.plotTransect' },
  { value: 'point_count', label: 'map.plotPointCount' },
];

export function CreateSheetHost() {
  const visible = useCreateSheet((s) => s.resolve != null);
  const page = useCreateSheet((s) => s.page);
  const setPage = useCreateSheet((s) => s.setPage);
  const close = useCreateSheet((s) => s.close);

  const choose = (run: () => unknown) => {
    close();
    setTimeout(() => void run(), DISMISS_MS);
  };

  return (
    <ChoiceSheetFrame
      visible={visible}
      // Android back: second page → first page; first page → close.
      onBack={() => (page !== 'main' ? setPage('main') : close())}
      onClose={close}
    >
      {/* Keyed by page, so each page slides in as it mounts: the plot page
          from the right, the first page back from the left. The sheet's
          height follows whichever is showing. */}
      {page === 'plot' ? (
        <Animated.View key="plot" entering={SlideInRight.duration(PAGE_MS)}>
          <PlotPage onBack={() => setPage('main')} onClose={close} choose={choose} />
        </Animated.View>
      ) : page === 'survey' ? (
        <Animated.View key="survey" entering={SlideInRight.duration(PAGE_MS)}>
          <SurveyPage onBack={() => setPage('main')} onClose={close} choose={choose} />
        </Animated.View>
      ) : (
        <Animated.View key="main" entering={visible ? SlideInLeft.duration(PAGE_MS) : undefined}>
          <MainPage onPlot={() => setPage('plot')} onSurvey={() => setPage('survey')} onClose={close} choose={choose} />
        </Animated.View>
      )}
    </ChoiceSheetFrame>
  );
}

function MainPage({
  onPlot,
  onSurvey,
  onClose,
  choose,
}: {
  onPlot: () => void;
  onSurvey: () => void;
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
  const mode = useUsageMode();
  // The ＋ defaults the usage mode offers (casual mode has none).
  const allowedDefaults = allowedRecordTypeDefaults(mode);
  const defaults = DEFAULTS.filter((d) => allowedDefaults.includes(d.value));
  const cards = MAIN.filter((m) => !m.cap || shows(mode, m.cap));
  const modules = shows(mode, 'createModules');

  // `page`: opens a page of the sheet instead of creating at once.
  const others: { key: string; icon: keyof typeof Ionicons.glyphMap; label: string; run: () => unknown; page?: boolean }[] = [
    ...(modules && gloria ? [{ key: 'gloria', icon: 'triangle-outline' as const, label: 'GLORIA', run: openNewGloria }] : []),
    ...(modules && miren ? [{ key: 'miren', icon: 'trail-sign-outline' as const, label: 'MIREN', run: openMiren }] : []),
    ...(modules && survey
      ? [
          SURVEY_FORMS_OFFERED
            ? { key: 'survey', icon: 'albums-outline' as const, label: t('create.surveyTile'), run: onSurvey, page: true }
            : { key: 'survey', icon: 'apps-outline' as const, label: t('survey.create'), run: openSurveyFrames },
        ]
      : []),
    ...(shows(mode, 'importTile')
      ? [{ key: 'import', icon: 'download-outline' as const, label: t('create.importFile'), run: importRecordPromptAndOpen }]
      : []),
  ];

  return (
    <ScrollView contentContainerStyle={{ padding: 16, paddingTop: 12 }} bounces={false}>
      <SheetHeader title={t('record.createChooserTitle')} onClose={onClose} />

      <View className="gap-2">
        {cards.map((m) => {
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
                {m.icon === 'transect' ? (
                  <TransectIcon size={24} color={isDefault ? c.onAccent : c[m.tint]} />
                ) : m.icon === 'pointCount' ? (
                  <PointCountIcon size={24} color={isDefault ? c.onAccent : c[m.tint]} />
                ) : (
                  <Ionicons name={m.icon} size={24} color={isDefault ? c.onAccent : c[m.tint]} />
                )}
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

      {shows(mode, 'importPlanButton') ? (
        <Pressable
          onPress={() => choose(importRecordPromptAndOpen)}
          accessibilityRole="button"
          className="mt-3 flex-row items-center justify-center rounded-card border border-line bg-paper active:bg-gray-100 dark:border-line-dark dark:bg-paper-dark dark:active:bg-gray-800"
          style={{ minHeight: 52 }}
        >
          <Ionicons name="download-outline" size={18} color={c.ink2} />
          <Text className="ml-2 text-sm font-semibold text-gray-900 dark:text-gray-100">{t('create.importPlanFile')}</Text>
          <Text className="ml-1 text-sm text-gray-500 dark:text-gray-400">· .yml / .zip</Text>
        </Pressable>
      ) : null}

      {others.length > 0 ? (
        <>
          <Text className="mb-2 mt-4 text-sm font-medium text-gray-600 dark:text-gray-400">{t('create.others')}</Text>
          <View className="flex-row gap-2">
            {others.map((o) => (
              <Pressable
                key={o.key}
                onPress={() => (o.page ? o.run() : choose(o.run))}
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
        </>
      ) : null}

      {defaults.length > 0 ? (
        <>
          <View className="mt-4 h-px bg-line dark:bg-line-dark" />
          <Text className="mb-2 mt-4 text-sm font-medium text-gray-600 dark:text-gray-400">
            {t('create.plusDefault')}
          </Text>
          <View accessibilityRole="radiogroup" className="flex-row rounded-2xl bg-gray-100 p-1 dark:bg-gray-800">
            {defaults.map((d) => {
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
        </>
      ) : null}
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

/**
 * The survey framework's forms, one card each, side by side: swipe left /
 * right to choose (asked 2026-10-03). 每木調查 opens the permanent plots
 * (a census starts from its plot); the test templates start a survey here
 * (a plot-style one also on a permanent plot). Until the builder (2D).
 */
function SurveyPage({
  onBack,
  onClose,
  choose,
}: {
  onBack: () => void;
  onClose: () => void;
  choose: (run: () => unknown) => void;
}) {
  const { t, i18n } = useTranslation();
  const c = useThemeColors();
  // The page width from the window, not from a layout pass: measuring first
  // left the pager a sliver tall on Android (the cards drew outside it and
  // took no touches). The sheet spans the window (up to its 640 pt); 16 pt padding each side.
  const width = Math.min(useWindowDimensions().width, CHOICE_SHEET_MAX_WIDTH) - 32;
  const [index, setIndex] = useState(0);
  // Read once as the page opens (not on every render).
  const [templates] = useState(() => userTemplates());
  const cards: {
    key: string;
    icon: keyof typeof Ionicons.glyphMap;
    title: string;
    desc: string;
    actions: { label: string; run: () => unknown; primary?: boolean }[];
  }[] = [
    {
      key: 'stemmap',
      icon: 'apps-outline',
      title: t('survey.create'),
      desc: t('create.surveyStemDesc'),
      actions: [{ label: t('create.surveyOpenFrames'), run: openSurveyFrames, primary: true }],
    },
    // The user's own templates (the builder, 2D-a), each a card.
    ...templates.map((tpl) => ({
      key: tpl.id,
      icon: templateIcon(tpl.style),
      title: templateName(t, i18n.language, tpl),
      desc: [styleName(t, tpl.style), t('builder.version', { n: tpl.version }), tpl.description ? labelText(t, i18n.language, tpl.description) : null].filter(Boolean).join(' · '),
      // A census template starts a census on a permanent plot (2D-b).
      actions:
        tpl.style === 'individual'
          ? [{ label: t('builder.census.start'), run: () => startCensusWithTemplate(tpl), primary: true }]
          : [
              { label: t('create.startSurvey'), run: () => startModularSurveyAndOpen(tpl), primary: true },
              ...(tpl.style === 'plot' ? [{ label: t('create.surveyOnFrame'), run: () => startModularOnFrameAndOpen(tpl) }] : []),
            ],
    })),
    {
      key: 'builder',
      icon: 'construct-outline',
      title: t('builder.title'),
      desc: templates.length ? t('create.builderDesc') : t('create.builderDescEmpty'),
      actions: [
        { label: t('builder.create'), run: createTemplateFlow, primary: true },
        { label: t('create.builderManage'), run: () => router.push(templatesHref) },
      ],
    },
  ];
  return (
    <View style={{ padding: 16, paddingTop: 12 }}>
      <SheetHeader title={t('create.surveyTile')} subtitle={t('create.surveyPageSubtitle')} onBack={onBack} onClose={onClose} />
      <ScrollView
        horizontal
        pagingEnabled
        showsHorizontalScrollIndicator={false}
        style={{ flexGrow: 0 }}
        onMomentumScrollEnd={(e) => setIndex(Math.round(e.nativeEvent.contentOffset.x / width))}
      >
        {cards.map((card) => (
          <View key={card.key} style={{ width }} className="pr-0.5">
            <View className="gap-3 rounded-card border border-line bg-paper p-4 dark:border-line-dark dark:bg-paper-dark" style={{ minHeight: 232 }}>
              <View className="flex-row items-center gap-3">
                <View className="h-12 w-12 items-center justify-center rounded-xl bg-acorn-tint dark:bg-gray-800">
                  <Ionicons name={card.icon} size={24} color={c.acornDeep} />
                </View>
                <Text className="flex-1 text-lg font-bold text-gray-900 dark:text-gray-100">{card.title}</Text>
              </View>
              <Text className="text-sm leading-5 text-gray-600 dark:text-gray-300">{card.desc}</Text>
              <View className="mt-auto gap-2">
                {card.actions.map((a) => (
                  <Pressable
                    key={a.label}
                    onPress={() => choose(a.run)}
                    accessibilityRole="button"
                    className={`items-center justify-center rounded-full ${
                      a.primary ? 'bg-accent-600 active:bg-accent-700' : 'border border-line active:bg-gray-100 dark:border-line-dark dark:active:bg-gray-800'
                    }`}
                    style={{ minHeight: 48 }}
                  >
                    <Text className={`text-base font-bold ${a.primary ? 'text-white' : 'text-gray-900 dark:text-gray-100'}`}>{a.label}</Text>
                  </Pressable>
                ))}
              </View>
            </View>
          </View>
        ))}
      </ScrollView>
      <View className="mt-3 flex-row justify-center gap-2" accessibilityLabel={t('create.surveyPageOf', { n: index + 1, total: cards.length })}>
        {cards.map((card, i) => (
          <View key={card.key} className={`h-2 rounded-full ${i === index ? 'w-5 bg-accent-600 dark:bg-accent-400' : 'w-2 bg-gray-300 dark:bg-gray-600'}`} />
        ))}
      </View>
    </View>
  );
}
