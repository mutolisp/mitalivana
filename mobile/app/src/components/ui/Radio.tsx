/**
 * Single choice (05-controls.md §2.3): a 22 pt ring with a centre dot when
 * chosen. Told apart from the round SelectMark by dot versus tick. Visual
 * only — the row around it is the control and carries the radio role.
 */
import { View } from 'react-native';

export function Radio({ selected, disabled = false }: { selected: boolean; disabled?: boolean }) {
  return (
    <View
      className={`items-center justify-center rounded-full border-2 ${
        selected ? 'border-accent-600 dark:border-accent-400' : 'border-mark dark:border-mark-dark'
      } ${disabled ? 'opacity-40' : ''}`}
      style={{ width: 22, height: 22 }}
    >
      {selected ? <View className="rounded-full bg-accent-600 dark:bg-accent-400" style={{ width: 10, height: 10 }} /> : null}
    </View>
  );
}
