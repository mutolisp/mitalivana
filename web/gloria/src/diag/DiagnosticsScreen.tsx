/** Route wrapper for the phase-0 diagnostics page. */
import { Stack } from '../router/router';
import { Diagnostics } from './Diagnostics';
import { useBoot } from '../shell/bootStore';

export default function DiagnosticsScreen() {
  const boot = useBoot();
  if (!boot) return null;
  return (
    <>
      <Stack.Screen options={{ headerShown: false }} />
      <Diagnostics flusher={boot.flusher} timings={boot.timings} speciesVersion={boot.speciesVersion} />
    </>
  );
}
