import { Text, type TextProps } from 'react-native';
import { scientificNameSegments } from '~/lib/scientificNameSegments';

/**
 * Render a scientific name with correct italic semantics:
 *   - genus, species, epithets, subordinate epithets → italic
 *   - rank abbreviations (var., subsp., ssp., f., fo., ×) → NOT italic
 *   - author and any trailing text → NOT italic
 *   - family, order, class, phylum, kingdom (and any other high rank) → NOT italic
 *
 * For animals (ICZN), the binomial / trinomial up to the author block is
 * italic; rank tokens still break italics.
 *
 * Pass `name` (typically `simple_name`, no author) and optional `author` to
 * append the author block (always non-italic). Pass `rank` when you have it —
 * single-word names like "Lycopodiaceae" can only be classified correctly
 * with explicit rank since the parser otherwise can't tell a Family from a
 * Genus.
 *
 * Set in Source Serif 4. Each segment names its font file outright: RN does
 * not swap to an italic or bold file for `fontStyle` / `fontWeight`, and on
 * Android it would instead fake a slant or bold on top of the chosen file. So
 * segments never carry `italic`, and reset the weight a `font-semibold` on
 * `className` gives them; that class picks the 600 files instead.
 */

type Props = {
  name: string;
  author?: string;
  kingdom?: string;
  nomenclature?: string;
  rank?: string;
  italicClassName?: string;
} & TextProps;

export function ScientificName({
  name,
  author,
  kingdom = '',
  nomenclature = '',
  rank = '',
  italicClassName,
  ...textProps
}: Props) {
  const segments = scientificNameSegments(name, { kingdom, nomenclature, rank });
  const bold = /\bfont-(semibold|bold|extrabold|black)\b/.test(textProps.className ?? '');
  const italic = italicClassName ?? (bold ? 'font-latin-semibold font-normal' : 'font-latin font-normal');
  const upright = bold ? 'font-latin-semibold-upright font-normal' : 'font-latin-upright font-normal';

  return (
    <Text {...textProps}>
      {segments.map((s, i) => (
        <Text key={i} className={s.italic ? italic : upright}>
          {s.text}
        </Text>
      ))}
      {author ? <Text className={upright}>{` ${author}`}</Text> : null}
    </Text>
  );
}
