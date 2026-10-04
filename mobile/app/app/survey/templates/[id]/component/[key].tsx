/**
 * One component of a template in the builder (Phase 2D-a; canvas 12d): its
 * own name (plus English), whether it is required, its parameters, its place
 * in the order, and removing it. A full screen, not a sheet: it has text
 * fields.
 *
 * Every change goes to the draft at once. Editing a saved template, a change
 * that open surveys cannot take (paramsChange: only adding choices or
 * widening a range can) is said under the parameters.
 *
 * In a tree census template (2D-b) the census fixes most of it: only the
 * optional tree components are removed, Health takes the AMS code set and the
 * template's code lists, Location its methods; required flags and order stay.
 *
 * Interaction (2F; canvas 12e): the built-in types it offers, its own types
 * (a code list of the template, each with a direction, how it reads from B
 * and an optional relation IRI — edited on the list's screen), whether it
 * asks how many times, and how many photos.
 */
import { router, Stack, useLocalSearchParams } from 'expo-router';
import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';
import { Alert, Pressable, ScrollView, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { LabeledField, LabeledNumField } from '~/components/form/LabeledField';
import { Seg } from '~/components/form/Segmented';
import { Button } from '~/components/ui/Button';
import { Checkbox } from '~/components/ui/Checkbox';
import { Radio } from '~/components/ui/Radio';
import { Switch } from '~/components/ui/Switch';
import { BackHeaderLeft } from '~/lib/goBack';
import { listHref, useTemplateDraft } from '~/survey/builder/drafts';
import { fieldHref } from '~/survey/builder/fieldReturn';
import { fieldDefOf } from '~/survey/template/obsField';
import { showActionSheet } from '~/components/ActionSheet';
import { abundanceKindLabel, codesetName, envLabel, fieldSummary, frequencyModeLabel, locationMethodLabel, phenologyLabel, placeTitle, roleLabel, topEdgeName, typeName } from '~/survey/builder/words';
import { labelText } from '~/survey/components/editors/shared';
import { FormCard } from '~/survey/components/FormBits';
import {
  ABUNDANCE_KINDS,
  componentDef,
  ENVIRONMENT_FIELDS,
  LAYER_METHODS,
  LOCATION_METHODS,
  MAX_LAYERS,
  paramsChangeOf,
  PHENOLOGY_FIELDS,
  TOP_EDGES,
  type Params,
  type TraitDef,
} from '~/survey/registry';
import {
  addCodeList,
  addInteractionType,
  addTrait,
  CENSUS_CODESET,
  componentsAt,
  hasEditableParams,
  isFixedComponent,
  labelParts,
  makeLabel,
  moveComponent,
  placeOf,
  removeComponent,
  removeTrait,
  setHealthCodeset,
  setInteractionBuiltin,
  updateComponent,
  updateTrait,
} from '~/survey/template/edit';
import { AMS_CODESET } from '~/survey/codesets/forestgeoAms2021';
import { BUILTIN_INTERACTIONS } from '~/survey/codesets/interactions';
import { METHOD_KEYS, methodOf, SAMPLING_METHODS } from '~/survey/codesets/samplingMethods';
import { METHOD_GROUP_KEY, methodName } from '~/survey/components/editors/MethodEditor';
import type { ComponentInstance, Label } from '~/survey/template/types';

const list = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : []);

/** Tick boxes for a list parameter; the last one cannot be unticked (a list is never empty). */
function TickList({ options, value, label, onChange }: { options: readonly string[]; value: string[]; label: (o: string) => string; onChange: (next: string[]) => void }) {
  return (
    <View>
      {options.map((o) => {
        const on = value.includes(o);
        return (
          <Checkbox
            key={o}
            checked={on}
            label={label(o)}
            disabled={on && value.length === 1}
            // In the order the options are offered, whatever order they were ticked in.
            onChange={(next) => onChange(options.filter((x) => (x === o ? next : value.includes(x))))}
          />
        );
      })}
    </View>
  );
}

