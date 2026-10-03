/**
 * Names inside a line of text (2F): an occurrence's label, or its common
 * name and its scientific name — italic by rank, as everywhere
 * (ScientificName; genus and epithets only). Rendered inside a parent
 * <Text>, so a sentence keeps flowing around them.
 */
import { Fragment, type ReactNode } from 'react';
import { Pressable, Text } from 'react-native';
import { ScientificName } from '~/components/ScientificName';
import { useToast } from '~/stores/toast';
import { splitSlots } from '~/survey/form/interactionText';

export type NameParts = {
  verbatim_identification?: string | null;
  common_name_c?: string | null;
  simple_name?: string | null;
  taxon_id: string;
  rank?: string | null;
  kingdom?: string | null;
};

/** `bold`: the scientific name takes the semibold files (a bold line around it). */
export function OccurrenceName({ o, bold }: { o: NameParts; bold?: boolean }) {
  if (o.verbatim_identification) return <>{o.verbatim_identification}</>;
  return (
    <>
      {o.common_name_c ? `${o.common_name_c} ` : ''}
      <ScientificName name={o.simple_name || o.taxon_id} rank={o.rank ?? ''} kingdom={o.kingdom ?? ''} className={bold ? 'font-semibold' : undefined} />
    </>
  );
}

/** A translated sentence with components where its slots are (interactionText.slot). */
export function withSlots(text: string, nodes: Readonly<Record<string, ReactNode>>): ReactNode[] {
  return splitSlots(text).map((p, i) => <Fragment key={i}>{'slot' in p ? (nodes[p.slot] ?? null) : p.text}</Fragment>);
}

/** A screen title that is an occurrence's name, as HeaderTitleText: one line, a tap shows it whole. `plain`: the same name as text. */
export function HeaderOccurrenceName({ o, plain }: { o: NameParts; plain: string }) {
  const toast = useToast((st) => st.show);
  return (
    <Pressable onPress={() => toast(plain)} accessibilityRole="header" accessibilityLabel={plain} hitSlop={6} style={{ flexShrink: 1 }}>
      <Text numberOfLines={1} ellipsizeMode="tail" className="text-[17px] font-semibold text-gray-900 dark:text-gray-100">
        <OccurrenceName o={o} bold />
      </Text>
    </Pressable>
  );
}
