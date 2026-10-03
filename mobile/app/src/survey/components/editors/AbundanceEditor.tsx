/**
 * Abundance (organismQuantity + organismQuantityType) with the inputs plot
 * species use (src/components/abundance/AbundanceInputs.tsx): the scale is
 * picked among the template's kinds, then the value in that scale. Numbers
 * keep the text as typed and send what parseNum reads.
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';
import { BBInput, CountInput, CustomInput, DBHInput, PercentInput, PercentQuickValues } from '~/components/abundance/AbundanceInputs';
import { Seg } from '~/components/form/Segmented';
import { kindForType, parseDbhArray, serializeDbhArray } from '~/lib/dwcAbundanceCore';
import { parseNum } from '~/lib/parseNum';
import { ABUNDANCE_TYPE, ABUNDANCE_KINDS } from '~/survey/registry';
import { ProblemLines, type EditorProps } from './shared';

type Kind = (typeof ABUNDANCE_KINDS)[number];

export function AbundanceEditor({ instance, values, onChange, problems, readOnly, context }: EditorProps) {
  const autoFocus = !context?.noAutoFocus;
  const { t } = useTranslation();
  const kinds = (Array.isArray(instance.params.kinds) ? instance.params.kinds : ['BB']) as Kind[];
  const type = typeof values.organism_quantity_type === 'string' ? values.organism_quantity_type : null;
  const stored = typeof values.organism_quantity === 'string' ? values.organism_quantity : values.organism_quantity == null ? '' : String(values.organism_quantity);
  const kind: Kind = type ? kindForType(type) : ((instance.params.default as Kind) ?? kinds[0]);
  const [text, setText] = useState(stored);
  const [dbhDraft, setDbhDraft] = useState('');
  const [customType, setCustomType] = useState(type && kind === 'custom' ? type : '');

  const label = (k: Kind) => {
    switch (k) {
      case 'BB':
        return 'BB';
      case 'percent':
        return '%';
      case 'count':
        return t('survey.editor.abundance.count');
      case 'DBH':
        return 'DBH';
      case 'custom':
        return t('plotValue.custom');
    }
  };
  const pick = (k: Kind) => {
    if (readOnly || k === kind) return;
    setText('');
    onChange({ organism_quantity: null, organism_quantity_type: k === 'custom' ? customType || null : ABUNDANCE_TYPE[k] });
  };
  /** A number typed: the text stays as typed, the value is what it reads as. */
  const typed = (v: string, k: Exclude<Kind, 'BB' | 'DBH' | 'custom'>) => {
    setText(v);
    const n = parseNum(v);
    onChange({ organism_quantity: v.trim() === '' ? null : n == null ? v : String(n), organism_quantity_type: ABUNDANCE_TYPE[k] });
  };
  const stems = kind === 'DBH' ? parseDbhArray(stored) : [];

  return (
    <View className="gap-2" pointerEvents={readOnly ? 'none' : 'auto'}>
      {kinds.length > 1 ? <Seg value={kind} options={kinds.map((k) => ({ value: k, label: label(k) }))} onChange={pick} /> : null}
      {kind === 'BB' ? (
        <BBInput value={stored || null} onChange={(v) => onChange({ organism_quantity: v, organism_quantity_type: ABUNDANCE_TYPE.BB })} />
      ) : null}
      {kind === 'percent' ? (
        <>
          <PercentInput value={text} onChange={(v) => typed(v, 'percent')} autoFocus={autoFocus} />
          <PercentQuickValues onPick={(v) => typed(v, 'percent')} />
        </>
      ) : null}
      {kind === 'count' ? <CountInput value={text} onChange={(v) => typed(v, 'count')} suffix={t('survey.editor.abundance.countSuffix')} autoFocus={autoFocus} /> : null}
      {kind === 'DBH' ? (
        <DBHInput
          autoFocus={autoFocus}
          stems={stems}
          stemDraft={dbhDraft}
          setStemDraft={setDbhDraft}
          onAdd={() => {
            const n = parseNum(dbhDraft);
            if (n == null || n <= 0) return;
            setDbhDraft('');
            onChange({ organism_quantity: serializeDbhArray([...stems, n]), organism_quantity_type: ABUNDANCE_TYPE.DBH });
          }}
          onRemove={(i) => onChange({ organism_quantity: serializeDbhArray(stems.filter((_, j) => j !== i)), organism_quantity_type: ABUNDANCE_TYPE.DBH })}
        />
      ) : null}
      {kind === 'custom' ? (
        <CustomInput
          typeValue={customType}
          setTypeValue={(v) => {
            setCustomType(v);
            onChange({ organism_quantity_type: v.trim() || null });
          }}
          quantityValue={text}
          setQuantityValue={(v) => {
            setText(v);
            onChange({ organism_quantity: v.trim() || null, organism_quantity_type: customType.trim() || null });
          }}
        />
      ) : null}
      <ProblemLines problems={problems} />
    </View>
  );
}
