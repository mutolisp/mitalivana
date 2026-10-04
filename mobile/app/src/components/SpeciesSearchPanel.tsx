/**
 * Reusable species search panel: full-text + fuzzy search with the detail
 * rendered inline above the search box (no modal). Tapping a result fills the
 * empty area with SpeciesDetailPanel; users can dismiss with the X or just
 * pick another result. Add-to-session clears the panel so the next search is
 * one tap away — this is the field-recording happy path.
 *
 * Used by:
 *   - (tabs)/taxonomy.tsx (Search segment)
 */
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';
import { useTabDock } from '~/lib/tabBarLayout';
import { Keyboard, Text, View } from 'react-native';
import { TabDock } from './TabDock';
import { addSearchHistory, type SearchResult } from '~/db';
import { useSpeciesSearchPanel } from '~/stores/speciesSearchPanel';
import { useAddToActiveRecord } from '~/lib/useAddToActiveRecord';
import { taxonSpeciesToSearchResult } from '~/lib/taxonSpecies';
import { useActiveGloria } from '~/modules/gloria/store';
import { GLORIA_SEARCH_GROUPS } from '~/modules/gloria/useSurvey';
import { SearchBox } from './SearchBox';
import { SpeciesDetailPanel } from './SpeciesDetailPanel';

type Props = {
  autoFocus?: boolean;
};

export function SpeciesSearchPanel({ autoFocus = false }: Props) {
  const { t } = useTranslation();
  const { addSpecies, promptAddDestination, modal, targetLabel } = useAddToActiveRecord();
  // While a GLORIA survey is active, a pick here lands in its species roster.
  const gloriaActive = useActiveGloria((s) => s.survey != null);
  // The tab bar floats over the scene, so this dock's natural laid-out position
  // is the SCREEN bottom — behind the pill. TabDock lifts it clear of the bar
  // while the keyboard is closed (or drops it beside the folded bar's button);
  // `dockLift` is how much of the content above it the lifted dock covers.
  // See src/lib/tabBarLayout.ts.
  const { lift: dockLift } = useTabDock();
  // `active` lives in a module-level store so it survives segment switches
  // inside the species tab. Without persistence, tapping a rank chip on the
  // inline detail forces the segment to 'tree' (cross-screen jump), which
  // unmounts this panel and wipes the local detail state — coming back to
  // 'search' shows an empty panel. The store keeps the prior detail visible.
  const active = useSpeciesSearchPanel((s) => s.active);
  const setActive = useSpeciesSearchPanel((s) => s.setActive);

  const handleSelect = (result: SearchResult) => {
    addSearchHistory(result.cname || result.name);
    Keyboard.dismiss();
    setActive(result);
  };

  const handleLongPress = (result: SearchResult) => {
    Keyboard.dismiss();
    setActive(result);
  };

  const handleAdd = () => {
    if (!active) return;
    // Smart-routes to active plot (opens abundance modal) or session.
    addSpecies(active);
    // Clear the inline detail so the next search is one tap away.
    setActive(null);
  };

  return (
    <View className="flex-1">
      {/* The dock below is translated UP by `dockLift` to clear the tab bar,
          so it overlays exactly that much of this box. Padding (inside
          the view, so the white background still reaches the dock) keeps the
          panel's last element — the add-to-record button — above it. Same
          reservation the tree segment makes via contentContainerStyle. */}
      <View
        className="flex-1 bg-card dark:bg-gray-900"
        style={{ paddingBottom: dockLift }}
      >
        {active ? (
          <SpeciesDetailPanel
            result={active}
            onAddToSession={handleAdd}
            addButtonLabel={targetLabel}
            onAddLongPress={async () => {
              if (!active) return;
              if (await promptAddDestination(active)) setActive(null);
            }}
            onClose={() => setActive(null)}
            onPickSubordinate={(sp) => setActive(taxonSpeciesToSearchResult(sp))}
          />
        ) : (
          <View className="flex-1 items-center justify-center px-8">
            <Ionicons name="search-outline" size={48} color="#cbd5e1" />
            <Text className="mt-3 text-center text-sm text-gray-500 dark:text-gray-400">
              {t('speciesSearch.hint', { br: '\n' })}
            </Text>
          </View>
        )}
      </View>
      <TabDock>
        <SearchBox
          onSelect={handleSelect}
          onLongPressResult={handleLongPress}
          autoFocus={autoFocus}
          afterSelect="dismiss"
          scopeGroups={gloriaActive ? GLORIA_SEARCH_GROUPS : undefined}
        />
      </TabDock>
      {modal}
    </View>
  );
}
