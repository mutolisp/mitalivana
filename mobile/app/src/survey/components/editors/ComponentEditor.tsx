/**
 * The input of any registered component (src/survey/registry.ts), and its
 * one-line summary for lists. The switch is exhaustive over the registered
 * types (registry COMPONENT_TYPES): a new component without an input is a
 * type error.
 *
 * Four have their input elsewhere, on purpose:
 *   - taxon: the record screens' species search (2C) and the tree form;
 *   - dbh and health: the tree form (TreeEditor), which checks a stem's DBH
 *     against its state (status.ts) and shows the AMS entries;
 *   - interaction: rows of its own, listed on the occurrence screen and
 *     recorded on a screen of their own (2F).
 */
import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';
import { Text, View } from 'react-native';
import { parseDbhArray } from '~/lib/dwcAbundanceCore';
import { CUSTOM_METHOD, methodKey, methodOf } from '~/survey/codesets/samplingMethods';
import { componentDef, type ComponentType, type ComponentValues, type TraitDef } from '~/survey/registry';
import { fieldDefOf, fieldLabel } from '~/survey/template/obsField';
import type { CodeList, ComponentInstance, Label } from '~/survey/template/types';
import { AbundanceEditor } from './AbundanceEditor';
import { ChoiceEditor, choiceList, codeLabel } from './ChoiceEditor';
import { EnvironmentEditor, PhenologyEditor, TraitsEditor } from './AttributeEditors';
import {
  AudioEditor,
  CommentsEditor,
  HeightEditor,
  InvestigatorsEditor,
  LocationEditor,
  PhotosEditor,
  TimestampEditor,
  WorkersEditor,
} from './BasicEditors';
import { allowedText, FieldEditor } from './FieldEditor';
import { FrequencyEditor } from './FrequencyEditor';
import { MethodEditor, methodName } from './MethodEditor';
import { labelText, type EditorProps } from './shared';
import { StructureEditor } from './StructureEditor';

const assertNever = (x: never): never => {
  throw new Error(`no input for component type ${String(x)}`);
};

/** The component's name: the template's label, else a 自訂欄位's own name, else the built-in name. */
export function componentLabel(t: TFunction, lang: string, instance: ComponentInstance): string {
  const def = componentDef(instance.type);
  const field = instance.type === 'field' ? fieldDefOf(instance.params) : null;
  return labelText(t, lang, (instance.label as Label | undefined) ?? (field ? fieldLabel(field) : undefined), def ? t(def.labelKey) : instance.type);
}

export function ComponentEditor(props: EditorProps) {
  const type = props.instance.type as ComponentType;
  switch (type) {
    case 'abundance':
      return <AbundanceEditor {...props} />;
    case 'frequency':
      return <FrequencyEditor {...props} />;
    case 'structure':
      return <StructureEditor {...props} />;
    case 'phenology':
      return <PhenologyEditor {...props} />;
    case 'traits':
      return <TraitsEditor {...props} />;
    case 'environment':
      return <EnvironmentEditor {...props} />;
    case 'photos':
      return <PhotosEditor {...props} />;
    case 'audio':
      return <AudioEditor {...props} />;
    case 'comments':
      return <CommentsEditor {...props} />;
    case 'timestamp':
      return <TimestampEditor {...props} />;
    case 'investigators':
      return <InvestigatorsEditor {...props} />;
    case 'workers':
      return <WorkersEditor {...props} />;
    case 'height':
      return <HeightEditor {...props} />;
    case 'location':
      // On a census tree the position is the tree form's (grid, x,y, polar, GNSS).
      return props.instance.level === 'individual' ? <ElsewhereNote /> : <LocationEditor {...props} />;
    case 'choice':
      return <ChoiceEditor {...props} />;
    case 'method':
      return <MethodEditor {...props} />;
    case 'field':
      return <FieldEditor {...props} />;
    case 'taxon':
    case 'dbh':
    case 'health':
    // 空間資料: the centre card, the site row and the track control (SurveyGroupViews).
    case 'centre':
    case 'site':
    case 'track':
      return <ElsewhereNote />;
    case 'interaction':
      return <ElsewhereNote textKey="survey.editor.interactionElsewhere" />;
    default:
      return assertNever(type);
  }
}

function ElsewhereNote({ textKey = 'survey.editor.elsewhere' }: { textKey?: string }) {
  const { t } = useTranslation();
  return (
    <View>
      <Text className="text-xs text-ink-3 dark:text-gray-400">{t(textKey)}</Text>
    </View>
  );
}

const num = (v: unknown): number | null => (typeof v === 'number' ? v : null);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const list = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : []);

