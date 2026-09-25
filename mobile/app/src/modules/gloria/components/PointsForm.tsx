/**
 * Base data (sheet 02_): 28 measurement points — distance and compass from
 * the HSP, the p5m choice, photo checks — plus the 3×3 m set-up check per
 * direction. Values carried from the previous cycle show as they are; a
 * field that now differs from last time is tinted.
 */
import { Ionicons } from '@expo/vector-icons';
import { useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, Text, View, type TextInput } from 'react-native';
import { useToast } from '~/stores/toast';
import { errText } from '~/lib/errText';
import { listPoints, setP5m, updateGloriaSurvey, updatePoint, type GloriaPoint } from '../db';
import { CORNERS, DIAGONALS, DIRECTIONS, type Direction } from '../model/units';
import { pickGloriaPhoto } from '../photo';
import type { SurveyState } from '../useSurvey';
import { Banner, BannerText, Card, NumField } from './ui';
import { RANGES } from '../model/ranges';

type PhotoCol = 'photo_m2' | 'photo_m2f' | 'photo_point';

export function PointsForm({ state, reload, onHelp }: { state: SurveyState; reload: () => void; onHelp: (d: Direction) => void }) {
  const { t } = useTranslation();
  const toast = useToast((s) => s.show);
  const byKey = useMemo(() => new Map(state.points.map((p) => [p.point_key, p])), [state.points]);
  const prev = useMemo(() => {
    const id = state.survey.prev_survey_id;
    return new Map(id != null ? listPoints(id).map((p) => [p.point_key, p]) : []);
  }, [state.survey.prev_survey_id]);

  // Field order for "next": distance then compass, point by point, in sheet order.
  const order: string[] = [];
  for (const d of DIRECTIONS) for (const k of [...CORNERS.map((c) => d + c), `${d}10m`]) order.push(`${k}.d`, `${k}.c`);
  for (const g of DIAGONALS) for (const k of [`${g}5`, `${g}10`]) order.push(`${k}.d`, `${k}.c`);
  const refs = useRef<Record<string, TextInput | null>>({});
  const next = (id: string) => () => refs.current[order[order.indexOf(id) + 1]]?.focus();

  const setVal = (p: GloriaPoint, col: 'distance_m' | 'compass_deg', v: number | null) => {
    updatePoint(p.id, { [col]: v });
    reload();
  };
  const changed = (p: GloriaPoint, col: 'distance_m' | 'compass_deg') => {
    const was = prev.get(p.point_key);
    return !!was && was[col] !== p[col];
  };
  const photo = async (p: GloriaPoint, col: PhotoCol, label: string) => {
    try {
      const r = await pickGloriaPhoto(label, p[col] != null);
      if (r == null) return;
      updatePoint(p.id, { [col]: r === 'remove' ? null : r });
      reload();
    } catch (e) {
      toast(errText(e));
    }
  };

  const photoBtn = (p: GloriaPoint, col: PhotoCol, text: string, label: string) => {
    const done = p[col] != null;
    return (
      <Pressable
        key={col}
        onPress={() => void photo(p, col, label)}
        accessibilityLabel={label}
        className={`ml-1 flex-row items-center rounded-md border px-1.5 py-1 ${
          done ? 'border-[#00A2A5] bg-[#00A2A5]' : 'border-gray-300 dark:border-gray-700'
        }`}
      >
        <Ionicons name={done ? 'checkmark' : 'camera-outline'} size={11} color={done ? '#fff' : '#6b7280'} />
        <Text className={`ml-0.5 text-[10px] ${done ? 'text-white' : 'text-gray-600 dark:text-gray-300'}`}>{text}</Text>
      </Pressable>
    );
  };

  // Plain render functions, not components: a component declared in here would
  // remount on every reload and drop the focused field.
  const row = (k: string, label: string, p5mCorner?: '11' | '31', dir?: Direction) => {
    const p = byKey.get(k);
    if (!p) return null;
    const isCorner = /^[NESW](11|13|31|33)$/.test(k);
    return (
      <View key={k} className="flex-row items-center border-t border-gray-100 px-2 py-1.5 dark:border-gray-800">
        <Text className="w-9 text-xs font-semibold text-gray-900 dark:text-gray-100">{label}</Text>
        <View className="w-8 items-center">
          {p5mCorner && dir ? (
            <Pressable
              onPress={() => {
                setP5m(state.survey.id, dir, p5mCorner);
                reload();
              }}
              accessibilityRole="radio"
              accessibilityState={{ checked: p.is_p5m === 1 }}
              accessibilityLabel={`p5m ${k}`}
              hitSlop={8}
            >
              <Ionicons name={p.is_p5m ? 'radio-button-on' : 'radio-button-off'} size={18} color={p.is_p5m ? '#00A2A5' : '#9ca3af'} />
            </Pressable>
          ) : null}
        </View>
        <NumField
          ref={(r) => { refs.current[`${k}.d`] = r; }}
          value={p.distance_m}
          onCommit={(v) => setVal(p, 'distance_m', v)}
          changed={changed(p, 'distance_m')}
          onSubmitEditing={next(`${k}.d`)}
          accessibilityLabel={t('gloria.points.distanceOf', { point: k })}
          width={62}
          range={RANGES.distance}
        />
        <View className="w-1.5" />
        <NumField
          ref={(r) => { refs.current[`${k}.c`] = r; }}
          value={p.compass_deg}
          onCommit={(v) => setVal(p, 'compass_deg', v)}
          changed={changed(p, 'compass_deg')}
          onSubmitEditing={next(`${k}.c`)}
          accessibilityLabel={t('gloria.points.compassOf', { point: k })}
          width={50}
          range={RANGES.bearing}
        />
        <View className="flex-1 flex-row justify-end">
          {isCorner ? (
            <>
              {photoBtn(p, 'photo_m2', 'm²', t('gloria.points.photoM2', { point: k }))}
              {photoBtn(p, 'photo_m2f', '+F', t('gloria.points.photoM2F', { point: k }))}
            </>
          ) : (
            photoBtn(p, 'photo_point', k.endsWith('10m') ? '10m' : '', t('gloria.points.photoPoint', { point: k }))
          )}
        </View>
      </View>
    );
  };

  const head = () => (
    <View className="flex-row px-2 pb-1 pt-2">
      <Text className="w-9 text-[10px] text-gray-400">{t('gloria.points.point')}</Text>
      <Text className="w-8 text-center text-[10px] text-gray-400">p5m</Text>
      <Text className="w-[62px] text-right text-[10px] text-gray-400">{t('gloria.points.distance')}</Text>
      <Text className="ml-1.5 w-[50px] text-right text-[10px] text-gray-400">{t('gloria.points.compass')}</Text>
      <Text className="flex-1 text-right text-[10px] text-gray-400">{t('gloria.points.photo')}</Text>
    </View>
  );

  const gridKey = (d: Direction) => `grid_ok_${d.toLowerCase()}` as 'grid_ok_n' | 'grid_ok_e' | 'grid_ok_s' | 'grid_ok_w';

  return (
    <View className="gap-3">
      {prev.size > 0 ? (
        <Banner tone="info">
          <BannerText tone="info">{t('gloria.points.carried')}</BannerText>
        </Banner>
      ) : null}
      {DIRECTIONS.map((d) => {
        const ok = state.survey[gridKey(d)] === 1;
        return (
          <Card key={d}>
            <View className="flex-row items-center px-3 pt-2.5">
              <Text className="flex-1 text-base font-bold text-gray-900 dark:text-gray-100">{d}</Text>
              <Pressable onPress={() => onHelp(d)} className="mr-2 rounded-full border border-[#00A2A5] bg-cyan-50 px-2.5 py-1 dark:bg-cyan-950/40">
                <Text className="text-[11px] font-semibold text-[#00797b] dark:text-cyan-300">{t('gloria.points.whereP5m')}</Text>
              </Pressable>
              <Pressable
                onPress={() => {
                  updateGloriaSurvey(state.survey.id, { [gridKey(d)]: ok ? 0 : 1 });
                  reload();
                }}
                accessibilityRole="checkbox"
                accessibilityState={{ checked: ok }}
                className="flex-row items-center"
              >
                <Ionicons name={ok ? 'checkbox' : 'square-outline'} size={18} color={ok ? '#059669' : '#9ca3af'} />
                <Text className="ml-1 text-xs text-gray-600 dark:text-gray-300">3×3 m</Text>
              </Pressable>
            </View>
            {head()}
            {CORNERS.map((c) => row(d + c, c, c === '11' || c === '31' ? c : undefined, d))}
            {row(`${d}10m`, '10m')}
          </Card>
        );
      })}
      <Card>
        <Text className="px-3 pt-2.5 text-xs font-semibold uppercase tracking-wide text-gray-500">{t('gloria.points.intersection')}</Text>
        {head()}
        {DIAGONALS.flatMap((g) => [`${g}5`, `${g}10`]).map((k) => row(k, k.replace(/(\d+)$/, '-$1')))}
      </Card>
    </View>
  );
}
