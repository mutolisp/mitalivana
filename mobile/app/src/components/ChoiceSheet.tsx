/**
 * The 15C card sheet (07-action-sheet.md §3), for the starts of something new:
 * ＋ 建立記錄 (CreateRecordSheet, its own pages in this frame) and 建立模板
 * (showChoiceSheet).
 *
 *   const key = await showChoiceSheet({
 *     title: '建立模板',
 *     cards: [{ key: 'blank', title: '空白的名錄型', icon: 'list-outline', tone: 'primary' }],
 *     secondary: [{ key: 'import', label: '從檔案匯入', icon: 'download-outline' }],
 *   });
 *
 * Resolves with the key of the card or secondary button, or null — only once
 * the sheet has finished sliding away: what a choice starts often opens a
 * Modal of its own (a name prompt, the file picker), and iOS will not present
 * one while another is still going away (the second silently never appears).
 *
 * A Modal, unlike the 15A list sheet, so it carries an <ActionSheetLayer />
 * for any action sheet asked for while it is up.
 */
import { Ionicons } from '@expo/vector-icons';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Modal, Pressable, ScrollView, Text, useWindowDimensions, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { create } from 'zustand';

import { ActionSheetLayer, sheetBack } from '~/components/ActionSheet';
import { gridColumns } from '~/components/ui/CardGrid';
import { IconDisc } from '~/components/ui/IconDisc';
import { useThemeColors } from '~/theme/colors';

/** Long enough for the slide-out to finish on both platforms. */
export const DISMISS_MS = 450;
/** A wide screen keeps the sheet this wide, centred. */
export const CHOICE_SHEET_MAX_WIDTH = 640;
const MAX_WIDTH = CHOICE_SHEET_MAX_WIDTH;
const GAP = 10;

export type ChoiceCard = {
  key: string;
  title: string;
  description?: string;
  icon: keyof typeof Ionicons.glyphMap;
  /** 'primary': the accent tile (a blank start, the most common one). */
  tone?: 'primary' | 'default';
  /** A small tag on the card, e.g. 測試. */
  badge?: string;
};

export type ChoiceSheetRequest = {
  title: string;
  subtitle?: string;
  /** Two columns on a phone (≤ 6 recommended). */
  cards: ChoiceCard[];
  /** Dashed full-width buttons under the cards. */
  secondary?: { key: string; label: string; icon: keyof typeof Ionicons.glyphMap }[];
};

type ChoiceState = {
  req: (ChoiceSheetRequest & { resolve: (key: string | null) => void }) | null;
  visible: boolean;
};

const useChoice = create<ChoiceState>(() => ({ req: null, visible: false }));

export function showChoiceSheet(req: ChoiceSheetRequest): Promise<string | null> {
  return new Promise((resolve) => {
    useChoice.getState().req?.resolve(null);
    useChoice.setState({ req: { ...req, resolve }, visible: true });
  });
}

/** Closes the sheet; resolves once the Modal has gone. */
function settle(key: string | null) {
  const { req, visible } = useChoice.getState();
  if (!req || !visible) return;
  useChoice.setState({ visible: false });
  setTimeout(() => {
    if (useChoice.getState().req === req) useChoice.setState({ req: null });
    req.resolve(key);
  }, DISMISS_MS);
}

/**
 * The sheet itself: dim, rounded top, grabber, bottom safe area, an
 * <ActionSheetLayer />. `onBack`: Android back (CreateRecordSheet steps back a
 * page with it); `onClose`: a tap on the dim.
 */
export function ChoiceSheetFrame({
  visible,
  onBack,
  onClose,
  children,
}: {
  visible: boolean;
  onBack: () => void;
  onClose: () => void;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const { width } = useWindowDimensions();
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={sheetBack(onBack)}>
      <View className="flex-1 justify-end">
        <Pressable onPress={onClose} className="absolute inset-0 bg-black/40" accessibilityRole="button" accessibilityLabel={t('common.close')} />
        <SafeAreaView
          edges={['bottom']}
          className="overflow-hidden rounded-t-sheet bg-card dark:bg-card-dark"
          style={{ width: Math.min(width, MAX_WIDTH), alignSelf: 'center' }}
        >
          {/* Grabber: says "sheet", even though it is not draggable. */}
          <View className="items-center pt-2">
            <View className="h-[5px] w-9 rounded-full bg-gray-300 dark:bg-gray-600" />
          </View>
          {children}
        </SafeAreaView>
      </View>
      <ActionSheetLayer visible={visible} />
    </Modal>
  );
}

