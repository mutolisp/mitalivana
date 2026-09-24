/**
 * Modal/sheet wrapper around SpeciesDetailPanel for contexts that don't have
 * inline space (taxonomy tree popup, key result, session list long-press).
 * Inline use cases (the search panel) render SpeciesDetailPanel directly.
 *
 * Sheet-local state: `currentResult` is seeded from `props.result`, but the
 * subordinate-taxa section can swap it to an infraspecies in-place. The parent's
 * `props.result` reset (e.g. set to null on close) re-seeds the local state
 * via the `useEffect` below. No history stack — picking a subordinate
 * replaces the visible taxon; closing the sheet ends the session.
 */
import { useEffect, useState } from 'react';
import { Modal, Pressable, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { ExternalTaxon, SearchResult } from '~/db';
import { taxonSpeciesToSearchResult } from '~/lib/taxonSpecies';
import { editManualTaxon, runOverModal } from './GbifLookupHost';
import { clearSearchResultCache } from './SearchBox';
import { SpeciesDetailPanel } from './SpeciesDetailPanel';
import { ToastHost } from './ToastHost';

type Props = {
  result: SearchResult | null;
  onClose: () => void;
  onAddToSession: () => void;
  /** Override the add-button label (e.g. "add to the current plot" when a plot is
   *  active). */
  addButtonLabel?: string;
  /** Long-press on the add button — offers the specimen-collection destination.
   *  Awaited, so the caller can close the sheet only after the chooser
   *  resolves. */
  onAddLongPress?: () => void | Promise<void>;
};

export function LookupResultSheet({
  result,
  onClose,
  onAddToSession,
  addButtonLabel,
  onAddLongPress,
}: Props) {
  const [currentResult, setCurrentResult] = useState<SearchResult | null>(result);
  // True while the manual-taxon editor is up — see runOverModal.
  const [steppedAside, setSteppedAside] = useState(false);

  const handleEditManualTaxon = async (ext: ExternalTaxon) => {
    const out = await runOverModal(
      setSteppedAside,
      () => editManualTaxon(ext),
      (o) => o === 'deleted',
    );
    if (out === 'deleted') {
      // A cached result would keep offering the deleted taxon.
      clearSearchResultCache();
      onClose();
      return;
    }
    if (out) setCurrentResult(out.result);
  };

  // Re-seed local state whenever the parent passes a different taxon (or null
  // on close). Using taxon_id+name as the dependency catches the common case
  // where the parent flips between two distinct taxa without unmounting.
  useEffect(() => {
    setCurrentResult(result);
  }, [result?.taxon_id, result?.name]);

  if (!currentResult) return null;

  return (
    <Modal visible={!steppedAside} animationType="slide" transparent onRequestClose={onClose}>
      <View className="flex-1">
        <Pressable
          onPress={onClose}
          style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.4)' }}
        />
        <View
          style={{ position: 'absolute', bottom: 0, left: 0, right: 0, height: '85%' }}
          className="rounded-t-2xl bg-white dark:bg-gray-900"
        >
          <SafeAreaView edges={['bottom']} className="flex-1">
            <View className="items-center pt-2">
              <View className="h-1 w-12 rounded-full bg-gray-300 dark:bg-gray-700" />
            </View>
            <SpeciesDetailPanel
              result={currentResult}
              onAddToSession={() => {
                onAddToSession();
                onClose();
              }}
              addButtonLabel={addButtonLabel}
              // Passed straight through: do NOT close the sheet here. The
              // handler presents an ActionSheet, and iOS cannot present one
              // from a view controller that is being dismissed in the same
              // tick — that crashed the app. Presenting *over* this Modal is
              // fine (SpeciesDetailSheet does it), so the caller closes only
              // after the handler resolves.
              onAddLongPress={onAddLongPress}
              onClose={onClose}
              onPickSubordinate={(sp) => setCurrentResult(taxonSpeciesToSearchResult(sp))}
              onEditManualTaxon={handleEditManualTaxon}
            />
          </SafeAreaView>
        </View>
      </View>
      {/* Toasts fired while this sheet is up (it has its own window). */}
      <ToastHost inModal />
    </Modal>
  );
}
