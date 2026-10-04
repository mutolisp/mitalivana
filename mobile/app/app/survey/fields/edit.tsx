/**
 * One 自訂欄位 of the library (six-item plan C, 2026-10-04): a new one
 * (no `key`) or the one under `key`. Its name and English name, description,
 * key (suggested from the name), data type, and by type: a text field's
 * allowed values (typed one at a time or as `yes|no`, each with an English
 * name, deprecated rather than removed once used) and whether several may be
 * chosen; a numeric field's integer or decimal, range and unit.
 *
 * A field a template uses keeps its key, type, unit and single / multiple
 * choice; its values may be added or deprecated, its range only widened
 * (template/obsField.ts fieldChange); the screen says so and keeps those
 * inputs read-only. The form is the screen's until 儲存.
 *
 * `return=1`: opened from a template's 加入元件 → 新增欄位; the field made
 * is added to that template (builder/fieldReturn.ts).
 */
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, Pressable, Text, View } from 'react-native';
import { KeyboardAwareScrollView } from 'react-native-keyboard-controller';
import { SafeAreaView } from 'react-native-safe-area-context';
import { showActionSheet } from '~/components/ActionSheet';
import { Seg } from '~/components/form/Segmented';
import { HeaderIconButton } from '~/components/HeaderIconButton';
import { Button } from '~/components/ui/Button';
import { Checkbox } from '~/components/ui/Checkbox';
import { Radio } from '~/components/ui/Radio';
import { Switch } from '~/components/ui/Switch';
import { BackHeaderLeft } from '~/lib/goBack';
import { useToast } from '~/stores/toast';
import { takeFieldReturn } from '~/survey/builder/fieldReturn';
import { datatypeDesc, datatypeName } from '~/survey/builder/words';
import { Field, FormCard, TextBox } from '~/survey/components/FormBits';
import { deleteField, fieldUseCounts, getField, listFields, saveField, setFieldDeprecated } from '~/survey/db/surveys';
import { formErrorText } from '~/survey/form/text';
import {
  checkFieldDef,
  FIELD_DATATYPES,
  FIELD_KEY,
  fieldChange,
  parseAllowedInput,
  suggestKey,
  type AllowedValue,
  type FieldDatatype,
  type ObsFieldDef,
} from '~/survey/template/obsField';

type Form = {
  key: string;
  /** The key was typed (not suggested from the name). */
  keyTyped: boolean;
  name: string;
  name_en: string;
  description: string;
  datatype: FieldDatatype;
  restricted: boolean;
  allowed: AllowedValue[];
  multi: boolean;
  numeric_kind: 'integer' | 'float';
  min: string;
  max: string;
  unit: string;
};

const blank: Form = {
  key: '',
  keyTyped: false,
  name: '',
  name_en: '',
  description: '',
  datatype: 'text',
  restricted: false,
  allowed: [],
  multi: false,
  numeric_kind: 'float',
  min: '',
  max: '',
  unit: '',
};

function formOf(d: ObsFieldDef): Form {
  return {
    ...blank,
    key: d.key,
    keyTyped: true,
    name: d.name,
    name_en: d.name_en ?? '',
    description: d.description ?? '',
    datatype: d.datatype,
    restricted: !!d.allowed,
    allowed: d.allowed ?? [],
    multi: !!d.multi,
    numeric_kind: d.numeric_kind ?? 'float',
    min: d.min != null ? String(d.min) : '',
    max: d.max != null ? String(d.max) : '',
    unit: d.unit ?? '',
  };
}

const numberOf = (s: string): number | undefined | null => {
  if (!s.trim()) return undefined;
  const n = Number(s.trim());
  return Number.isFinite(n) ? n : null;
};

/** The form as a definition; null for a bound that is not a number. */
function defOf(f: Form): ObsFieldDef | null {
  const min = numberOf(f.min);
  const max = numberOf(f.max);
  if (min === null || max === null) return null;
  const opt = (s: string) => (s.trim() ? s.trim() : undefined);
  return {
    key: f.key.trim(),
    name: f.name.trim(),
    ...(opt(f.name_en) ? { name_en: opt(f.name_en) } : {}),
    ...(opt(f.description) ? { description: opt(f.description) } : {}),
    datatype: f.datatype,
    ...(f.datatype === 'text' && f.restricted
      ? { allowed: f.allowed.map((a) => ({ value: a.value, ...(a.en?.trim() ? { en: a.en.trim() } : {}), ...(a.deprecated ? { deprecated: true } : {}) })), ...(f.multi ? { multi: true } : {}) }
      : {}),
    ...(f.datatype === 'numeric'
      ? { numeric_kind: f.numeric_kind, ...(min != null ? { min } : {}), ...(max != null ? { max } : {}), ...(opt(f.unit) ? { unit: opt(f.unit) } : {}) }
      : {}),
  };
}

