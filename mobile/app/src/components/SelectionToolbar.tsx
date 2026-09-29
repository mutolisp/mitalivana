/**
 * Select mode chrome (05-controls.md §2.1), shared by every list with a
 * long-press selection:
 *
 *   SelectionToolbar  top: ✕ (leave) · 已選 N 項 · select-all mark
 *   SelectionDock     bottom: the actions, where the thumb is
 *
 * The select-all mark is three-state: off with nothing picked, mixed with
 * some, on with all; tapping mixed or off selects all, tapping on clears.
 * Picking the last row off does not leave select mode — a stray tap should
 * not throw the user out of a half-built selection.
 */
import { useRef, type RefObject } from 'react';
import { useTranslation } from 'react-i18next';
import { Text, View } from 'react-native';
import { Button } from '~/components/ui/Button';
import { IconDisc } from '~/components/ui/IconDisc';
import { SelectMark } from '~/components/ui/SelectMark';

export type SelectionAction = {
  label: string;
  /** Plain action, or `onMenu` to open an OverflowMenu from this button. */
  onPress?: () => void;
  onMenu?: (anchor: RefObject<View | null>) => void;
  /** Destructive actions use the danger look. */
  destructive?: boolean;
  /** Enabled even with nothing picked (e.g. an action that opens a chooser). */
  always?: boolean;
};

export function SelectionToolbar({
  count,
  allPicked,
  onToggleAll,
  onCancel,
}: {
  count: number;
  /** Every visible row is picked. */
  allPicked?: boolean;
  /** Omit to hide select-all — the taxonomy tree has no meaningful "all". */
  onToggleAll?: () => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const state = count === 0 ? 'off' : allPicked ? 'on' : 'mixed';
  return (
    <View className="flex-row items-center border-b border-line bg-card px-2 dark:border-line-dark dark:bg-card-dark" style={{ minHeight: 52 }}>
      <IconDisc icon="close" onPress={onCancel} accessibilityLabel={t('common.exitSelect')} />
      <Text className="flex-1 text-center text-base font-semibold text-ink dark:text-gray-100" style={{ fontVariant: ['tabular-nums'] }}>
        {t('common.selectedCount', { count })}
      </Text>
      <View className="h-11 w-11 items-center justify-center">
        {onToggleAll ? <SelectMark state={state} onPress={onToggleAll} accessibilityLabel={t('common.selectAll')} /> : null}
      </View>
    </View>
  );
}

/** The actions for the current selection, docked at the bottom. */
export function SelectionDock({
  count,
  actions,
  bottomInset = 0,
}: {
  count: number;
  actions: SelectionAction[];
  /** Extra space below (a floating tab bar). */
  bottomInset?: number;
}) {
  return (
    <View
      className="items-center border-t border-line bg-card px-4 pt-2.5 dark:border-line-dark dark:bg-card-dark"
      style={{ paddingBottom: 10 + bottomInset }}
    >
      <View className="w-full flex-row flex-wrap justify-center gap-2" style={{ maxWidth: 520 }}>
        {actions.map((a) => (
          <DockButton key={a.label} action={a} disabled={count === 0 && !a.always} />
        ))}
      </View>
    </View>
  );
}

function DockButton({ action: a, disabled }: { action: SelectionAction; disabled: boolean }) {
  // A View around the button is the menu's anchor (Button takes no ref).
  const anchor = useRef<View>(null);
  return (
    <View ref={anchor} collapsable={false} className="flex-grow">
      <Button
        label={a.label}
        icon={a.onMenu ? 'ellipsis-horizontal' : undefined}
        onPress={() => (a.onMenu ? a.onMenu(anchor) : a.onPress?.())}
        variant={a.destructive ? 'danger' : 'secondary'}
        disabled={disabled}
      />
    </View>
  );
}