/** What a component holds, in a few words ('' when nothing is recorded). */
/** `codelists`: the template's, so a choice reads as its codes' names. */
export function componentSummary(t: TFunction, lang: string, instance: ComponentInstance, v: ComponentValues, codelists?: readonly CodeList[]): string {
  const type = instance.type as ComponentType;
  switch (type) {
    case 'abundance': {
      const q = str(v.organism_quantity);
      const typ = str(v.organism_quantity_type);
      if (!q) return '';
      if (typ === 'Braun-Blanquet Scale') return `BB ${q}`;
      if (typ === '% cover') return `${q} %`;
      if (typ === 'individuals') return t('survey.editor.summary.count', { n: q });
      if (typ === 'DBH (cm)') return t('survey.editor.summary.stems', { count: parseDbhArray(q).length });
      return `${q} ${typ}`;
    }
    case 'frequency': {
      const n = Number(instance.params.n) || 10;
      const k = typeof v.freq_cells === 'string' ? [...v.freq_cells].filter((c) => c === '1').length : num(v.freq_count);
      return k == null ? '' : `${k}/${n * n}`;
    }
    case 'structure': {
      if (instance.level === 'occurrence') return str(v.layer);
      const count = num(v.layer_count);
      return count == null ? '' : t('survey.editor.summary.layers', { count });
    }
    case 'phenology':
      return [str(v.sex), str(v.life_stage), ...list(v.reproductive_condition), ...list(v.leaf_phenology), str(v.degree_of_establishment)].filter(Boolean).length
        ? t('survey.editor.summary.recorded')
        : '';
    case 'traits': {
      const traits = (Array.isArray(instance.params.traits) ? instance.params.traits : []) as TraitDef[];
      return traits
        .filter((tr) => num(v[tr.id]) != null)
        .map((tr) => `${labelText(t, lang, tr.label as Label, tr.id)} ${num(v[tr.id])}${tr.unit ? ` ${tr.unit}` : ''}`)
        .join(t('builder.listSep'));
    }
    case 'environment': {
      const parts: string[] = [];
      if (num(v.elevation_m) != null) parts.push(`${num(v.elevation_m)} m`);
      if (num(v.slope_deg) != null) parts.push(`${num(v.slope_deg)}°`);
      return parts.join(' · ');
    }
    case 'photos':
    case 'audio': {
      const n = list(type === 'photos' ? v.photos : v.audio).length;
      return n ? String(n) : '';
    }
    case 'comments':
      return str(v.notes).slice(0, 40);
    case 'investigators':
      return str(v.investigators);
    case 'workers':
      return [str(v.recorded_by), str(v.identified_by)].filter(Boolean).join(' / ');
    case 'location': {
      const lat = num(v.lat);
      const lng = num(v.lng);
      return lat == null || lng == null ? '' : `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
    }
    case 'height':
      return num(v.height_m) == null ? '' : `${num(v.height_m)} m`;
    case 'choice': {
      const codes = choiceList(codelists, instance.params.list);
      const chosen = Array.isArray(v.value) ? v.value.map(String) : typeof v.value === 'string' && v.value ? [v.value] : [];
      return chosen.map((code) => codeLabel(t, lang, codes?.items.find((it) => it.code === code), code)).join(t('builder.listSep'));
    }
    case 'method': {
      const m = methodOf(methodKey(v, instance.params));
      const name = methodKey(v, instance.params) === CUSTOM_METHOD ? str(v.protocol_name) : m ? methodName(m, lang) : '';
      const w = num(v.width_m);
      const l = num(v.length_m);
      return [name, w != null && l != null ? `${w} × ${l} m` : ''].filter(Boolean).join(' · ');
    }
    case 'centre': {
      const lat = num(v.lat);
      const lng = num(v.lng);
      return lat != null && lng != null ? `${lat.toFixed(5)}, ${lng.toFixed(5)}` : '';
    }
    case 'field': {
      const def = fieldDefOf(instance.params);
      if (!def) return '';
      if (def.datatype === 'taxon') return [str(v.cname), str(v.name)].filter(Boolean).join(' ');
      if (def.datatype === 'numeric') return num(v.value) == null ? '' : `${num(v.value)}${def.unit ? ` ${def.unit}` : ''}`;
      const values = Array.isArray(v.value) ? list(v.value) : str(v.value) ? [str(v.value)] : [];
      return values.map((x) => (def.allowed ? allowedText(def, x, lang) : x)).join(t('builder.listSep')).slice(0, 60);
    }
    case 'timestamp':
    case 'taxon':
    case 'dbh':
    case 'health':
    case 'interaction':
    case 'site':
    case 'track':
      return '';
    default:
      return assertNever(type);
  }
}
