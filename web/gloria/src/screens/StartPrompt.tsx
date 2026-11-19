/**
 * First run: no checklist yet. Suggests one for where the device's time zone
 * says the user is (geo/region.ts): the built-in Taiwan or Japan checklist,
 * or a GBIF country pack elsewhere — and the other built-in ones stay one tap
 * away. The guess can be changed; nothing is downloaded without a tap.
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, Text, View } from 'react-native';
import { Button } from '~/components/ui/Button';
import { showActionSheet } from '~/components/ActionSheet';
import { countryName } from '~/lib/countries';
import { router } from '../router/router';
import { builtinFor, countryFromTimeZone } from '../geo/region';
import { fetchSpeciesManifest, type WebDatasetId } from '../host/speciesInstall';
import { formatBytes } from '../host/exportSize';
import { useDatasetDownload } from '../shell/useDatasetDownload';

const OTHER = 'other';

export function StartPrompt() {
  const { t, i18n } = useTranslation();
  // A country code, OTHER (somewhere without a built-in list, unnamed), or null (unknown).
  const [country, setCountry] = useState<string | null>(() => countryFromTimeZone());
  const [picked, setPicked] = useState(false);
  const builtin = country && country !== OTHER ? builtinFor(country) : null;
  const name = country && country !== OTHER ? countryName(country, i18n.language) : null;

  const change = async () => {
    const idx = await showActionSheet({
      title: t('web.start.changeTitle'),
      cancelLabel: t('common.cancel'),
      options: [
        { label: countryName('TW', i18n.language), selected: country === 'TW' },
        { label: countryName('JP', i18n.language), selected: country === 'JP' },
        { label: t('web.start.otherCountry'), selected: !!country && !builtin },
      ],
    });
    if (idx >= 0) setPicked(true);
    if (idx === 0) setCountry('TW');
    if (idx === 1) setCountry('JP');
    if (idx === 2) setCountry(OTHER);
  };

  const others: WebDatasetId[] = (['tw-taicol', 'jp-ylist'] as const).filter((d) => d !== builtin);

  return (
    <View className="gap-3 rounded-card border border-acorn-edge bg-acorn-wash p-4 dark:border-line-dark dark:bg-card-dark">
      <Text className="text-base font-semibold text-ink dark:text-gray-100">{t('web.start.title')}</Text>
      <View className="flex-row flex-wrap items-center gap-x-2">
        <Text className="text-xs text-ink-2 dark:text-gray-300">
          {name ? t(picked ? 'web.start.picked' : 'web.start.detected', { country: name }) : country === OTHER ? t('web.start.chosenOther') : t('web.start.unknown')}
        </Text>
        <Pressable onPress={() => void change()} accessibilityRole="button">
          <Text className="text-xs text-accent underline dark:text-emerald-400">{t('web.start.change')}</Text>
        </Pressable>
      </View>

      {builtin ? (
        <DatasetOffer id={builtin} primary />
      ) : (
        <View className="gap-2">
          <Text className="text-sm text-ink dark:text-gray-100">
            {name ? t('web.start.gbifFor', { country: name }) : t('web.start.gbifAny')}
          </Text>
          <Button
            variant="primary"
            icon="globe-outline"
            label={name ? t('web.start.gbifButton', { country: name }) : t('web.start.gbifButtonAny')}
            onPress={() => router.push(name && country ? `/packs?country=${country}` : '/packs')}
          />
        </View>
      )}

      <View className="gap-2 border-t border-acorn-edge pt-3 dark:border-line-dark">
        <Text className="text-xs text-ink-3 dark:text-gray-400">{builtin ? t('web.start.alsoBuiltin') : t('web.start.orBuiltin')}</Text>
        {others.map((d) => (
          <DatasetOffer key={d} id={d} />
        ))}
        {builtin ? (
          <Pressable onPress={() => router.push('/packs')} accessibilityRole="button" className="self-start">
            <Text className="text-xs text-accent underline dark:text-emerald-400">{t('web.start.gbifLink')}</Text>
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}

/** One built-in checklist: what it is, its size, and the download button. */
function DatasetOffer({ id, primary }: { id: WebDatasetId; primary?: boolean }) {
  const { t } = useTranslation();
  const { go, busy, status } = useDatasetDownload(id);
  const [size, setSize] = useState<number | null>(null);
  useEffect(() => {
    let alive = true;
    fetchSpeciesManifest(id).then(
      (m) => alive && setSize(m.bytes),
      () => undefined,
    );
    return () => {
      alive = false;
    };
  }, [id]);
  return (
    <View className="gap-1">
      <View className="flex-row items-center gap-3">
        <View className="flex-1">
          <Text className={primary ? 'text-sm text-ink dark:text-gray-100' : 'text-xs text-ink-2 dark:text-gray-300'}>
            {t(`web.start.ds.${id}`)}
            {size ? ` · ${formatBytes(size)}` : ''}
          </Text>
        </View>
        <Button
          variant={primary ? 'primary' : 'secondary'}
          icon="download-outline"
          label={t('web.home.speciesDownload')}
          onPress={() => void go()}
          disabled={busy}
        />
      </View>
      {status ? <Text className="text-xs text-ink-2 dark:text-gray-300">{status}</Text> : null}
    </View>
  );
}
