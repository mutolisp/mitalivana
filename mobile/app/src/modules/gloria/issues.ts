/**
 * Human text for validation issues (model/validate.ts). Kept apart from the
 * pure model so the model stays free of i18n.
 */
import type { TFunction } from 'i18next';
import type { Issue } from './model/validate';

export function issueText(t: TFunction, i: Issue): string {
  switch (i.kind) {
    case 'top-cover-sum':
      return t('gloria.issue.topCoverSum', { sum: i.sum });
    case 'vascular-exceeds-species':
      return t('gloria.issue.vascularExceeds', { vascular: i.vascular, sum: i.speciesSum });
    case 'subtype-range':
      return t('gloria.issue.subtypeRange', { value: i.value });
    case 'cover-no-freq':
      return t('gloria.issue.coverNoFreq', { name: i.species, cover: i.cover });
    case 'freq-no-cover':
      return t('gloria.issue.freqNoCover', { name: i.species, count: i.cells });
    case 'sas-missing':
      return t('gloria.issue.sasMissing', { names: i.species.join('、') });
    case 'point-inconsistent':
      return t('gloria.issue.pointInconsistent', { count: i.points.length });
    case 'p5m':
      return t('gloria.issue.p5m', { direction: i.direction });
  }
}
