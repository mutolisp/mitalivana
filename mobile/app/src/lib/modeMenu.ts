/**
 * A ⋯ menu as the usage mode shows it (src/lib/usageMode.ts).
 *
 *   showMenu(anchor, modeSections(mode, sections, { merge: 'mergeRecords' }, t('mode.advanced')))
 *
 * An item whose capability the mode hides is dropped; one it folds moves into
 * a 進階 section of its own, placed before a closing section of destructive
 * items (deleting stays last). Items without a capability, and every item in
 * pro mode, stay where they are. Sections left empty are dropped.
 */
import type { MenuItem, MenuSection } from '~/components/OverflowMenu';
import { vis, type Cap, type UsageMode } from './usageMode';

export function modeSections(
  mode: UsageMode,
  sections: MenuSection[],
  caps: Partial<Record<string, Cap>>,
  advancedTitle: string,
): MenuSection[] {
  const folded: MenuItem[] = [];
  const out = sections
    .map((sec) => ({
      ...sec,
      items: sec.items.filter((it) => {
        const cap = caps[it.id];
        if (!cap) return true;
        const v = vis(mode, cap);
        if (v === 'adv') folded.push(it);
        return v === 'show';
      }),
    }))
    .filter((sec) => sec.items.length > 0);
  if (folded.length === 0) return out;
  const tail = out[out.length - 1];
  const at = tail?.items.every((it) => it.kind === 'action' && it.destructive) ? out.length - 1 : out.length;
  out.splice(at, 0, { title: advancedTitle, items: folded });
  return out;
}