/** − n ＋ within a range. */
function Stepper({ value, min, max, label, onChange }: { value: number; min: number; max: number; label: string; onChange: (n: number) => void }) {
  const step = (d: number) => onChange(Math.min(max, Math.max(min, value + d)));
  return (
    <View className="flex-row items-center justify-between" style={{ minHeight: 44 }}>
      <Text className="flex-1 text-base text-ink dark:text-gray-100">{label}</Text>
      <View className="flex-row items-center gap-2">
        <Button label="−" variant="secondary" disabled={value <= min} onPress={() => step(-1)} accessibilityLabel={`${label} −1`} />
        <Text className="w-10 text-center text-base font-semibold text-ink dark:text-gray-100" style={{ fontVariant: ['tabular-nums'] }}>
          {value}
        </Text>
        <Button label="＋" variant="secondary" disabled={value >= max} onPress={() => step(1)} accessibilityLabel={`${label} +1`} />
      </View>
    </View>
  );
}

function ParamsEditor({ t, c, set }: { t: TFunction; c: ComponentInstance; set: (params: Params) => void }) {
  const { i18n } = useTranslation();
  const p = c.params;
  switch (c.type) {
    case 'abundance': {
      const kinds = list(p.kinds);
      return (
        <View className="gap-2">
          <Text className="text-xs font-bold text-ink-2 dark:text-gray-400">{t('builder.param.kinds')}</Text>
          <TickList
            options={ABUNDANCE_KINDS}
            value={kinds}
            label={(k) => abundanceKindLabel(t, k)}
            onChange={(next) => set({ ...p, kinds: next, default: next.includes(String(p.default)) ? p.default : next[0] })}
          />
          <Text className="pt-1 text-xs font-bold text-ink-2 dark:text-gray-400">{t('builder.param.defaultKind')}</Text>
          {kinds.map((k) => (
            <Pressable key={k} onPress={() => set({ ...p, default: k })} accessibilityRole="radio" accessibilityState={{ selected: p.default === k }} className="flex-row items-center gap-2.5" style={{ minHeight: 44 }}>
              <Radio selected={p.default === k} />
              <Text className="text-base text-ink dark:text-gray-100">{abundanceKindLabel(t, k)}</Text>
            </Pressable>
          ))}
        </View>
      );
    }
    case 'frequency':
      return (
        <View className="gap-2">
          <Seg value={p.mode === 'count' ? 'count' : 'cells'} options={(['cells', 'count'] as const).map((m) => ({ value: m, label: frequencyModeLabel(t, m) }))} onChange={(m) => set({ ...p, mode: m })} />
          <Stepper label={t('builder.param.gridN')} value={Number(p.n) || 10} min={2} max={10} onChange={(n) => set({ ...p, n })} />
          {p.mode !== 'count' ? (
            <>
              <Text className="text-xs font-bold text-ink-2 dark:text-gray-400">{t('builder.param.topEdge')}</Text>
              <Seg value={String(p.top_edge ?? 'N')} options={TOP_EDGES.map((e) => ({ value: e as string, label: topEdgeName(t, e) }))} onChange={(e) => set({ ...p, top_edge: e })} />
            </>
          ) : null}
        </View>
      );
    case 'structure':
      return (
        <View className="gap-2">
          <Stepper label={t('builder.param.layers')} value={Number(p.layers) || 4} min={1} max={MAX_LAYERS} onChange={(n) => set({ ...p, layers: n })} />
          <Text className="text-xs font-bold text-ink-2 dark:text-gray-400">{t('builder.param.layerMethods')}</Text>
          <TickList options={LAYER_METHODS} value={list(p.methods)} label={(m) => abundanceKindLabel(t, m)} onChange={(next) => set({ ...p, methods: next })} />
        </View>
      );
    case 'phenology':
      return <TickList options={PHENOLOGY_FIELDS} value={list(p.fields)} label={(f) => phenologyLabel(t, f)} onChange={(next) => set({ ...p, fields: next })} />;
    case 'environment':
      return <TickList options={ENVIRONMENT_FIELDS} value={list(p.fields)} label={(f) => envLabel(t, f as (typeof ENVIRONMENT_FIELDS)[number])} onChange={(next) => set({ ...p, fields: next })} />;
    case 'workers':
      return <TickList options={['recorder', 'identifier']} value={list(p.roles)} label={(r) => roleLabel(t, r)} onChange={(next) => set({ ...p, roles: next })} />;
    case 'photos':
    case 'audio':
      return <Stepper label={t('builder.param.max')} value={Number(p.max) || 1} min={1} max={20} onChange={(n) => set({ ...p, max: n })} />;
    case 'location':
      return c.level === 'individual' ? (
        <TickList options={LOCATION_METHODS} value={list(p.methods)} label={(m) => locationMethodLabel(t, m)} onChange={(next) => set({ ...p, methods: next })} />
      ) : (
        <Text className="text-sm leading-5 text-ink-2 dark:text-gray-300">{t('builder.param.gpsOnly')}</Text>
      );
    case 'method': {
      // 調查法 (2G-f): the surveyor picks from the methods offered (none ticked: all), or the template fixes one.
      const fixed = methodOf(p.fixed);
      const offered = list(p.methods);
      const pickFixed = async () => {
        const i = await showActionSheet({
          title: t('builder.method.method'),
          options: SAMPLING_METHODS.map((m) => ({ key: m.key, label: methodName(m, i18n.language), section: t(METHOD_GROUP_KEY[m.group]), keywords: `${m.zh} ${m.en}`, selected: fixed?.key === m.key })),
        });
        if (i >= 0) set({ ...p, fixed: SAMPLING_METHODS[i].key });
      };
      return (
        <View className="gap-2">
          <Seg
            value={fixed ? 'fixed' : 'choose'}
            options={[
              { value: 'choose', label: t('builder.method.choose') },
              { value: 'fixed', label: t('builder.method.fixed') },
            ]}
            onChange={(m) => set({ ...p, fixed: m === 'fixed' ? (offered[0] ?? SAMPLING_METHODS[0].key) : null })}
          />
          {fixed ? (
            <Pressable onPress={() => void pickFixed()} accessibilityRole="button" className="flex-row items-center gap-2" style={{ minHeight: 44 }}>
              <View className="flex-1">
                <Text className="text-xs font-bold text-ink-2 dark:text-gray-400">{t('builder.method.method')}</Text>
                <Text className="text-base text-ink dark:text-gray-100">{methodName(fixed, i18n.language)}</Text>
              </View>
              <Text className="text-sm font-semibold text-accent-700 dark:text-accent-300">{t('builder.choice.change')}</Text>
            </Pressable>
          ) : (
            <>
              <Checkbox checked={offered.length === 0} label={t('builder.method.all')} onChange={(v) => set({ ...p, methods: v ? [] : METHOD_KEYS.slice() })} />
              {offered.length ? (
                <TickList options={METHOD_KEYS} value={offered} label={(k) => { const m = methodOf(k); return m ? methodName(m, i18n.language) : k; }} onChange={(next) => set({ ...p, methods: next })} />
              ) : null}
            </>
          )}
          <View className="flex-row items-center gap-3" style={{ minHeight: 44 }}>
            <View className="flex-1">
              <Text className="text-base text-ink dark:text-gray-100">{t('builder.method.custom')}</Text>
              <Text className="text-xs leading-4 text-ink-3 dark:text-gray-400">{t('builder.method.customDesc')}</Text>
            </View>
            <Switch value={p.custom === true} onValueChange={(v) => set({ ...p, custom: v })} accessibilityLabel={t('builder.method.custom')} />
          </View>
        </View>
      );
    }
    case 'traits':
    case 'choice':
    case 'health':
    case 'interaction':
      return null; // their own sections below
    default:
      return <Text className="text-sm text-ink-3 dark:text-gray-400">{t('builder.param.none')}</Text>;
  }
}