export default function FieldEditScreen() {
  const { t } = useTranslation();
  const toast = useToast((s) => s.show);
  const params = useLocalSearchParams<{ key?: string; return?: string }>();
  const returning = params.return === '1';
  const existing = useMemo(() => (params.key ? getField(String(params.key)) : null), [params.key]);
  const uses = useMemo(() => (existing ? (fieldUseCounts().get(existing.def.key) ?? 0) : 0), [existing]);
  const used = uses > 0;
  const savedValues = useMemo(() => new Set((existing?.def.allowed ?? []).map((a) => a.value)), [existing]);
  const takenKeys = useMemo(() => new Set(listFields({ deprecated: true }).map((r) => r.def.key).filter((k) => k !== existing?.def.key)), [existing]);
  const [form, setForm] = useState<Form>(() => (existing ? formOf(existing.def) : blank));
  const [deprecated, setDeprecated] = useState(!!existing?.deprecated);
  const [adding, setAdding] = useState('');
  const set = (patch: Partial<Form>) => setForm((f) => ({ ...f, ...patch }));

  // Opened for a template and left without saving: nothing is added to it.
  useEffect(() => () => void (returning ? takeFieldReturn() : null), [returning]);

  /** A new field's key follows its name until one is typed. */
  const setName = (patch: { name?: string; name_en?: string }) =>
    setForm((f) => {
      const next = { ...f, ...patch };
      return existing || f.keyTyped ? next : { ...next, key: suggestKey(next.name_en || next.name, takenKeys) };
    });

  const addAllowed = () => {
    const fresh = parseAllowedInput(adding).filter((v) => !form.allowed.some((a) => a.value === v));
    if (fresh.length) set({ allowed: [...form.allowed, ...fresh.map((value) => ({ value }))] });
    setAdding('');
  };
  const patchAllowed = (i: number, patch: Partial<AllowedValue>) => set({ allowed: form.allowed.map((a, j) => (j === i ? { ...a, ...patch } : a)) });

  /** What stops saving, in the app's words. */
  const issues = (d: ObsFieldDef | null): string[] => {
    if (!d) return [t('fieldLib.issue.range')];
    const out: string[] = [];
    if (!d.name) out.push(t('fieldLib.issue.name'));
    if (!FIELD_KEY.test(d.key)) out.push(t('fieldLib.issue.key'));
    else if (takenKeys.has(d.key)) out.push(t('fieldLib.err.keyTaken', { key: d.key }));
    if (d.datatype === 'text' && form.restricted && (d.allowed?.length ?? 0) < 2) out.push(t('fieldLib.issue.allowed'));
    if (d.min != null && d.max != null && d.min > d.max) out.push(t('fieldLib.issue.range'));
    // Anything else the definition rule finds (stated as it is).
    if (!out.length) out.push(...checkFieldDef(d));
    return out;
  };

  const save = () => {
    const d = defOf(form);
    const problems = issues(d);
    if (problems.length || !d) {
      Alert.alert(t('fieldLib.fixFirst'), problems.map((p) => `• ${p}`).join('\n'));
      return;
    }
    if (existing && used && fieldChange(existing.def, d) === 'breaking') {
      Alert.alert(t('fieldLib.fixFirst'), t('fieldLib.usedRules', { count: uses }));
      return;
    }
    let stored: ObsFieldDef;
    try {
      stored = saveField(d, existing?.def.key);
      if (existing && deprecated !== existing.deprecated) setFieldDeprecated(stored.key, deprecated);
    } catch (e) {
      Alert.alert(t('fieldLib.fixFirst'), formErrorText(t, e));
      return;
    }
    toast(t('fieldLib.saved'));
    const onCreated = returning ? takeFieldReturn() : null;
    router.back();
    onCreated?.(stored);
  };

  const more = async () => {
    if (!existing) return;
    const items = [
      ...(!used
        ? [
            {
              label: t('fieldLib.delete'),
              destructive: true,
              run: () =>
                Alert.alert(t('fieldLib.deleteTitle'), t('fieldLib.deleteMsg', { name: existing.def.name }), [
                  { text: t('common.cancel'), style: 'cancel' },
                  {
                    text: t('fieldLib.delete'),
                    style: 'destructive',
                    onPress: () => {
                      try {
                        deleteField(existing.def.key);
                        toast(t('fieldLib.deleted'));
                        router.back();
                      } catch (e) {
                        toast(formErrorText(t, e));
                      }
                    },
                  },
                ]),
            },
          ]
        : []),
    ];
    if (!items.length) {
      toast(t('fieldLib.usedNoDelete', { count: uses }));
      return;
    }
    const idx = await showActionSheet({ title: existing.def.name, options: items, cancelLabel: t('common.cancel') });
    items[idx]?.run();
  };

  return (
    <SafeAreaView edges={['bottom']} className="flex-1 bg-paper dark:bg-paper-dark">
      <Stack.Screen
        options={{
          title: existing ? existing.def.name : t('fieldLib.newField'),
          headerLeft: BackHeaderLeft,
          headerRight: existing ? () => <HeaderIconButton icon="ellipsis-horizontal" label={t('common.more')} onPress={() => void more()} /> : undefined,
        }}
      />
      <KeyboardAwareScrollView contentContainerClassName="gap-3 p-4 pb-10" keyboardShouldPersistTaps="handled" bottomOffset={24}>
        {used ? <Text className="text-xs leading-4 text-ink-2 dark:text-gray-300">{t('fieldLib.usedRules', { count: uses })}</Text> : null}
        <FormCard>
          <Field label={`${t('fieldLib.name')} *`}>
            <TextBox value={form.name} onChange={(v) => setName({ name: v })} accessibilityLabel={t('fieldLib.name')} />
          </Field>
          <Field label={t('fieldLib.nameEn')}>
            <TextBox value={form.name_en} onChange={(v) => setName({ name_en: v })} accessibilityLabel={t('fieldLib.nameEn')} autoCapitalize="none" />
          </Field>
          <Field label={t('fieldLib.description')}>
            <TextBox value={form.description} onChange={(v) => set({ description: v })} accessibilityLabel={t('fieldLib.description')} multiline />
          </Field>
          <Field label={t('fieldLib.key')}>
            {used ? (
              <Text className="font-mono text-base text-ink dark:text-gray-100">{form.key}</Text>
            ) : (
              <TextBox value={form.key} onChange={(v) => set({ key: v.trim().toLowerCase(), keyTyped: true })} accessibilityLabel={t('fieldLib.key')} autoCapitalize="none" mono />
            )}
            <Text className="mt-1 text-xs leading-4 text-ink-3 dark:text-gray-400">{t('fieldLib.keyDesc')}</Text>
          </Field>
        </FormCard>

        <FormCard title={t('fieldLib.datatype')}>
          {FIELD_DATATYPES.map((dt) => {
            const on = form.datatype === dt;
            const disabled = used && !on;
            return (
              <Pressable
                key={dt}
                disabled={disabled}
                onPress={() => set({ datatype: dt })}
                accessibilityRole="radio"
                accessibilityState={{ selected: on, disabled }}
                className="flex-row items-center gap-2.5"
                style={{ minHeight: 44 }}
              >
                <Radio selected={on} disabled={disabled} />
                <View className="flex-1">
                  <Text className={`text-base ${disabled ? 'text-ink-3 dark:text-gray-500' : 'text-ink dark:text-gray-100'}`}>{datatypeName(t, dt)}</Text>
                  <Text className="text-xs leading-4 text-ink-3 dark:text-gray-400">{datatypeDesc(t, dt)}</Text>
                </View>
              </Pressable>
            );
          })}
        </FormCard>

        {form.datatype === 'text' ? (
          <FormCard title={t('fieldLib.allowed')}>
            <View className="flex-row items-center gap-3" style={{ minHeight: 44 }}>
              <View className="flex-1">
                <Text className="text-base text-ink dark:text-gray-100">{t('fieldLib.restrict')}</Text>
                <Text className="text-xs leading-4 text-ink-3 dark:text-gray-400">{t('fieldLib.restrictDesc')}</Text>
              </View>
              <Switch value={form.restricted} onValueChange={(v) => set({ restricted: v })} accessibilityLabel={t('fieldLib.restrict')} />
            </View>
            {form.restricted ? (
              <>
                {form.allowed.map((a, i) => {
                  const kept = used && savedValues.has(a.value);
                  return (
                    <View key={`${a.value}:${i}`} className="gap-1.5 border-t border-line pt-2 dark:border-line-dark">
                      <View className="flex-row items-center gap-2">
                        <Text className={`flex-1 text-base font-semibold ${a.deprecated ? 'text-ink-3 line-through dark:text-gray-500' : 'text-ink dark:text-gray-100'}`}>{a.value}</Text>
                        {kept ? null : (
                          <Pressable onPress={() => set({ allowed: form.allowed.filter((_, j) => j !== i) })} accessibilityRole="button" accessibilityLabel={t('fieldLib.removeValue', { value: a.value })} hitSlop={8} style={{ minHeight: 44, justifyContent: 'center' }}>
                            <Text className="text-sm text-alert dark:text-alert-dark">{t('fieldLib.remove')}</Text>
                          </Pressable>
                        )}
                      </View>
                      <TextBox value={a.en ?? ''} onChange={(v) => patchAllowed(i, { en: v })} placeholder={t('fieldLib.valueEn')} accessibilityLabel={`${a.value} ${t('fieldLib.valueEn')}`} autoCapitalize="none" />
                      {kept ? <Checkbox checked={!!a.deprecated} label={t('fieldLib.deprecateValue')} onChange={(v) => patchAllowed(i, { deprecated: v })} /> : null}
                    </View>
                  );
                })}
                <View className="flex-row items-center gap-2 border-t border-line pt-2 dark:border-line-dark">
                  <View className="flex-1">
                    <TextBox value={adding} onChange={setAdding} placeholder={t('fieldLib.addValues')} accessibilityLabel={t('fieldLib.addValues')} />
                  </View>
                  <Button label={t('fieldLib.add')} icon="add" variant="secondary" disabled={!adding.trim()} onPress={addAllowed} />
                </View>
                <View className="flex-row items-center gap-3" style={{ minHeight: 44 }}>
                  <Text className={`flex-1 text-base ${used ? 'text-ink-3 dark:text-gray-500' : 'text-ink dark:text-gray-100'}`}>{t('fieldLib.multiSwitch')}</Text>
                  <Switch value={form.multi} disabled={used} onValueChange={(v) => set({ multi: v })} accessibilityLabel={t('fieldLib.multiSwitch')} />
                </View>
              </>
            ) : null}
          </FormCard>
        ) : null}

        {form.datatype === 'numeric' ? (
          <FormCard title={t('fieldLib.numeric')}>
            <Seg
              value={form.numeric_kind}
              options={[
                { value: 'float', label: t('fieldLib.decimal') },
                { value: 'integer', label: t('fieldLib.integer') },
              ]}
              onChange={(v) => set({ numeric_kind: v })}
            />
            <View className="flex-row gap-3">
              <Field label={t('fieldLib.min')} className="flex-1">
                <TextBox value={form.min} onChange={(v) => set({ min: v })} accessibilityLabel={t('fieldLib.min')} keyboardType="numbers-and-punctuation" />
              </Field>
              <Field label={t('fieldLib.max')} className="flex-1">
                <TextBox value={form.max} onChange={(v) => set({ max: v })} accessibilityLabel={t('fieldLib.max')} keyboardType="numbers-and-punctuation" />
              </Field>
            </View>
            <Field label={t('fieldLib.unit')}>
              {used ? (
                <Text className="text-base text-ink dark:text-gray-100">{form.unit || '—'}</Text>
              ) : (
                <TextBox value={form.unit} onChange={(v) => set({ unit: v })} placeholder="cm" accessibilityLabel={t('fieldLib.unit')} autoCapitalize="none" />
              )}
            </Field>
          </FormCard>
        ) : null}

        {existing ? (
          <FormCard>
            <View className="flex-row items-center gap-3" style={{ minHeight: 44 }}>
              <View className="flex-1">
                <Text className="text-base text-ink dark:text-gray-100">{t('fieldLib.deprecate')}</Text>
                <Text className="text-xs leading-4 text-ink-3 dark:text-gray-400">{t('fieldLib.deprecateDesc')}</Text>
              </View>
              <Switch value={deprecated} onValueChange={setDeprecated} accessibilityLabel={t('fieldLib.deprecate')} />
            </View>
          </FormCard>
        ) : null}
      </KeyboardAwareScrollView>
      <View className="border-t border-line bg-card px-4 py-3 dark:border-line-dark dark:bg-card-dark">
        <Button label={t('common.save')} icon="checkmark" fullWidth onPress={save} />
      </View>
    </SafeAreaView>
  );
}
