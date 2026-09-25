/**
 * Summit base data (sheet 00_) and summit overview photos, at the top of the
 * base-data tab. Name, WGS84 coordinates, elevation and vegetation zone are
 * edited here; coordinates are WGS84 decimal degrees only.
 * Overview photos are exported as Annex III item SU-OV with the viewpoint as
 * element 8, which is why each photo carries its own viewpoint note.
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, Text, TextInput, View } from 'react-native';
import { PhotoGrid, PhotoViewerModal } from '~/components/PhotoGrid';
import { SelectRow } from '~/components/settings/rows';
import { errText } from '~/lib/errText';
import { captureEnvPhoto, pickPhotos } from '~/lib/photoCapture';
import { updateGloriaSurvey, updateSummit, type SummitPatch } from '../db';
import { parseOverviewPhotos, serializeOverviewPhotos, type OverviewPhoto } from '../model/overview';
import { RANGES } from '../model/ranges';
import type { SurveyState } from '../useSurvey';
import { Card, Label, NumField } from './ui';

/** Vegetation zones as the project records them (sheet 00_ "Vegetation Zone"). */
export const VEG_ZONES = [
  { value: 'treeline ecotone', label: 'treeline ecotone' },
  { value: 'lower alpine', label: 'lower alpine' },
  { value: 'alpine', label: 'alpine (lower/upper alpine ecotone)' },
  { value: 'upper alpine', label: 'upper alpine' },
  { value: 'subnival', label: 'subnival (alpine to nival ecotone)' },
  { value: 'nival', label: 'nival' },
] as const;

const INPUT =
  'rounded-md border border-gray-300 bg-white px-2 py-1.5 text-sm text-gray-900 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100';

export function SummitForm({ state, reload }: { state: SurveyState; reload: () => void }) {
  const { t } = useTranslation();
  const s = state.summit;
  const patch = (p: SummitPatch) => {
    updateSummit(s.id, p);
    reload();
  };
  const field = (label: string, input: React.ReactNode) => (
    <View className="flex-row items-center py-1">
      <Text className="flex-1 text-sm text-gray-700 dark:text-gray-300">{label}</Text>
      {input}
    </View>
  );
  // A stored zone the list does not know (typed in the sheet) stays selectable.
  const zones: Array<{ value: string; label: string }> = [
    { value: '', label: t('gloria.summit.zoneNone') },
    ...VEG_ZONES,
    ...(s.veg_zone && !VEG_ZONES.some((z) => z.value === s.veg_zone) ? [{ value: s.veg_zone, label: s.veg_zone }] : []),
  ];

  return (
    <>
      <Label>{t('gloria.summit.title')}</Label>
      <Card className="gap-0.5 p-3">
        {field(t('gloria.summit.code'), <Text className="text-sm font-semibold text-gray-900 dark:text-gray-100">{s.full_code}</Text>)}
        {field(
          t('gloria.summit.name'),
          <TextInput
            key={`name-${s.updated_at}`}
            defaultValue={s.name ?? ''}
            onEndEditing={(e) => {
              const v = e.nativeEvent.text.trim() || null;
              if (v !== s.name) patch({ name: v });
            }}
            placeholder={t('gloria.summit.namePlaceholder')}
            placeholderTextColor="#9ca3af"
            accessibilityLabel={t('gloria.summit.name')}
            className={`${INPUT} w-44`}
          />,
        )}
        {field(
          t('gloria.summit.lat'),
          <NumField value={s.decimal_latitude} onCommit={(v) => patch({ decimal_latitude: v })} range={RANGES.latitude} signed width={140} accessibilityLabel={t('gloria.summit.lat')} />,
        )}
        {field(
          t('gloria.summit.lon'),
          <NumField value={s.decimal_longitude} onCommit={(v) => patch({ decimal_longitude: v })} range={RANGES.longitude} signed width={140} accessibilityLabel={t('gloria.summit.lon')} />,
        )}
        {field(
          t('gloria.summit.elevation'),
          <NumField value={s.elevation_m} onCommit={(v) => patch({ elevation_m: v })} range={RANGES.elevation} width={100} accessibilityLabel={t('gloria.summit.elevation')} />,
        )}
        <View className="pt-1.5">
          <SelectRow
            variant="inline"
            label={t('gloria.summit.zone')}
            value={s.veg_zone ?? ''}
            options={zones}
            onChange={(v) => patch({ veg_zone: v || null })}
          />
        </View>
      </Card>
      <OverviewPhotos state={state} reload={reload} />
    </>
  );
}

function OverviewPhotos({ state, reload }: { state: SurveyState; reload: () => void }) {
  const { t } = useTranslation();
  const photos = parseOverviewPhotos(state.survey.overview_photos);
  const [viewer, setViewer] = useState<number | null>(null);
  const save = (list: OverviewPhoto[]) => {
    updateGloriaSurvey(state.survey.id, { overview_photos: serializeOverviewPhotos(list) });
    reload();
  };
  const add = (uris: string[]) => {
    if (uris.length) save([...photos, ...uris.map((uri) => ({ uri, viewpoint: '' }))]);
  };
  const run = async (f: () => Promise<string[]>) => {
    try {
      add(await f());
    } catch (e) {
      Alert.alert(t('gloria.summit.photoFail'), errText(e));
    }
  };
  const uris = photos.map((p) => p.uri);

  return (
    <>
      <Label>{t('gloria.summit.photos', { n: photos.length })}</Label>
      <Card className="p-3">
        <Text className="text-[11px] text-gray-500 dark:text-gray-400">{t('gloria.summit.photosHint')}</Text>
        <PhotoGrid
          photos={uris}
          onAdd={() => void run(async () => {
            const u = await captureEnvPhoto();
            return u ? [u] : [];
          })}
          onPickLibrary={() => void run(pickPhotos)}
          onView={setViewer}
          onRemove={(uri) => save(photos.filter((p) => p.uri !== uri))}
        />
        {photos.map((p, i) => (
          <View key={p.uri} className="mt-2 flex-row items-center">
            <Text className="w-8 text-xs text-gray-500 dark:text-gray-400">{`#${i + 1}`}</Text>
            <TextInput
              defaultValue={p.viewpoint}
              onEndEditing={(e) => {
                const v = e.nativeEvent.text.trim();
                if (v !== p.viewpoint) save(photos.map((x) => (x.uri === p.uri ? { ...x, viewpoint: v } : x)));
              }}
              placeholder={t('gloria.summit.viewpoint')}
              placeholderTextColor="#9ca3af"
              accessibilityLabel={t('gloria.summit.viewpointLabel', { n: i + 1 })}
              className={`${INPUT} flex-1`}
            />
          </View>
        ))}
        <PhotoViewerModal photos={uris} index={viewer} onClose={() => setViewer(null)} />
      </Card>
    </>
  );
}
