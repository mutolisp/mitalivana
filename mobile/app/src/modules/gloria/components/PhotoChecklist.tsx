// check-controls-ignore: each photo item is a bordered chip that IS the checkbox; the glyph inside only mirrors its state.
/**
 * Photo checklist tab — Form 1's photo checkboxes, grouped like the form:
 * per direction the cluster overview, the p5m and p10m poles and the four
 * quadrats (without frame, with frame "hp", quarters UL UR LL LR), then the
 * intersection-line poles, the HSP and the entire summit.
 *
 * Tap ticks an item (photos are often taken with another camera). Long press
 * takes or picks a photo in the app, which also counts as done; the photo is
 * stored where that item's photo already lives (model/photoChecks sources).
 * The quarters are optional (manual Work Step P) and not in the progress.
 */
import { Ionicons } from '@expo/vector-icons';
import { useCallback, useMemo, useState } from 'react';
import { useFocusEffect } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { Alert, Pressable, Text, View } from 'react-native';
import { errText } from '~/lib/errText';
import { useToast } from '~/stores/toast';
import { listPhotoChecks, setPhotoCheck, updateGloriaSurvey, updatePoint } from '../db';
import { parseOverviewPhotos, serializeOverviewPhotos } from '../model/overview';
import { checklistState, QUADRAT_COLUMNS, type ItemState } from '../model/photoChecks';
import { CORNERS, DIAGONALS, DIRECTIONS } from '../model/units';
import { pickGloriaPhoto } from '../photo';
import type { SurveyState } from '../useSurvey';
import { Card, Label } from './ui';
import { useThemeColors } from '~/theme/colors';