export default function TemplateComponentScreen() {
  const { t, i18n } = useTranslation();
  const params = useLocalSearchParams<{ id: string; key: string }>();
  const id = String(params.id);
  const key = String(params.key);
  const { draft, saved, update } = useTemplateDraft(id);
  const lang = i18n.language;
  const tpl = draft?.template;
  const comp = tpl?.components.find((x) => x.key === key);
  const def = comp ? componentDef(comp.type) : undefined;

  if (!tpl || !comp || !def) {
    return (
      <SafeAreaView edges={['bottom']} className="flex-1 items-center justify-center bg-paper px-6 dark:bg-paper-dark">
        <Stack.Screen options={{ title: '', headerLeft: BackHeaderLeft }} />
        <Text className="text-center text-ink-3 dark:text-gray-400">{t('builder.notFound')}</Text>
      </SafeAreaView>
    );
  }
  const fixed = isFixedComponent(tpl, comp);
  const census = tpl.style === 'individual';
  const own = labelParts(comp.label);
  const place = placeOf(comp) ?? { level: 'survey' as const };
  const siblings = componentsAt(tpl, place);
  const at = siblings.findIndex((x) => x.key === key);
  const before = saved?.components.find((x) => x.key === key);
  // Against the saved version: can open surveys still take this component as it is now?
  const change = before ? paramsChangeOf(def, before.params, comp.params) : 'same';
  const traits = Array.isArray(comp.params.traits) ? (comp.params.traits as TraitDef[]) : [];
  const field = comp.type === 'field' ? fieldDefOf(comp.params) : null;

  const set = (patch: Parameters<typeof updateComponent>[2]) => update((x) => updateComponent(x, key, patch));
  const opennessList = comp.type === 'environment' ? tpl.codelists.find((l) => l.id === comp.params.openness_list) : undefined;
  /** 開闊度's grades: one of the template's lists, or a new one. */
  const pickList = async (param: 'openness_list') => {
    const idx = await showActionSheet({
      title: t('builder.choice.list'),
      options: [...tpl.codelists.map((l) => ({ label: labelText(t, lang, l.label, t('builder.untitled')) })), { label: t('builder.list.add') }],
      cancelLabel: t('common.cancel'),
    });
    if (idx < 0 || idx > tpl.codelists.length) return;
    if (idx < tpl.codelists.length) {
      set({ params: { ...comp.params, [param]: tpl.codelists[idx].id } });
      return;
    }
    let made: string | null = null;
    update((x) => {
      const r = addCodeList(x, makeLabel(t('builder.list.newName', { n: x.codelists.length + 1 }))!);
      made = r.id;
      return updateComponent(r.template, key, { params: { ...comp.params, [param]: r.id } });
    });
    if (made) router.push(listHref(id, made));
  };
  const sets = Array.isArray(comp.params.codesets) ? (comp.params.codesets as string[]) : [];
  const builtinTypes = Array.isArray(comp.params.builtin) ? (comp.params.builtin as string[]) : [];
  const ownTypes = comp.type === 'interaction' ? tpl.codelists.find((l) => l.id === comp.params.list) : undefined;
  /** A type of the template's own: added to its list (made on the first one), then edited there. */
  const newInteractionType = () => {
    let made: string | null = null;
    update((x) => {
      const r = addInteractionType(x, key, makeLabel(t('builder.interaction.listName'))!);
      if (!r) return x;
      made = r.listId;
      return r.template;
    });
    if (made) router.push(listHref(id, made));
  };
  /** A new code list, used by this Health component at once. */
  const newHealthList = () => {
    let made: string | null = null;
    update((x) => {
      const r = addCodeList(x, makeLabel(t('builder.list.newName', { n: x.codelists.length + 1 }))!);
      made = r.id;
      return setHealthCodeset(r.template, key, r.id, true);
    });
    if (made) router.push(listHref(id, made));
  };
  const remove = () =>
    Alert.alert(t('builder.removeComponent'), t('builder.removeComponentMsg', { name: field ? field.name : labelText(t, lang, comp.label, typeName(t, comp.type)) }), [
      { text: t('common.cancel'), style: 'cancel' },
      {
        text: t('builder.removeComponent'),
        style: 'destructive',
        onPress: () => {
          update((x) => removeComponent(x, key));
          router.back();
        },
      },
    ]);

  return (
    <SafeAreaView edges={['bottom']} className="flex-1 bg-paper dark:bg-paper-dark">
      <Stack.Screen options={{ title: typeName(t, comp.type), headerLeft: BackHeaderLeft }} />
      <ScrollView contentContainerClassName="gap-3 p-4 pb-10" keyboardShouldPersistTaps="handled">
        <Text className="text-xs text-ink-3 dark:text-gray-400">{placeTitle(t, lang, tpl, place)}</Text>
        {field ? (
          // A 自訂欄位 is defined in the library, the same in every template that uses it.
          <FormCard title={field.name_en ? `${field.name}（${field.name_en}）` : field.name}>
            <Text className="text-sm leading-5 text-ink-2 dark:text-gray-300">{fieldSummary(t, lang, field)}</Text>
            {field.description ? <Text className="text-sm leading-5 text-ink dark:text-gray-100">{field.description}</Text> : null}
            <Text className="font-mono text-xs text-ink-3 dark:text-gray-400">{field.key}</Text>
            <Text className="text-xs leading-4 text-ink-3 dark:text-gray-400">{t('fieldLib.definedInLibrary')}</Text>
            <Button label={t('fieldLib.editInLibrary')} icon="create-outline" variant="secondary" onPress={() => router.push(fieldHref(field.key))} />
          </FormCard>
        ) : (
        <FormCard>
          <LabeledField
            label={t('builder.name')}
            value={own.text}
            placeholder={typeName(t, comp.type)}
            onSave={(v) => set({ label: makeLabel(v, own.en) })}
          />
          <LabeledField label={t('builder.nameEn')} value={own.en} onSave={(v) => set({ label: makeLabel(own.text, v) })} />
          <Text className="text-xs leading-4 text-ink-3 dark:text-gray-400">{t('builder.componentNameDesc', { name: typeName(t, comp.type) })}</Text>
        </FormCard>
        )}

        {/* An interaction is recorded when one is seen: there is nothing to miss. */}
        {comp.type === 'interaction' ? null : (
        <FormCard>
          <View className="flex-row items-center gap-3">
            <View className="flex-1">
              <Text className="text-sm font-semibold text-ink dark:text-gray-100">{t('builder.required')}</Text>
              <Text className="mt-0.5 text-xs leading-4 text-ink-3 dark:text-gray-400">
                {census ? t('builder.census.requiredFixed') : fixed ? t('builder.requiredFixed') : t('builder.requiredDesc')}
              </Text>
            </View>
            {/* 必填 is the author's only for a component they may leave out (2G-e). */}
            {fixed || census ? null : <Switch value={comp.required} onValueChange={(v) => set({ required: v })} accessibilityLabel={t('builder.required')} />}
          </View>
        </FormCard>
        )}

        {comp.type === 'health' ? (
          <FormCard title={t('builder.health.title')}>
            <Text className="text-xs leading-4 text-ink-3 dark:text-gray-400">{t('builder.health.desc')}</Text>
            {[CENSUS_CODESET, AMS_CODESET, ...tpl.codelists.map((l) => l.id)].map((set) => {
              const on = sets.includes(set);
              const locked = census && set === CENSUS_CODESET;
              return (
                <Checkbox
                  key={set}
                  checked={on}
                  disabled={locked}
                  label={codesetName(t, lang, tpl, set)}
                  onChange={(next) => update((x) => setHealthCodeset(x, key, set, next))}
                />
              );
            })}
            {sets.includes(AMS_CODESET) ? <Text className="text-xs leading-4 text-ink-3 dark:text-gray-400">{t('builder.health.amsDesc')}</Text> : null}
            <Button label={t('builder.list.add')} icon="add" variant="secondary" onPress={newHealthList} />
          </FormCard>
        ) : comp.type === 'interaction' ? (
          <>
            <FormCard title={t('builder.interaction.builtin')}>
              <Text className="text-xs leading-4 text-ink-3 dark:text-gray-400">{t('builder.interaction.builtinDesc')}</Text>
              {BUILTIN_INTERACTIONS.map((b) => (
                <View key={b.code}>
                  <Checkbox
                    checked={builtinTypes.includes(b.code)}
                    label={`${t(`survey.interaction.type.${b.code}.name`)}（${t(b.mutual ? 'builder.interaction.mutual' : 'builder.interaction.oneWay')}）`}
                    onChange={(next) => update((x) => setInteractionBuiltin(x, key, b.code, next))}
                  />
                  <Text className="-mt-1 pb-1 pl-9 font-mono text-xs text-ink-3 dark:text-gray-400">{`${b.en} · ${b.iri.slice(b.iri.lastIndexOf('/') + 1)}`}</Text>
                </View>
              ))}
            </FormCard>
            <FormCard title={t('builder.interaction.own')}>
              {(ownTypes?.items ?? []).map((it, i) => (
                <Text key={`${i}`} className={`text-base ${it.deprecated ? 'text-ink-3 line-through dark:text-gray-500' : 'text-ink dark:text-gray-100'}`}>
                  {`${labelText(t, lang, it.label, it.code) || '—'}（${t(it.mutual ? 'builder.interaction.mutual' : 'builder.interaction.oneWay')}）`}
                </Text>
              ))}
              {ownTypes ? <Button label={t('builder.interaction.editOwn')} icon="create-outline" variant="secondary" onPress={() => router.push(listHref(id, ownTypes.id))} /> : null}
              <Button label={t('builder.interaction.addOwn')} icon="add" variant="secondary" onPress={newInteractionType} />
            </FormCard>
            <FormCard title={t('builder.params')}>
              <View className="flex-row items-center gap-3" style={{ minHeight: 44 }}>
                <View className="flex-1">
                  <Text className="text-base text-ink dark:text-gray-100">{t('builder.interaction.count')}</Text>
                  <Text className="text-xs leading-4 text-ink-3 dark:text-gray-400">{t('builder.interaction.countDesc')}</Text>
                </View>
                <Switch value={comp.params.count === true} onValueChange={(v) => set({ params: { ...comp.params, count: v } })} accessibilityLabel={t('builder.interaction.count')} />
              </View>
              <Stepper label={t('builder.interaction.photos')} value={Number(comp.params.photos) || 0} min={0} max={20} onChange={(n) => set({ params: { ...comp.params, photos: n } })} />
            </FormCard>
          </>
        ) : comp.type === 'field' ? null : comp.type !== 'traits' ? (
          <>
            <FormCard title={t('builder.params')}>
              {hasEditableParams(tpl, comp) ? (
                <ParamsEditor t={t} c={comp} set={(next) => set({ params: next })} />
              ) : (
                <Text className="text-sm leading-5 text-ink-2 dark:text-gray-300">{t('builder.census.paramsFixed')}</Text>
              )}
            </FormCard>
            {comp.type === 'environment' && list(comp.params.fields).includes('openness') ? (
              // 開闊度 (2G-f): sky openness in %, or grades from one of the template's lists.
              <FormCard title={t('surveyForm.env.openness')}>
                <Seg
                  value={typeof comp.params.openness_list === 'string' ? 'grades' : 'pct'}
                  options={[
                    { value: 'pct', label: t('builder.openness.pct') },
                    { value: 'grades', label: t('builder.openness.grades') },
                  ]}
                  onChange={(m) => (m === 'pct' ? set({ params: Object.fromEntries(Object.entries(comp.params).filter(([k]) => k !== 'openness_list')) }) : void pickList('openness_list'))}
                />
                {opennessList ? (
                  <>
                    <Pressable onPress={() => void pickList('openness_list')} accessibilityRole="button" className="flex-row items-center gap-2" style={{ minHeight: 44 }}>
                      <View className="flex-1">
                        <Text className="text-xs font-bold text-ink-2 dark:text-gray-400">{t('builder.openness.list')}</Text>
                        <Text className="text-base text-ink dark:text-gray-100">{labelText(t, lang, opennessList.label, t('builder.untitled'))}</Text>
                      </View>
                      <Text className="text-sm font-semibold text-accent-700 dark:text-accent-300">{t('builder.choice.change')}</Text>
                    </Pressable>
                    <Button label={t('builder.choice.editList')} icon="create-outline" variant="secondary" onPress={() => router.push(listHref(id, opennessList.id))} />
                  </>
                ) : null}
              </FormCard>
            ) : null}
          </>
        ) : (
          <FormCard title={t('builder.traits')}>
            {traits.map((tr, i) => {
              const parts = labelParts(tr.label as Label);
              const name = (patch: Partial<{ text: string; en: string }>) => update((x) => updateTrait(x, key, i, { name: { ...parts, ...patch } }, saved));
              return (
                <View key={`${i}`} className="gap-1 border-t border-line pt-2 dark:border-line-dark">
                  <Text className="text-xs font-bold text-ink-2 dark:text-gray-400">{t('builder.traitN', { n: i + 1 })}</Text>
                  <LabeledField label={t('builder.name')} value={parts.text} required onSave={(v) => name({ text: v })} />
                  <LabeledField label={t('builder.nameEn')} value={parts.en} onSave={(v) => name({ en: v })} />
                  <LabeledField label={t('builder.trait.unit')} value={tr.unit ?? ''} placeholder="cm" onSave={(v) => update((x) => updateTrait(x, key, i, { unit: v.trim() }, saved))} />
                  <View className="flex-row gap-3">
                    <View className="flex-1">
                      <LabeledNumField label={t('builder.trait.min')} value={tr.min ?? null} onSave={(n) => update((x) => updateTrait(x, key, i, { min: n ?? undefined }, saved))} />
                    </View>
                    <View className="flex-1">
                      <LabeledNumField label={t('builder.trait.max')} value={tr.max ?? null} onSave={(n) => update((x) => updateTrait(x, key, i, { max: n ?? undefined }, saved))} />
                    </View>
                  </View>
                  <Checkbox checked={!!tr.integer} label={t('builder.trait.integer')} onChange={(v) => update((x) => updateTrait(x, key, i, { integer: v }, saved))} />
                  {traits.length > 1 ? <Button label={t('builder.trait.remove')} icon="trash-outline" variant="ghost" onPress={() => update((x) => removeTrait(x, key, i))} /> : null}
                </View>
              );
            })}
            <Button label={t('builder.trait.add')} icon="add" variant="secondary" onPress={() => update((x) => addTrait(x, key))} />
          </FormCard>
        )}
        {change === 'breaking' ? <Text className="text-xs leading-4 text-alert dark:text-alert-dark">{t('builder.changeBreaking', { n: saved?.version ?? 1 })}</Text> : null}
        {change === 'additive' ? <Text className="text-xs leading-4 text-ink-2 dark:text-gray-400">{t('builder.changeAdditive')}</Text> : null}

        <View className="flex-row flex-wrap gap-2">
          {/* A census screen lays its fields out itself: the order would change nothing. */}
          {!census ? (
            <>
              <Button label={t('builder.moveUp')} icon="arrow-up" variant="secondary" disabled={at <= 0} onPress={() => update((x) => moveComponent(x, key, -1))} />
              <Button label={t('builder.moveDown')} icon="arrow-down" variant="secondary" disabled={at < 0 || at >= siblings.length - 1} onPress={() => update((x) => moveComponent(x, key, 1))} />
            </>
          ) : null}
          {!fixed ? <Button label={t('builder.removeComponent')} icon="trash-outline" variant="danger" onPress={remove} /> : null}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}
