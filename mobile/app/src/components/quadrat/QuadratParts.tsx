/**
 * Pieces of the fixed plot's quadrat screen (app/plot/[id]/quadrat/[qid].tsx),
 * moved out unchanged so a plot-style survey's quadrat (2G-d4) is drawn with
 * the same ones: the title, the 覆蓋度 ｜ 頻度 switch, the quick-pick chips and
 * the photos.
 */
import { Ionicons } from '@expo/vector-icons';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, Text, View } from 'react-native';
import { PhotoGrid, PhotoViewerModal } from '~/components/PhotoGrid';
import { errText } from '~/lib/errText';
import { captureEnvPhoto, pickPhotos } from '~/lib/photoCapture';
import type { QuadratProgress } from '~/lib/quadratProgress';
import { useToast } from '~/stores/toast';
import { useThemeColors } from '~/theme/colors';
import { StatusBadge } from './PlotQuadratsTab';

export type QuadratView = 'cover' | 'freq';

/** Code on its status colour, the name, a lock when done; the plot, size and grid below. */
export function QuadratHeaderTitle({
  code,
  status,
  title,
  locked,
  subtitle,
}: {
  code: string;
  status: QuadratProgress['status'];
  title: string;
  locked: boolean;
  subtitle: string;
}) {
  const c = useThemeColors();
  return (
    <View>
      <View className="flex-row items-center gap-1.5">
        <StatusBadge label={code} status={status} size="sm" />
        <Text className="font-semibold text-ink dark:text-gray-100" style={{ fontSize: 15, maxWidth: 150 }} numberOfLines={1}>
          {title}
        </Text>
        {locked ? <Ionicons name="lock-closed" size={13} color={c.ink2} /> : null}
      </View>
      <Text className="text-ink-2 dark:text-gray-300" style={{ fontSize: 11 }} numberOfLines={1}>
        {subtitle}
      </Text>
    </View>
  );
}

/** 覆蓋度 ｜ 頻度 n/m (design 10d): the badge is alert-toned until every species has cells. */
export function QuadratViewSeg({ value, onChange, freq }: { value: QuadratView; onChange: (v: QuadratView) => void; freq: { done: number; total: number } }) {
  const { t } = useTranslation();
  const complete = freq.total > 0 && freq.done === freq.total;
  const tab = (v: QuadratView, label: string, badge?: React.ReactNode) => {
    const on = value === v;
    return (
      <Pressable
        onPress={() => onChange(v)}
        accessibilityRole="tab"
        accessibilityState={{ selected: on }}
        className={`flex-1 flex-row items-center justify-center gap-1.5 rounded-md py-1.5 ${on ? 'bg-card dark:bg-gray-700' : ''}`}
      >
        <Text className={`text-sm ${on ? 'font-semibold text-ink dark:text-gray-100' : 'text-ink-2 dark:text-gray-400'}`}>{label}</Text>
        {badge}
      </Pressable>
    );
  };
  return (
    <View className="flex-row rounded-lg bg-disc p-0.5 dark:bg-disc-dark" accessibilityRole="tablist">
      {tab('cover', t('plot.quadrats.cover'))}
      {tab(
        'freq',
        t('plot.quadrats.frequency'),
        freq.total > 0 ? (
          <View className={`rounded-full px-1.5 ${complete ? 'bg-accent-100 dark:bg-accent-900' : 'bg-alert-tint dark:bg-alert-dark-tint'}`}>
            <Text className={`text-xs font-bold ${complete ? 'text-accent-700 dark:text-accent-300' : 'text-alert dark:text-alert-dark'}`}>
              {`${freq.done}/${freq.total}`}
            </Text>
          </View>
        ) : null,
      )}
    </View>
  );
}

/** Dashed chips that add a species with one tap; nothing when the list is empty. */
export function PickChips({ items, label, onPick }: { items: readonly { taxon_id: string; name: string }[]; label: string; onPick: (taxonId: string) => void }) {
  const c = useThemeColors();
  if (!items.length) return null;
  return (
    <View className="gap-1.5">
      <Text className="text-xs font-semibold text-gray-500 dark:text-gray-400">{label}</Text>
      <View className="flex-row flex-wrap gap-1.5">
        {items.map((x) => (
          <Pressable
            key={x.taxon_id}
            onPress={() => onPick(x.taxon_id)}
            accessibilityRole="button"
            className="flex-row items-center rounded-full border-[1.5px] border-dashed border-gray-400 px-3 py-1.5 active:bg-gray-100 dark:border-gray-500 dark:active:bg-gray-800"
          >
            <Ionicons name="add" size={14} color={c.accent} />
            <Text className="ml-0.5 text-sm text-ink dark:text-gray-100">{x.name}</Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}

/**
 * The quadrat's photos, taken like the plot's environment photos. `onRefused`:
 * the camera tile tapped while read-only (it says why).
 */
export function QuadratPhotos({
  photos,
  ro,
  onRefused,
  onAdd,
  onRemove,
}: {
  photos: readonly string[];
  ro: boolean;
  onRefused: () => void;
  onAdd: (uris: string[]) => void;
  onRemove: (uri: string) => void;
}) {
  const { t } = useTranslation();
  const toast = useToast((s) => s.show);
  const [viewer, setViewer] = useState<number | null>(null);
  const add = (uris: string[]) => uris.length && onAdd(uris);
  return (
    <View>
      <Text className="text-xs font-bold uppercase text-gray-500 dark:text-gray-400" style={{ letterSpacing: 0.96 }}>
        {t('plot.quadrats.photos')}
        {photos.length ? ` (${photos.length})` : ''}
      </Text>
      <PhotoGrid
        photos={[...photos]}
        onAdd={() => {
          if (ro) return onRefused();
          void captureEnvPhoto()
            .then((uri) => uri && add([uri]))
            .catch((e) => toast(errText(e)));
        }}
        onPickLibrary={
          ro
            ? undefined
            : () =>
                void pickPhotos()
                  .then(add)
                  .catch((e) => toast(errText(e)))
        }
        onView={setViewer}
        onRemove={ro ? undefined : onRemove}
      />
      <PhotoViewerModal photos={[...photos]} index={viewer} onClose={() => setViewer(null)} />
    </View>
  );
}