export function PhotoChecklist({ state, reload }: { state: SurveyState; reload: () => void }) {
  const tc = useThemeColors();
  const { t } = useTranslation();
  const toast = useToast((s) => s.show);
  const sid = state.survey.id;
  const [checks, setChecks] = useState(() => listPhotoChecks(sid));
  const refresh = useCallback(() => setChecks(listPhotoChecks(sid)), [sid]);
  useFocusEffect(refresh);
  const overview = parseOverviewPhotos(state.survey.overview_photos);
  const cl = useMemo(
    () => checklistState({ checks, points: state.points, overviewCount: overview.length }),
    [checks, state.points, overview.length],
  );
  const byItem = useMemo(() => new Map(cl.items.map((s) => [s.item.item, s])), [cl]);
  const pointId = (key: string) => state.points.find((p) => p.point_key === key)?.id;

  const toggle = (s: ItemState) => {
    if (s.photo) {
      toast(t('gloria.photoCheck.hasPhoto'));
      return;
    }
    setPhotoCheck(sid, s.item.item, { checked: !s.checked });
    refresh();
  };
  const photo = async (s: ItemState, label: string) => {
    try {
      const r = await pickGloriaPhoto(label, s.photo != null && s.item.source.kind !== 'overview');
      if (r == null) return;
      const uri = r === 'remove' ? null : r;
      const src = s.item.source;
      if (src.kind === 'own') setPhotoCheck(sid, s.item.item, { photo_uri: uri });
      else if (src.kind === 'overview') {
        if (uri) updateGloriaSurvey(sid, { overview_photos: serializeOverviewPhotos([...overview, { uri, viewpoint: '' }]) });
      } else {
        const key = src.kind === 'p5m' ? (state.p5m[src.direction] ? src.direction + state.p5m[src.direction] : null) : src.key;
        const id = key ? pointId(key) : undefined;
        if (id == null) {
          Alert.alert(t('gloria.photoCheck.noP5mTitle'), t('gloria.photoCheck.noP5m', { direction: src.kind === 'p5m' ? src.direction : '' }));
          return;
        }
        updatePoint(id, { [src.kind === 'p5m' ? 'photo_point' : src.col]: uri });
      }
      refresh();
      reload();
    } catch (e) {
      toast(errText(e));
    }
  };

  const cell = (item: string, label: string, opts?: { wide?: boolean; a11y?: string }) => {
    const s = byItem.get(item);
    if (!s) return null;
    const optional = !s.item.required;
    const a11y = opts?.a11y ?? label;
    return (
      <Pressable
        key={item}
        onPress={() => toggle(s)}
        onLongPress={() => void photo(s, a11y)}
        accessibilityRole="checkbox"
        accessibilityState={{ checked: s.done }}
        accessibilityLabel={a11y}
        accessibilityHint={t('gloria.photoCheck.a11yHint')}
        className={`${opts?.wide ? 'flex-1 flex-row px-2.5' : 'w-10 justify-center'} h-9 items-center rounded-md border ${
          s.done
            ? 'border-accent-600 bg-accent-600'
            : optional
              ? 'border-dashed border-gray-300 dark:border-gray-600'
              : 'border-gray-300 dark:border-gray-600'
        }`}
      >
        <Ionicons name={s.done ? 'checkmark' : 'square-outline'} size={opts?.wide ? 16 : 14} color={s.done ? '#fff' : tc.ink3} />
        {opts?.wide ? (
          <Text className={`ml-1.5 flex-1 text-xs ${s.done ? 'font-semibold text-white' : 'text-gray-700 dark:text-gray-200'}`} numberOfLines={1}>
            {label}
          </Text>
        ) : null}
        {s.photo ? (
          <View className="absolute right-0.5 top-0.5">
            <Ionicons name="camera" size={9} color={s.done ? '#fff' : tc.accentPressed} />
          </View>
        ) : null}
      </Pressable>
    );
  };
  const colLabel: Record<(typeof QUADRAT_COLUMNS)[number], string> = {
    bare: t('gloria.photoCheck.bare'),
    hp: t('gloria.photoCheck.hp'),
    UL: 'UL',
    UR: 'UR',
    LL: 'LL',
    LR: 'LR',
  };
  const pct = Math.round((cl.required.done / cl.required.total) * 100);

  return (
    <View className="gap-3">
      <Card className="gap-1.5 p-3">
        <View className="flex-row items-baseline">
          <Text className="flex-1 text-sm font-semibold text-gray-900 dark:text-gray-100">{t('gloria.photoCheck.required')}</Text>
          <Text className="text-sm font-bold text-gray-900 dark:text-gray-100" style={{ fontVariant: ['tabular-nums'] }}>
            {`${cl.required.done} / ${cl.required.total}`}
          </Text>
        </View>
        <View className="h-2 overflow-hidden rounded-full bg-gray-200 dark:bg-gray-800">
          <View className="h-2 rounded-full bg-accent-600" style={{ width: `${pct}%` }} />
        </View>
        <Text className="text-xs text-gray-500 dark:text-gray-400">
          {t('gloria.photoCheck.optional', { done: cl.optional.done, total: cl.optional.total })}
        </Text>
        <Text className="text-[11px] text-gray-400">{t('gloria.photoCheck.hint')}</Text>
      </Card>

      {DIRECTIONS.map((d) => {
        const p5 = state.p5m[d];
        return (
          <View key={d} className="gap-1.5">
            <Label>{t(`gloria.photoCheck.dir${d}`)}</Label>
            <Card className="gap-2 p-2.5">
              <View className="flex-row gap-1.5">
                {cell(`CL-${d}`, t('gloria.photoCheck.cluster'), { wide: true })}
              </View>
              <View className="flex-row gap-1.5">
                {cell(`P5M-${d}`, p5 ? `5mp · p5m-${d}${p5}` : t('gloria.photoCheck.p5mUnset'), { wide: true })}
                {cell(`P10M-${d}`, `10mp · p10m-${d}`, { wide: true })}
              </View>
              <View className="flex-row items-center gap-1">
                <View className="w-10" />
                {QUADRAT_COLUMNS.map((c) => (
                  <Text key={c} className="w-10 text-center text-[10px] font-semibold text-gray-600 dark:text-gray-300">{colLabel[c]}</Text>
                ))}
              </View>
              {CORNERS.map((c) => {
                const q = d + c;
                return (
                  <View key={q} className="flex-row items-center gap-1">
                    <Text className="w-10 text-xs font-semibold text-gray-900 dark:text-gray-100">{q}</Text>
                    {QUADRAT_COLUMNS.map((col) => cell(`${q}:${col}`, colLabel[col], { a11y: `${q} ${colLabel[col]}` }))}
                  </View>
                );
              })}
            </Card>
          </View>
        );
      })}

      <Label>{t('gloria.photoCheck.intersection')}</Label>
      <Card className="gap-1.5 p-2.5">
        {[DIAGONALS.slice(0, 2), DIAGONALS.slice(2)].map((pair, i) => (
          <View key={i} className="flex-row gap-1.5">
            {pair.flatMap((g) => ['5', '10'].map((n) => cell(`p${g}-${n}`, `p${g}-${n}`, { wide: true })))}
          </View>
        ))}
      </Card>

      <Label>{t('gloria.photoCheck.summit')}</Label>
      <Card className="gap-1.5 p-2.5">
        <View className="flex-row gap-1.5">
          {cell('HSP', t('gloria.photoCheck.hsp'), { wide: true })}
          {cell('SU-OV', t('gloria.photoCheck.entire'), { wide: true })}
        </View>
      </Card>
    </View>
  );
}

/** Obligatory items not yet done — for the end-of-survey reminder. */
export function missingRequiredPhotos(state: SurveyState): number {
  const cl = checklistState({
    checks: listPhotoChecks(state.survey.id),
    points: state.points,
    overviewCount: parseOverviewPhotos(state.survey.overview_photos).length,
  });
  return cl.required.total - cl.required.done;
}
