/**
 * 觀察筆記 — a record's notes with prompts by kind of organism (design 18l):
 * what to look at, one tap to start a line of the note, and the photo or
 * recording that most helps a later identification. A plant also gets its
 * flowering / fruiting state as chips (`reproductive_condition`).
 *
 * Volunteer and casual mode only (`observationNotes` in src/lib/usageMode.ts);
 * pro mode keeps the plain notes field. The tips are src/lib/observationTips.ts.
 *
 * The note is edited here. Where the parent writes it straight to the record
 * it is committed on blur, after a tip is inserted and when this unmounts
 * (closing a sheet does not blur the field first — the end of a note was
 * lost that way). Where the parent only keeps a draft for its own 儲存,
 * `commitOnChange` hands over every keystroke instead: tapping 儲存 does not
 * blur the field either.
 */
import { Ionicons } from '@expo/vector-icons';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, Text, TextInput, View } from 'react-native';

import { reproductiveOptions, toggleMultiValue } from '~/lib/dwcAttributes';
import { appendStarter, TIP_SETS, tipGroupOf } from '~/lib/observationTips';
import { useThemeColors } from '~/theme/colors';

export function ObservationNotes({
  kingdom,
  className,
  note,
  onCommitNote,
  repro,
  onChangeRepro,
  onTakePhoto,
  commitOnChange = false,
}: {
  kingdom: string | null | undefined;
  className: string | null | undefined;
  note: string | null;
  onCommitNote: (next: string) => void;
  /** A plant's flowering / fruiting state; the chips show when both are given. */
  repro?: string[];
  onChangeRepro?: (next: string[]) => void;
  /** Opens the camera for the tip's close-up; the button shows when given. */
  onTakePhoto?: () => void;
  /** The parent keeps a draft and saves it itself: pass every change up. */
  commitOnChange?: boolean;
}) {
  const { t } = useTranslation();
  const c = useThemeColors();
  const set = TIP_SETS[tipGroupOf(kingdom, className)];
  const [draft, setDraft] = useState(note ?? '');
  const committed = useRef(note ?? '');
  const input = useRef<TextInput>(null);

  // A different record, or the note changed elsewhere (undo): take it.
  useEffect(() => {
    committed.current = note ?? '';
    setDraft(note ?? '');
  }, [note]);

  const commit = (next: string) => {
    if (next === committed.current) return;
    committed.current = next;
    onCommitNote(next);
  };

  // Unmounting with an uncommitted edit (the sheet closed while typing): keep it.
  const latest = useRef({ draft, onCommitNote });
  useLayoutEffect(() => {
    latest.current = { draft, onCommitNote };
  });
  useEffect(
    () => () => {
      const { draft: last, onCommitNote: save } = latest.current;
      if (last !== committed.current) save(last);
    },
    [],
  );

  const showRepro = kingdom === 'Plantae' && repro !== undefined && onChangeRepro !== undefined;

  return (
    <View className="mt-4 rounded-card border border-line bg-card p-3 dark:border-line-dark dark:bg-card-dark">
      <View className="flex-row items-baseline">
        <Text className="text-base font-semibold text-gray-900 dark:text-gray-100">{t('obsNotes.title')}</Text>
        <Text className="ml-2 flex-1 text-xs text-gray-500 dark:text-gray-400" numberOfLines={1}>
          {t('obsNotes.subtitle', { group: t(set.name) })}
        </Text>
      </View>

      {showRepro ? (
        <View className="mt-3">
          <Text className="mb-1.5 text-sm text-gray-700 dark:text-gray-300">{t('obsNotes.reproQuestion')}</Text>
          <View className="flex-row flex-wrap gap-2">
            {reproductiveOptions().map((o) => {
              const on = repro.includes(o.value);
              return (
                <Pressable
                  key={o.value}
                  onPress={() => onChangeRepro(toggleMultiValue(repro, o.value))}
                  accessibilityRole="checkbox"
                  accessibilityState={{ checked: on }}
                  className={`justify-center rounded-full border px-3.5 ${
                    on
                      ? 'border-accent-600 bg-accent-600 dark:border-accent-500 dark:bg-accent-500'
                      : 'border-line bg-paper active:bg-gray-100 dark:border-line-dark dark:bg-paper-dark dark:active:bg-gray-800'
                  }`}
                  style={{ minHeight: 36 }}
                >
                  <Text className={`text-sm font-medium ${on ? 'text-white' : 'text-gray-900 dark:text-gray-100'}`}>
                    {o.label}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        </View>
      ) : null}

      <View className="mt-3 flex-row items-center rounded-lg bg-acorn-wash px-3 py-2 dark:bg-gray-800">
        <Ionicons name={set.shot.button ? 'camera-outline' : 'mic-outline'} size={18} color={c.acornDeep} />
        <Text className="ml-2 flex-1 text-sm text-gray-700 dark:text-gray-300">{t(set.shot.text)}</Text>
        {set.shot.button && onTakePhoto ? (
          <Pressable
            onPress={onTakePhoto}
            accessibilityRole="button"
            className="ml-2 justify-center rounded-full border border-line bg-card px-3 active:bg-gray-100 dark:border-line-dark dark:bg-card-dark dark:active:bg-gray-700"
            style={{ minHeight: 36 }}
          >
            <Text className="text-sm font-medium text-gray-900 dark:text-gray-100">{t(set.shot.button)}</Text>
          </Pressable>
        ) : null}
      </View>

      <Text className="mb-1.5 mt-3 text-sm text-gray-700 dark:text-gray-300">{t('obsNotes.tipsHeading')}</Text>
      <View className="flex-row flex-wrap gap-2">
        {set.tips.map((tip) => (
          <Pressable
            key={tip.label}
            onPress={() => {
              const next = appendStarter(draft, t(tip.starter));
              setDraft(next);
              commit(next);
              input.current?.focus();
            }}
            accessibilityRole="button"
            className="flex-row items-center rounded-full border border-line bg-paper px-3 active:bg-gray-100 dark:border-line-dark dark:bg-paper-dark dark:active:bg-gray-800"
            style={{ minHeight: 36 }}
          >
            <Ionicons name="add" size={14} color={c.ink2} />
            <Text className="ml-1 text-sm text-gray-900 dark:text-gray-100">{t(tip.label)}</Text>
          </Pressable>
        ))}
      </View>

      <TextInput
        ref={input}
        value={draft}
        onChangeText={(next) => {
          setDraft(next);
          if (commitOnChange) commit(next);
        }}
        onBlur={() => commit(draft)}
        placeholder={t(set.placeholder)}
        placeholderTextColor={c.ink3}
        multiline
        accessibilityLabel={t('obsNotes.title')}
        className="mt-3 rounded-lg border border-line bg-paper px-3 py-2 text-base text-gray-900 dark:border-line-dark dark:bg-paper-dark dark:text-gray-100"
        style={{ minHeight: 88, textAlignVertical: 'top' }}
      />
    </View>
  );
}
