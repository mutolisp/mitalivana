/**
 * Picking which morphospecies a search result is, when its taxon is already
 * on the survey roster: one of the existing entries (薹屬 sp1, sp2) or a new
 * one. Shared by every GLORIA screen that adds species from the search.
 */
import type { TFunction } from 'i18next';
import { showActionSheet } from '~/components/ActionSheet';
import { isSpeciesLevelRank } from '~/lib/dataQuality';
import { rosterEntriesOf, setRosterLabel } from './db';
import { planNewMorpho } from './model/morpho';

/**
 * The label to add `taxonId` under: null = unlabelled (the usual case — the
 * taxon is new to the survey, or determined to species), a string = that
 * morphospecies, undefined = cancelled. Choosing "new" while an unlabelled
 * entry exists labels that one first (planNewMorpho).
 */
export async function pickMorphoLabel(
  t: TFunction,
  surveyId: number,
  taxonId: string,
  rank: string | null | undefined,
  name: string,
): Promise<string | null | undefined> {
  if (isSpeciesLevelRank(rank)) return null;
  const entries = rosterEntriesOf(surveyId, taxonId);
  if (entries.length === 0) return null;
  const plan = planNewMorpho(entries.map((e) => e.label));
  const idx = await showActionSheet({
    title: t('gloria.morpho.pickTitle', { name }),
    message: plan.relabel ? t('gloria.morpho.relabelNote', { label: plan.relabel }) : t('gloria.morpho.pickMsg'),
    cancelLabel: t('common.cancel'),
    options: [
      ...entries.map((e) => ({ label: e.label ? `${name} ${e.label}` : t('gloria.morpho.unlabelled', { name }) })),
      { label: t('gloria.morpho.addNew', { name, label: plan.label }) },
    ],
  });
  if (idx < 0 || idx > entries.length) return undefined;
  if (idx < entries.length) return entries[idx].label;
  const bare = entries.find((e) => !e.label?.trim());
  if (bare && plan.relabel) setRosterLabel(bare.id, plan.relabel);
  return plan.label;
}
