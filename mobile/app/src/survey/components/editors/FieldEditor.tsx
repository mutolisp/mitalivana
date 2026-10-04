/**
 * A 自訂欄位's input (2026-10-04; template/obsField.ts), by its data type:
 *   - text: a text box, or its allowed values as chips (one, or several);
 *   - numeric: a number with its unit, within its range;
 *   - date / time / datetime: the date-time field, set and cleared here;
 *   - taxon: a row opening the species search on a screen of its own;
 *   - dna: a monospaced box taking A, T, C, G (upper-cased as it is saved).
 * The field's description, when it has one, is under it.
 */
import { useTranslation } from 'react-i18next';
import { Pressable, Text, View } from 'react-native';
import { DateTimeField } from '~/components/DateTimeField';
import { LabeledNumField } from '~/components/form/LabeledField';
import { ScientificName } from '~/components/ScientificName';
import { Chip } from '~/components/ui/Chip';
import { isoDate, isoTime } from '~/lib/datetime';
import { useDraftValue } from '~/lib/useDraftValue';
import { useThemeColors } from '~/theme/colors';
import { TextBox } from '~/survey/components/FormBits';
import { pickTaxon } from '~/survey/form/pickTaxon';
import { datetimeValue, fieldDefOf, normalizeDna, valueToTs, type ObsFieldDef } from '~/survey/template/obsField';
import { Ionicons } from '@expo/vector-icons';
import { ProblemLines, type EditorProps } from './shared';

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const list = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : typeof v === 'string' && v ? [v] : []);

/** An allowed value as the app's language reads it: its English name in English, else the value. */
export function allowedText(def: ObsFieldDef, value: string, lang: string): string {
  return lang.startsWith('en') ? def.allowed?.find((a) => a.value === value)?.en || value : value;
}

export function FieldEditor({ instance, values, onChange, problems, readOnly, context }: EditorProps) {
  const { t, i18n } = useTranslation();
  const def = fieldDefOf(instance.params);
  if (!def) return <Text className="text-xs text-alert dark:text-alert-dark">{t('fieldLib.err.invalid')}</Text>;
  return (
    <View className="gap-1.5" pointerEvents={readOnly ? 'none' : 'auto'}>
      {def.datatype === 'text' && def.allowed ? (
        <AllowedChips def={def} value={values.value} lang={i18n.language} onChange={(v) => onChange({ value: v })} />
      ) : def.datatype === 'text' ? (
        <FreeText value={str(values.value)} label={def.name} onSave={(v) => onChange({ value: v || null })} editable={!readOnly} />
      ) : def.datatype === 'numeric' ? (
        <LabeledNumField
          label={t('fieldLib.value')}
          suffix={def.unit}
          value={typeof values.value === 'number' ? values.value : null}
          min={def.min}
          max={def.max}
          onSave={(n) => onChange({ value: n })}
        />
      ) : def.datatype === 'date' || def.datatype === 'time' || def.datatype === 'datetime' ? (
        <WhenValue mode={def.datatype} value={str(values.value) || null} onChange={(v) => onChange({ value: v })} />
      ) : def.datatype === 'taxon' ? (
        <TaxonValue
          values={values}
          title={def.name}
          around={context?.aroundNavigate}
          onChange={(p) => onChange(p ? { value: p.taxonId, name: p.name, cname: p.cname, rank: p.rank, kingdom: p.kingdom } : { value: null, name: null, cname: null, rank: null, kingdom: null })}
        />
      ) : (
        <DnaText value={str(values.value)} label={def.name} onSave={(v) => onChange({ value: v || null })} editable={!readOnly} />
      )}
      {def.description ? <Text className="text-xs leading-4 text-ink-3 dark:text-gray-400">{def.description}</Text> : null}
      <ProblemLines problems={problems} />
    </View>
  );
}

function AllowedChips({ def, value, lang, onChange }: { def: ObsFieldDef; value: unknown; lang: string; onChange: (v: string | string[] | null) => void }) {
  const { t } = useTranslation();
  const chosen = list(value);
  const all = def.allowed ?? [];
  // A deprecated value is no longer offered, but still shows where it was chosen.
  const shown = all.filter((a) => !a.deprecated || chosen.includes(a.value));
  const toggle = (v: string) => {
    if (def.multi) {
      const next = chosen.includes(v) ? chosen.filter((x) => x !== v) : [...chosen, v];
      // In the field's order, whatever order they were tapped in.
      const ordered = all.map((a) => a.value).filter((x) => next.includes(x));
      onChange(ordered.length ? ordered : null);
    } else onChange(chosen[0] === v ? null : v);
  };
  return (
    <View className="gap-1">
      <View className="flex-row flex-wrap gap-2">
        {shown.map((a) => (
          <Chip key={a.value} label={allowedText(def, a.value, lang)} selected={chosen.includes(a.value)} onPress={() => toggle(a.value)} />
        ))}
      </View>
      {def.multi ? <Text className="text-xs text-ink-3 dark:text-gray-400">{t('survey.editor.choice.multi')}</Text> : null}
    </View>
  );
}

