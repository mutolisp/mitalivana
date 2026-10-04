/**
 * The builder's words (Phase 2D-a): where a component sits, what its
 * parameters say, the choices each parameter offers, and the issues a draft
 * still has. Literal t() keys in switches, so check:i18n sees every one.
 */
import type { TFunction } from 'i18next';
import { topEdgeName } from '~/components/quadrat/names';
import { methodOf, SAMPLING_METHODS } from '~/survey/codesets/samplingMethods';
import { envLabel } from '~/survey/components/editors/AttributeEditors';
import { methodName } from '~/survey/components/editors/MethodEditor';
import { labelText } from '~/survey/components/editors/shared';
import { levelLabel } from '~/survey/form/text';
import { componentDef, type EnvironmentField, type TraitDef } from '~/survey/registry';
import type { DraftIssue, Place } from '~/survey/template/edit';
import type { ComponentInstance, Label, SurveyStyle, SurveyTemplate } from '~/survey/template/types';

export function styleName(t: TFunction, style: SurveyStyle): string {
  switch (style) {
    case 'checklist':
      return t('surveyForm.style.checklist');
    case 'plot':
      return t('surveyForm.style.plot');
    case 'individual':
      return t('surveyForm.style.individual');
  }
}

/** "每次調查", "每個小區", "每筆出現記錄". */
export function placeTitle(t: TFunction, lang: string, template: SurveyTemplate, place: Place): string {
  switch (place.level) {
    case 'survey':
      return t('builder.place.survey');
    case 'unit':
      return t('builder.place.unit', { name: levelLabel(t, lang, template, place.unit) });
    case 'occurrence':
      return t('builder.place.occurrence');
    case 'quadrat':
      return t('builder.place.quadrat');
    case 'individual':
      return t('builder.place.tree');
    case 'stem':
      return t('builder.place.stem');
  }
}

/** A Health code set's name: the two ForestGEO ones, or the template's own list. */
export function codesetName(t: TFunction, lang: string, template: SurveyTemplate | undefined, set: string): string {
  switch (set) {
    case 'forestgeo-census-1998':
      return t('builder.health.census');
    case 'forestgeo-ams-2021':
      return t('builder.health.ams');
    default:
      return labelText(t, lang, template?.codelists.find((l) => l.id === set)?.label, set);
  }
}

export function locationMethodLabel(t: TFunction, m: string): string {
  switch (m) {
    case 'grid':
      return t('survey.loc.grid');
    case 'xy':
      return t('survey.loc.xy');
    case 'polar':
      return t('survey.loc.polar');
    case 'gps':
      return t('survey.loc.gps');
    default:
      return m;
  }
}

/** A component type's name (the registry's i18n key). */
export function typeName(t: TFunction, type: string): string {
  const def = componentDef(type);
  return def ? t(def.labelKey) : type;
}

export function abundanceKindLabel(t: TFunction, kind: string): string {
  switch (kind) {
    case 'BB':
      return t('builder.kind.bb');
    case 'percent':
      return t('builder.kind.percent');
    case 'count':
      return t('survey.editor.abundance.count');
    case 'DBH':
      return t('builder.kind.dbh');
    case 'custom':
      return t('plotValue.custom');
    default:
      return kind;
  }
}

export function phenologyLabel(t: TFunction, field: string): string {
  switch (field) {
    case 'sex':
      return t('attr.sexLabel');
    case 'life_stage':
      return t('attr.lifeStageLabel');
    case 'reproductive_condition':
      return t('attr.reproLabel');
    case 'leaf_phenology':
      return t('attr.leafLabel');
    case 'degree_of_establishment':
      return t('attr.establishmentLabel');
    default:
      return field;
  }
}

export function roleLabel(t: TFunction, role: string): string {
  switch (role) {
    case 'recorder':
      return t('survey.editor.workers.recorder');
    case 'identifier':
      return t('survey.editor.workers.identifier');
    default:
      return role;
  }
}

export function frequencyModeLabel(t: TFunction, mode: string): string {
  return mode === 'count' ? t('builder.param.modeCount') : t('builder.param.modeCells');
}

export { envLabel, topEdgeName };

const list = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : []);

