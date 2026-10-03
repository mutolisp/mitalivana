/**
 * Screen text for the census codes, the checks' problem codes and the list
 * chips. Literal t() calls in switches, so check:i18n sees every key.
 */
import type { TFunction } from 'i18next';
import type { TreeChip } from '~/survey/stemmap/review';
import type { TraitDef } from '~/survey/registry';
import type { Label, SurveyTemplate } from '~/survey/template/types';
import { amsLabelKey } from './AmsStemFields';
import { labelText } from './editors/shared';

/**
 * A census value's name (a stem's or a tree's, in one census): height, the
 * census codes, an AMS variable, one of the template's traits or code lists.
 * The census merge review shows these instead of the stored field names.
 */
export function censusValueName(t: TFunction, lang: string, template: SurveyTemplate | null, component: string, field: string): string {
  if (component === 'height' && field === 'height_m') return t('survey.tree.height');
  if (component === 'health') {
    if (field === 'census_codes') return t('survey.tree.codes');
    if (field === 'census_tree_codes') return t('survey.tree.wholeDead');
    if (field.startsWith('ams_')) return `AMS ${t(amsLabelKey(field.slice(4)))}`;
    if (field.startsWith('codes_')) return labelText(t, lang, template?.codelists.find((l) => l.id === field.slice(6))?.label, field.slice(6));
  }
  const traits = template?.components.find((c) => c.key === component && c.type === 'traits');
  if (traits && Array.isArray(traits.params.traits)) {
    const tr = (traits.params.traits as TraitDef[]).find((x) => x.id === field);
    if (tr) return labelText(t, lang, tr.label as Label, field);
  }
  return field;
}

/** Meaning of a census code (Condit 1998 Tables 2.2.1 / 2.5.1, in the UI language). */
export function codeLabel(t: TFunction, code: string): string {
  switch (code) {
    case 'B':
      return t('survey.code.B');
    case 'M':
      return t('survey.code.M');
    case 'P':
      return t('survey.code.P');
    case 'A':
      return t('survey.code.A');
    case 'I':
      return t('survey.code.I');
    case 'X':
      return t('survey.code.X');
    case 'L':
      return t('survey.code.L');
    case 'Y':
      return t('survey.code.Y');
    case 'Q':
      return t('survey.code.Q');
    case 'C':
      return t('survey.code.C');
    case 'R':
      return t('survey.code.R');
    case 'DS':
      return t('survey.code.DS');
    case 'DC':
      return t('survey.code.DC');
    case 'DT':
      return t('survey.code.DT');
    case 'DN':
      return t('survey.code.DN');
    default:
      return code;
  }
}

/** A problem found by the checks (status.ts, review.ts, treeForm.ts). */
export function issueText(t: TFunction, code: string): string {
  switch (code) {
    case 'unknown_code':
      return t('survey.issue.unknownCode');
    case 'recensus_only':
      return t('survey.issue.recensusOnly');
    case 'pom_required':
      return t('survey.issue.pomRequired');
    case 'dbh_required':
      return t('survey.issue.dbhRequired');
    case 'zero_needs_resprout':
      return t('survey.issue.zeroNeedsResprout');
    case 'new_below_threshold':
      return t('survey.issue.newBelowThreshold');
    case 'tagged_below_threshold':
      return t('survey.issue.taggedBelowThreshold');
    case 'dead_has_dbh':
    case 'dead_stem_with_dbh':
      return t('survey.issue.deadHasDbh');
    case 'tree_dead_but_stem_alive':
    case 'ams_dead_individual_but_stem_alive':
      return t('survey.issue.deadButAlive');
    case 'problem':
      return t('survey.issue.problem');
    case 'shrank':
      return t('survey.issue.shrank');
    case 'tenfold':
      return t('survey.issue.tenfold');
    case 'not_handled':
      return t('survey.issue.notHandled');
    case 'extreme_high':
      return t('survey.issue.extremeHigh');
    case 'extreme_low':
      return t('survey.issue.extremeLow');
    case 'extreme_few':
      return t('survey.issue.extremeFew');
    case 'stem_dead_but_ams_alive':
      return t('survey.issue.stemDeadButAmsAlive');
    case 'ams_mode_b_and_s':
      return t('survey.issue.amsModeBAndS');
    case 'ams_uprooted_needs_leaning':
      return t('survey.issue.amsUprootedNeedsLeaning');
    case 'ams_ok_but_damaged':
      return t('survey.issue.amsOkButDamaged');
    case 'ams_ok_but_crown_lost':
      return t('survey.issue.amsOkButCrownLost');
    case 'ams_x_with_living_length':
      return t('survey.issue.amsXWithLivingLength');
    case 'ams_not_a_number':
      return t('survey.issue.amsNotANumber');
    case 'ams_not_allowed':
      return t('survey.issue.amsNotAllowed');
    case 'ams_below_min':
    case 'ams_above_max':
      return t('survey.issue.amsOutOfRange');
    default:
      return code;
  }
}

export function chipText(t: TFunction, chip: TreeChip): string {
  switch (chip) {
    case 'warn':
      return t('survey.chip.warn');
    case 'pending':
      return t('survey.chip.pending');
    case 'fresh':
      return t('survey.chip.fresh');
    case 'dead':
      return t('survey.chip.dead');
    case 'done':
      return t('survey.chip.done');
    case 'partial':
      return t('survey.chip.partial');
    case 'prevDead':
      return t('survey.chip.prevDead');
    case 'prevMissing':
      return t('survey.chip.prevMissing');
    case 'todo':
      return t('survey.chip.todo');
  }
}
