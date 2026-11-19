/** `expo-haptics`: a short vibration where the browser supports it (Android Chrome), otherwise nothing. */
const buzz = (ms: number) => {
  try {
    navigator.vibrate?.(ms);
  } catch {
    // not allowed (iOS, desktop): silent
  }
};
export const ImpactFeedbackStyle = { Light: 'light', Medium: 'medium', Heavy: 'heavy', Rigid: 'rigid', Soft: 'soft' } as const;
export const NotificationFeedbackType = { Success: 'success', Warning: 'warning', Error: 'error' } as const;
export async function impactAsync(_s?: string) {
  buzz(10);
}
export async function selectionAsync() {
  buzz(5);
}
export async function notificationAsync(_t?: string) {
  buzz(20);
}
