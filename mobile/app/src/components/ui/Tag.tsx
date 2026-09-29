/**
 * Status tag for a taxon: endemic, alien status, protected, red list
 * (02-components.md). One shape for what used to be bare coloured text, a
 * pill and an italic word in three different places on the species row.
 *
 * Both sizes use `text-xs` so the tag follows the font scale; the spec's
 * 11 pt for `sm` has no scalable class, so `sm` differs from `md` by padding.
 */
import { Text, View } from 'react-native';

import { iucnTone } from '~/lib/conservationColors';

export type TagKind =
  | 'endemic'
  | 'invasive'
  | 'naturalized'
  | 'cultivated'
  | 'captive'
  | 'protected'
  | 'iucn'
  // Generic looks for non-taxon facts (a summit's zone and survey state).
  | 'neutral'
  | 'acorn';

const LOOK: Record<Exclude<TagKind, 'iucn'>, { box: string; text: string }> = {
  endemic: { box: 'bg-accent-100 dark:bg-accent-900', text: 'text-accent-700 dark:text-accent-300' },
  invasive: { box: 'bg-alert-tint dark:bg-alert-dark-tint', text: 'text-alert dark:text-alert-dark' },
  naturalized: { box: 'bg-acorn-tint dark:bg-gray-800', text: 'text-acorn-deep dark:text-acorn' },
  cultivated: { box: 'bg-gray-100 dark:bg-gray-800', text: 'text-cupule dark:text-gray-300' },
  captive: { box: 'bg-gray-100 dark:bg-gray-800', text: 'text-cupule dark:text-gray-300' },
  protected: { box: 'bg-gray-100 dark:bg-gray-800', text: 'text-cupule dark:text-gray-300' },
  neutral: { box: 'bg-gray-100 dark:bg-gray-800', text: 'text-cupule dark:text-gray-300' },
  acorn: { box: 'bg-acorn-tint dark:bg-gray-800', text: 'text-acorn-deep dark:text-acorn' },
};

export function Tag({
  kind,
  label,
  iucnCode,
  size = 'sm',
}: {
  kind: TagKind;
  /** Ignored for `iucn`, which shows the code itself. */
  label?: string;
  iucnCode?: string | null;
  size?: 'sm' | 'md';
}) {
  const pad = size === 'md' ? 'px-2 py-0.5 rounded-[5px]' : 'px-1.5 rounded';
  if (kind === 'iucn') {
    // Red-list colours are the IUCN palette (conservationColors.ts), not app
    // tokens, so they stay inline.
    const tone = iucnTone(iucnCode);
    if (!tone) return null;
    return (
      <View className={pad} style={{ backgroundColor: tone.bg }}>
        <Text className="text-xs font-bold" style={{ color: tone.text }}>
          {tone.label}
        </Text>
      </View>
    );
  }
  if (!label) return null;
  const look = LOOK[kind];
  return (
    <View className={`${pad} ${look.box}`}>
      <Text className={`text-xs font-bold ${look.text}`}>{label}</Text>
    </View>
  );
}
