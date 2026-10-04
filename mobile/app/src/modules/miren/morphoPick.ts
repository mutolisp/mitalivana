/**
 * Which region-specific name a search result above species level is
 * (Road protocol §2.5.2.1): no name (just the genus / family), one the
 * region already uses (`Acacia MTN1`), or the next new one. Region-wide, so
 * the same plant keeps its name across plots, routes and years.
 */
import { nameOption, showActionSheet } from '~/components/ActionSheet';
import { isSpeciesLevelRank } from '~/lib/dataQuality';
import i18n from '~/i18n';
import { regionMorphoNames } from './db';
import { morphoName } from './model/morpho';
import { morphoParts, sentenceParts, slot } from '~/lib/nameParts';

/** null = no name, a string = that name, undefined = cancelled. */
export async function pickRegionName(
  regionId: number,
  regionCode: string,
  rank: string | null | undefined,
  base: string,
): Promise<string | null | undefined> {
  if (isSpeciesLevelRank(rank)) return null;
  const all = regionMorphoNames(regionId);
  const mine = all.filter((n) => n.startsWith(`${base} `));
  const next = morphoName(base, regionCode, all);
  // The genus (or family) by its rank; the region code after it as text.
  const named = (full: string) => morphoParts(full, base, rank);
  const options = [
    nameOption(sentenceParts(i18n.t('miren.morpho.none', { name: slot('name') }), { name: named(base) })),
    ...mine.map((n) => nameOption(named(n))),
    nameOption(sentenceParts(i18n.t('miren.morpho.new', { name: slot('name') }), { name: named(next) })),
  ];
  const idx = await showActionSheet({
    titleParts: sentenceParts(i18n.t('miren.morpho.title', { name: slot('name') }), { name: named(base) }),
    message: i18n.t('miren.morpho.msg'),
    options,
    cancelLabel: i18n.t('common.cancel'),
  });
  if (idx < 0 || idx >= options.length) return undefined;
  if (idx === 0) return null;
  if (idx <= mine.length) return mine[idx - 1];
  return next;
}