/** Title (and subtitle) with ✕; `onBack` adds a back button before it (a second page). */
export function ChoiceSheetHeader({ title, subtitle, onBack, onClose }: { title: string; subtitle?: string; onBack?: () => void; onClose: () => void }) {
  const { t } = useTranslation();
  return (
    <View className="mb-3 flex-row items-center">
      {onBack ? (
        <View className="mr-1">
          <IconDisc icon="back" onPress={onBack} accessibilityLabel={t('common.back')} edge="left" />
        </View>
      ) : null}
      <View className="flex-1">
        <Text accessibilityRole="header" className="text-2xl font-bold text-gray-900 dark:text-gray-100">
          {title}
        </Text>
        {subtitle ? <Text className="text-sm text-gray-500 dark:text-gray-400">{subtitle}</Text> : null}
      </View>
      <IconDisc icon="close" onPress={onClose} accessibilityLabel={t('common.close')} />
    </View>
  );
}

function Card({ card, width, onPress }: { card: ChoiceCard; width: number; onPress: () => void }) {
  const c = useThemeColors();
  const primary = card.tone === 'primary';
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      className="gap-2 rounded-2xl border border-line bg-card p-3 active:bg-gray-100 dark:border-line-dark dark:bg-card-dark dark:active:bg-gray-800"
      style={{ width, minHeight: 128 }}
    >
      <View className="flex-row items-start justify-between">
        <View className={`h-11 w-11 items-center justify-center rounded-xl ${primary ? 'bg-accent-tint dark:bg-accent-900' : 'bg-acorn-wash dark:bg-gray-800'}`}>
          <Ionicons name={card.icon} size={22} color={primary ? c.accent : c.cupule} />
        </View>
        {card.badge ? (
          <View className="rounded bg-gray-100 px-1.5 dark:bg-gray-800">
            <Text className="text-xs font-bold text-gray-600 dark:text-gray-300">{card.badge}</Text>
          </View>
        ) : null}
      </View>
      <Text className="text-base font-bold text-gray-900 dark:text-gray-100">{card.title}</Text>
      {card.description ? <Text className="text-xs leading-4 text-ink-3 dark:text-gray-400">{card.description}</Text> : null}
    </Pressable>
  );
}

/** The host of showChoiceSheet(), in app/_layout.tsx. */
export function ChoiceSheetHost() {
  const c = useThemeColors();
  const req = useChoice((s) => s.req);
  const visible = useChoice((s) => s.visible);
  const { width } = useWindowDimensions();
  const sheetW = Math.min(width, MAX_WIDTH);
  // CardGrid's columns for the sheet's width, at most 4.
  const columns = Math.min(4, gridColumns(sheetW));
  const cardW = (sheetW - 32 - GAP * (columns - 1)) / columns;
  const close = () => settle(null);
  return (
    <ChoiceSheetFrame visible={visible} onBack={close} onClose={close}>
      {req ? (
        <ScrollView contentContainerStyle={{ padding: 16, paddingTop: 12 }} bounces={false}>
          <ChoiceSheetHeader title={req.title} subtitle={req.subtitle} onClose={close} />
          <View className="flex-row flex-wrap" style={{ gap: GAP }}>
            {req.cards.map((card) => (
              <Card key={card.key} card={card} width={cardW} onPress={() => settle(card.key)} />
            ))}
          </View>
          {req.secondary?.map((s) => (
            <Pressable
              key={s.key}
              onPress={() => settle(s.key)}
              accessibilityRole="button"
              className="mt-3 flex-row items-center justify-center rounded-2xl border-[1.5px] border-dashed border-gray-300 active:bg-gray-100 dark:border-gray-600 dark:active:bg-gray-800"
              style={{ minHeight: 48 }}
            >
              <Ionicons name={s.icon} size={18} color={c.ink2} />
              <Text className="ml-2 text-sm font-semibold text-gray-900 dark:text-gray-100">{s.label}</Text>
            </Pressable>
          ))}
        </ScrollView>
      ) : null}
    </ChoiceSheetFrame>
  );
}
