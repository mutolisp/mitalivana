/**
 * React Native's Switch with the app's colours filled in.
 *
 * Left bare, the switch takes the platform default: Material's teal on
 * Android, system green on iOS — neither of them the app accent. Every prop
 * passes through, so a caller can still override a colour.
 */
import { Switch as RNSwitch, type SwitchProps } from 'react-native';

import { LIGHT, useThemeColors } from '~/theme/colors';

export function Switch(props: SwitchProps) {
  const c = useThemeColors();
  return (
    <RNSwitch
      trackColor={{ false: c.disabled, true: c.accent }}
      // A light thumb in both themes, as on iOS: a dark thumb on the dark
      // off-track would disappear.
      thumbColor={LIGHT.card}
      ios_backgroundColor={c.disabled}
      {...props}
    />
  );
}
