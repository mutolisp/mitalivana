/**
 * Export settings — was a bottom sheet with a Done button that only dismissed
 * it. Every control writes straight through to settings, so there was nothing to
 * confirm and nothing to cancel; as a pushed route the back chevron is the
 * whole interaction.
 */
import { ExportPreferenceOptions } from '~/components/ExportPreferenceOptions';
import { FocusScrollView } from '~/components/settings/FocusScroll';
import { SettingsPage } from '~/components/settings/SettingsPage';

export default function ExportSettingsScreen() {
  return (
    <SettingsPage>
      <FocusScrollView contentContainerStyle={{ padding: 16, paddingBottom: 24 }}>
        <ExportPreferenceOptions />
      </FocusScrollView>
    </SettingsPage>
  );
}