function FreeText({ value, label, onSave, editable }: { value: string; label: string; onSave: (v: string) => void; editable: boolean }) {
  // Written once typing pauses or the field is left, not letter by letter.
  const draft = useDraftValue(value, (v) => onSave(v.trim()));
  return <TextBox value={draft.value} onChange={draft.change} onBlur={draft.flush} accessibilityLabel={label} editable={editable} />;
}

function DnaText({ value, label, onSave, editable }: { value: string; label: string; onSave: (v: string) => void; editable: boolean }) {
  const draft = useDraftValue(value, (v) => onSave(normalizeDna(v)));
  return (
    <TextBox
      value={draft.value}
      onChange={draft.change}
      onBlur={draft.flush}
      accessibilityLabel={label}
      editable={editable}
      multiline
      autoCapitalize="characters"
      // Upper-cased as it is saved: no word composing to fight with (Gboard).
      keyboardType="visible-password"
      mono
    />
  );
}

function WhenValue({ mode, value, onChange }: { mode: 'date' | 'time' | 'datetime'; value: string | null; onChange: (v: string | null) => void }) {
  const { t } = useTranslation();
  const ts = valueToTs(mode, value);
  const of = (x: number) => (mode === 'date' ? isoDate(x) : mode === 'time' ? isoTime(x) : datetimeValue(x));
  if (ts == null) {
    return (
      <View className="gap-1">
        {/* Unset reads as unset, not as now. A value of another form (typed elsewhere) is shown as it is. */}
        {value ? <Text className="text-sm text-ink dark:text-gray-100">{value}</Text> : null}
        <Pressable onPress={() => onChange(of(Date.now()))} accessibilityRole="button" className="self-start" style={{ minHeight: 44, justifyContent: 'center' }}>
          <Text className="text-sm font-semibold text-accent-600 dark:text-accent-400">{t('fieldLib.setNow')}</Text>
        </Pressable>
      </View>
    );
  }
  return (
    <View className="flex-row items-center gap-3">
      <View className="flex-1">
        <DateTimeField value={ts} mode={mode} onChange={(x) => onChange(of(x))} />
      </View>
      <Pressable onPress={() => onChange(null)} accessibilityRole="button" accessibilityLabel={t('common.clear')} hitSlop={8} style={{ minHeight: 44, justifyContent: 'center' }}>
        <Text className="text-sm text-ink-2 dark:text-gray-300">{t('common.clear')}</Text>
      </Pressable>
    </View>
  );
}

function TaxonValue({
  values,
  title,
  around,
  onChange,
}: {
  values: EditorProps['values'];
  title: string;
  around?: <T>(go: () => Promise<T>) => Promise<T>;
  onChange: (p: { taxonId: string; name: string; cname: string | null; rank: string; kingdom: string } | null) => void;
}) {
  const { t } = useTranslation();
  const c = useThemeColors();
  const name = str(values.name);
  const cname = str(values.cname);
  const pick = async () => {
    const go = () => pickTaxon(title);
    const p = around ? await around(go) : await go();
    if (p) onChange(p);
  };
  return (
    <View className="flex-row items-center gap-3">
      <Pressable
        onPress={() => void pick()}
        accessibilityRole="button"
        accessibilityLabel={name ? `${title} ${cname} ${name}` : `${title} ${t('fieldLib.pickTaxon')}`}
        className="flex-1 flex-row items-center gap-2 rounded-lg border border-gray-300 bg-card px-3 py-2.5 active:bg-gray-100 dark:border-gray-700 dark:bg-gray-900 dark:active:bg-gray-800"
      >
        <View className="flex-1">
          {name ? (
            <Text className="text-base text-ink dark:text-gray-100" numberOfLines={1}>
              {cname ? `${cname} ` : ''}
              <ScientificName name={name} rank={str(values.rank)} kingdom={str(values.kingdom)} />
            </Text>
          ) : (
            <Text className="text-base text-ink-3 dark:text-gray-400">{t('fieldLib.pickTaxon')}</Text>
          )}
        </View>
        <Ionicons name="search" size={18} color={c.ink2} />
      </Pressable>
      {name ? (
        <Pressable onPress={() => onChange(null)} accessibilityRole="button" accessibilityLabel={t('common.clear')} hitSlop={8} style={{ minHeight: 44, justifyContent: 'center' }}>
          <Text className="text-sm text-ink-2 dark:text-gray-300">{t('common.clear')}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}
