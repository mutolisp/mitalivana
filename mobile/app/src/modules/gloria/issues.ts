/**
 * Human text for validation issues (model/validate.ts). Kept apart from the
 * pure model so the model stays free of i18n.
 */
import type { TFunction } from 'i18next';
import type { Issue, RequiredField } from './model/validate';

/** Literal t() calls, one per field, so check:i18n sees every key. */
export function requiredLabel(t: TFunction, f: RequiredField): string {
  switch (f) {
    case 'researchers':
      return t('gloria.required.researchers');
    case 'aspect':
      return t('gloria.required.aspect');
    case 'slope':
      return t('gloria.required.slope');
    case 'time':
      return t('gloria.required.time');
    case 'freqTime':
      return t('gloria.required.freqTime');
    case 'topCover':
      return t('gloria.required.topCover');
    case 'subtypes':
      return t('gloria.required.subtypes');
    case 'method':
      return t('gloria.required.method');
  }
}

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
    case 'required':
      return [
        i.fields.length ? t('gloria.issue.required', { fields: i.fields.map((f) => requiredLabel(t, f)).join('、') }) : null,
        i.species.length ? t('gloria.issue.requiredSpecies', { names: i.species.join('、') }) : null,
      ]
        .filter(Boolean)
        .join('\n');
  }
}
