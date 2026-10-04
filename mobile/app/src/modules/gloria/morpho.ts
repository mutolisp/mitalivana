/**
 * Picking which morphospecies a search result is, when its taxon is already
 * on the survey roster: one of the existing entries (薹屬 sp1, sp2) or a new
 * one. Shared by every GLORIA screen that adds species from the search.
 */
import type { TFunction } from 'i18next';
import { nameOption, showActionSheet } from '~/components/ActionSheet';
import { isSpeciesLevelRank } from '~/lib/dataQuality';
import { rosterEntriesOf, setRosterLabel } from './db';
import { planNewMorpho } from './model/morpho';
import { sentenceParts, slot, type NamePart } from '~/lib/nameParts';

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
  /** The species as titled: its common name, else its scientific name (nameParts.speciesParts). */
  name: readonly NamePart[],
): Promise<string | null | undefined> {
  if (isSpeciesLevelRank(rank)) return null;
  const entries = rosterEntriesOf(surveyId, taxonId);
  if (entries.length === 0) return null;
  const plan = planNewMorpho(entries.map((e) => e.label));
  const sci = name;
  const idx = await showActionSheet({
    titleParts: sentenceParts(t('gloria.morpho.pickTitle', { name: slot('name') }), { name: sci }),
    message: plan.relabel ? t('gloria.morpho.relabelNote', { label: plan.relabel }) : t('gloria.morpho.pickMsg'),
    cancelLabel: t('common.cancel'),
    options: [
      ...entries.map((e) =>
        nameOption(e.label ? [...sci, ` ${e.label}`] : sentenceParts(t('gloria.morpho.unlabelled', { name: slot('name') }), { name: sci })),
      ),
      nameOption(sentenceParts(t('gloria.morpho.addNew', { name: slot('name'), label: plan.label }), { name: sci })),
    ],
  });
  if (idx < 0 || idx > entries.length) return undefined;
  if (idx < entries.length) return entries[idx].label;
  const bare = entries.find((e) => !e.label?.trim());
  if (bare && plan.relabel) setRosterLabel(bare.id, plan.relabel);
  return plan.label;
}
