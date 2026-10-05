/**
 * Adding a species where its other names matter (code review V4).
 *
 * The search lets a recorder file a record under a synonym they typed
 * (adoptName.ts). Two places could lose that choice without a word:
 *
 *  - The species is already here (same taxon_id, same unit / layer) under
 *    another of its names: the add paths painted that record and dropped the
 *    name just picked. Now the recorder says whether it is the same record
 *    (merge) or a second one on purpose.
 *  - A table that keeps only the accepted name (fixed-plot quadrats, GLORIA,
 *    MIREN): the chosen name was dropped. Now the recorder confirms that the
 *    record goes under the accepted name, or backs out.
 */
import { nameOption, showActionSheet } from '~/components/ActionSheet';
import type { AdoptionInput } from '~/db/taxonLookup';
import i18n from '~/i18n';
import { sentenceParts, slot, type NamePart } from '~/lib/nameParts';

/** A taxon as the questions name it: its accepted scientific name, italic by rank. */
export type TaxonNaming = { accepted: string; rank: string | null; kingdom: string | null };

const sciOf = (t: TaxonNaming) => (name: string): NamePart[] => [{ sci: name, rank: t.rank, kingdom: t.kingdom }];

/**
 * The species is already here, filed under `hereUsed` (null: its accepted
 * name); the recorder just picked `adopted` (null: the accepted name). 'same'
 * when the two agree (no question); 'merge' to use the record here;
 * 'separate' for a second record under the name just picked; null: cancelled.
 */
export async function synonymAlreadyHere(
  taxon: TaxonNaming,
  hereUsed: string | null | undefined,
  adopted: AdoptionInput | null | undefined,
): Promise<'same' | 'merge' | 'separate' | null> {
  const picked = adopted?.scientific_name || null;
  const here = hereUsed || null;
  if (picked === here) return 'same';
  const sci = sciOf(taxon);
  const names = { here: sci(here ?? taxon.accepted), picked: sci(picked ?? taxon.accepted) };
  const i = await showActionSheet({
    title: i18n.t('synonymAdd.title'),
    messageParts: sentenceParts(i18n.t('synonymAdd.message', { here: slot('here'), picked: slot('picked') }), names),
    options: [
      nameOption(sentenceParts(i18n.t('synonymAdd.merge', { here: slot('here') }), names)),
      nameOption(sentenceParts(i18n.t('synonymAdd.separate', { picked: slot('picked') }), names)),
    ],
    cancelLabel: i18n.t('common.cancel'),
  });
  return i === 0 ? 'merge' : i === 1 ? 'separate' : null;
}

/**
 * Where only the accepted name is kept: true to go on under it (also when no
 * other name was chosen), false when the recorder backs out.
 */
export async function acceptedNameOnly(taxon: TaxonNaming, adopted: AdoptionInput | null | undefined): Promise<boolean> {
  if (!adopted?.scientific_name || adopted.scientific_name === taxon.accepted) return true;
  const sci = sciOf(taxon);
  const names = { typed: sci(adopted.scientific_name), accepted: sci(taxon.accepted) };
  const i = await showActionSheet({
    title: i18n.t('synonymAdd.acceptedOnlyTitle'),
    messageParts: sentenceParts(i18n.t('synonymAdd.acceptedOnly', { typed: slot('typed'), accepted: slot('accepted') }), names),
    options: [nameOption(sentenceParts(i18n.t('adoptName.useAccepted', { name: slot('accepted') }), names))],
    cancelLabel: i18n.t('common.cancel'),
  });
  return i === 0;
}