/** One line under a component in the builder: what its parameters say (`template`: for a choice's list name). */
export function paramsSummary(t: TFunction, lang: string, c: ComponentInstance, template?: SurveyTemplate): string {
  const p = c.params;
  switch (c.type) {
    case 'choice': {
      const l = template?.codelists.find((x) => x.id === p.list);
      return [l ? labelText(t, lang, l.label, t('builder.untitled')) : null, p.multi ? t('builder.choice.multi') : t('builder.choice.single')].filter(Boolean).join(' · ');
    }
    case 'abundance':
      return list(p.kinds)
        .map((k) => abundanceKindLabel(t, k))
        .join(t('builder.listSep'));
    case 'frequency':
      return p.mode === 'count' ? frequencyModeLabel(t, 'count') : `${frequencyModeLabel(t, 'cells')} ${Number(p.n)}×${Number(p.n)}`;
    case 'structure':
      return t('builder.summary.layers', { count: Number(p.layers) || 0 });
    case 'phenology':
      return t('builder.summary.fields', { count: list(p.fields).length });
    case 'environment':
      return list(p.fields)
        .map((f) => envLabel(t, f as EnvironmentField))
        .join(t('builder.listSep'));
    case 'traits':
      return (Array.isArray(p.traits) ? (p.traits as TraitDef[]) : []).map((x) => labelText(t, lang, x.label as Label, x.id) || '—').join(t('builder.listSep'));
    case 'workers':
      return list(p.roles)
        .map((r) => roleLabel(t, r))
        .join(t('builder.listSep'));
    case 'photos':
    case 'audio':
      return t('builder.summary.max', { count: Number(p.max) || 0 });
    case 'location':
      return c.level === 'individual'
        ? list(p.methods)
            .map((m) => locationMethodLabel(t, m))
            .join(t('builder.listSep'))
        : t('builder.summary.gps');
    case 'health':
      return list(p.codesets)
        .map((x) => codesetName(t, lang, template, x))
        .join(t('builder.listSep'));
    case 'interaction': {
      const own = template?.codelists.find((x) => x.id === p.list)?.items.filter((it) => !it.deprecated).length ?? 0;
      return [
        t('builder.summary.interactionTypes', { count: list(p.builtin).length + own }),
        p.count === true ? t('builder.interaction.count') : null,
        Number(p.photos) > 0 ? t('builder.summary.photos', { count: Number(p.photos) }) : null,
      ]
        .filter(Boolean)
        .join(' · ');
    }
    case 'method': {
      // The one it fixes, else how many it offers; and whether one's own may be typed.
      const fixed = methodOf(p.fixed);
      return [
        fixed ? methodName(fixed, lang) : t('builder.summary.methods', { count: list(p.methods).length || SAMPLING_METHODS.length }),
        p.custom === true ? t('builder.method.custom') : null,
      ]
        .filter(Boolean)
        .join(' · ');
    }
    default:
      return '';
  }
}

/** A draft's issue as a sentence. */
export function issueText(t: TFunction, lang: string, template: SurveyTemplate, issue: DraftIssue): string {
  const listName = (id: string) => labelText(t, lang, template.codelists.find((l) => l.id === id)?.label, t('builder.untitled'));
  const compName = (key: string) => {
    const c = template.components.find((x) => x.key === key);
    return c ? labelText(t, lang, c.label, typeName(t, c.type)) : key;
  };
  switch (issue.code) {
    case 'name_empty':
      return t('builder.issue.nameEmpty');
    case 'no_unit_level':
      return t('builder.issue.noUnitLevel');
    case 'unit_label_empty':
      return t('builder.issue.unitLabelEmpty');
    case 'trait_name_empty':
      return t('builder.issue.traitNameEmpty', { component: compName(issue.component), n: issue.trait + 1 });
    case 'trait_range':
      return t('builder.issue.traitRange', { component: compName(issue.component), n: issue.trait + 1 });
    case 'params':
      return t('builder.issue.params', { component: compName(issue.component), detail: issue.detail });
    case 'choice_list':
      return t('builder.issue.choiceList', { component: compName(issue.component) });
    case 'list_name_empty':
      return t('builder.issue.listNameEmpty');
    case 'list_no_codes':
      return t('builder.issue.listNoCodes', { list: listName(issue.list) });
    case 'code_empty':
      return t('builder.issue.codeEmpty', { list: listName(issue.list), n: issue.index + 1 });
    case 'code_duplicate':
      return t('builder.issue.codeDuplicate', { list: listName(issue.list), n: issue.index + 1 });
    case 'code_name_empty':
      return t('builder.issue.codeNameEmpty', { list: listName(issue.list), n: issue.index + 1 });
    case 'interaction_none':
      return t('builder.issue.interactionNone', { component: compName(issue.component) });
    case 'interaction_code':
      return t('builder.issue.interactionCode', { component: compName(issue.component), code: issue.typeCode });
  }
}
