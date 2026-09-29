/**
 * Species detail content (header + body) without modal/sheet chrome.
 *
 * Used by:
 *   - LookupResultSheet (wraps with Modal + drag handle for sheet UX)
 *   - SpeciesSearchPanel (renders inline above the search box, no modal)
 */
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';
import i18n from '~/i18n';
import { useEffect, useRef, useState } from 'react';
import { Linking, Pressable, ScrollView, Text, View } from 'react-native';
import {
  getExternalTaxon,
  endemicTagLabel,
  getInfraspeciesOf,
  getSynonyms,
  type Ancestors,
  type ExternalTaxon,
  type Rank,
  type SearchResult,
  type Synonym,
  type TaxonSpecies,
} from '~/db';
import { buildSpeciesCopyText, copyToClipboard, speciesCopyActions } from '~/lib/clipboard';
import { alienBadge } from '~/lib/conservationColors';
import { rankColor } from '~/lib/rankColors';
import { useFavorites } from '~/stores/favorites';
import { showActionSheet } from './ActionSheet';
import { CollapsibleSection, SynonymStatusBadge } from './CollapsibleSection';
import { ConservationBadge } from './ConservationBadge';
import { ScientificName } from './ScientificName';
import { editManualTaxon } from './GbifLookupHost';
import { clearSearchResultCache } from './SearchBox';

import { TaxonomyJumpChip } from './TaxonomyJumpChip';
import { useThemeColors } from '~/theme/colors';
import { Button } from '~/components/ui/Button';

type Props = {
  result: SearchResult;
  /** Omit to show the taxon for reading only — e.g. 分類資訊 opened from a
   *  record that already holds it, where an add button would add it twice. */
  onAddToSession?: () => void;
  /** Optional close button at top-right. Pass null/omit to hide. */
  onClose?: () => void;
  /** Override the add button text (e.g. for inline mode you might one day want
   *  "add and keep searching"). Defaults to "add to the current record". */
  addButtonLabel?: string;
  /** Long-press on the add button. Used to offer the alternative destination
   *  (specimen collection) without changing what a plain tap does. Omit to
   *  disable. */
  onAddLongPress?: () => void;
  /** Called when the user taps an infraspecies row in the subordinate-taxa
   *  section. The caller is expected to swap the visible detail to the picked
   *  taxon (`LookupResultSheet` / `SpeciesSearchPanel` route this to their
   *  internal `currentResult` state). When omitted, the row is rendered
   *  non-tappable. */
  onPickSubordinate?: (sp: TaxonSpecies) => void;
  /** Set when this panel sits inside a Modal. The manual-taxon editor is a
   *  root-hosted Modal, and presenting it over another Modal crashes iOS
   *  ("already presenting"), so the caller must get out of the way first and
   *  run the editor itself. When omitted the panel opens the editor directly. */
  onEditManualTaxon?: (ext: ExternalTaxon) => void;
};

function externalLinks(result: SearchResult): Array<{ label: string; url: string }> {
  const links: Array<{ label: string; url: string }> = [];
  // TaiCOL deep links only exist for TaiCOL ids — a 'y…'/'g…' id produced a
  // dead URL here before regions/packs made those common.
  if (result.taxon_id && result.taxon_id.charAt(0) === 't') {
    links.push({ label: 'TaiCOL', url: `https://taicol.tw/zh-hant/taxon/${result.taxon_id}` });
  }
  const sciEnc = encodeURIComponent(result.name);
  links.push({ label: 'GBIF', url: `https://www.gbif.org/species/search?q=${sciEnc}` });
  links.push({
    label: i18n.t('species.inatTaxon'),
    url: `https://www.inaturalist.org/taxa/search?q=${sciEnc}`,
  });
  links.push({ label: 'Wikispecies', url: `https://species.wikimedia.org/wiki/${sciEnc}` });
  links.push({ label: 'NCBI', url: `https://www.ncbi.nlm.nih.gov/taxonomy/?term=${sciEnc}` });
  if (result.kingdom === 'Plantae') {
    links.push({ label: 'POWO', url: `https://powo.science.kew.org/results?q=${sciEnc}` });
    links.push({ label: 'IPNI', url: `https://www.ipni.org/?q=${sciEnc}` });
    // 台灣植物資訊整合查詢 covers Taiwanese plants — meaningless for a
    // pack/external/YList taxon that is not in TaiCOL.
    if (result.taxon_id.charAt(0) === 't') {
      links.push({
        label: i18n.t('species.taiLink'),
        url: `https://tai2.ntu.edu.tw/search/1/${sciEnc}`,
      });
    }
  }
  return links;
}

export function SpeciesDetailPanel({
  result: resultProp,
  onAddToSession,
  onClose,
  addButtonLabel,
  onAddLongPress,
  onPickSubordinate,
  onEditManualTaxon,
}: Props) {
  // Local copy so the manual-edit flow can refresh the displayed taxon
  // in place — the prop only changes when the parent re-opens the panel.
  const c = useThemeColors();
  const [result, setResult] = useState(resultProp);
  useEffect(() => setResult(resultProp), [resultProp]);
  const { t } = useTranslation();
  const [synonyms, setSynonyms] = useState<Synonym[]>([]);
  const [infraspecies, setInfraspecies] = useState<TaxonSpecies[]>([]);
  const scrollRef = useRef<ScrollView>(null);
  const favorited = useFavorites((s) => s.ids.has(result.taxon_id));
  const addFav = useFavorites((s) => s.add);
  const removeFav = useFavorites((s) => s.remove);

  useEffect(() => {
    if (result.taxon_id) setSynonyms(getSynonyms(result.taxon_id));
    else setSynonyms([]);
  }, [result.taxon_id]);

  // Look up infraspecies only when this is a binomial Species (rank='Species'
  // or unknown rank but two-token name). Subspecies/Variety/Form pages don't
  // have children, so skip the SQL.
  useEffect(() => {
    const isSpecies =
      result.rank === 'Species' ||
      (!result.rank && result.name && result.name.split(/\s+/).length === 2);
    if (!isSpecies) {
      setInfraspecies([]);
      return;
    }
    const ancestors: Ancestors = {};
    if (result.kingdom) ancestors.kingdom = result.kingdom;
    if (result.phylum) ancestors.phylum = result.phylum;
    if (result.class_name) ancestors.class = result.class_name;
    if (result.order) ancestors.order = result.order;
    if (result.family) ancestors.family = result.family;
    if (result.genus) ancestors.genus = result.genus;
    setInfraspecies(getInfraspeciesOf(result.name, ancestors));
  }, [
    result.name,
    result.rank,
    result.kingdom,
    result.phylum,
    result.class_name,
    result.order,
    result.family,
    result.genus,
  ]);

  // Scroll body back to top whenever the displayed taxon changes — important
  // when `onPickSubordinate` swaps the result in-place (the parent re-renders
  // this same panel with a new taxon, ScrollView would otherwise stay at the
  // old scroll position deep in the previous taxon's body).
  useEffect(() => {
    scrollRef.current?.scrollTo({ y: 0, animated: false });
  }, [result.taxon_id]);

  const links = externalLinks(result);

  return (
    <View className="flex-1">
      <View className="flex-row items-start border-b border-gray-100 px-4 py-3 dark:border-gray-800">
        <View className="flex-1">
          {result.cname ? (
            <Text selectable className="text-lg font-semibold text-gray-900 dark:text-gray-100">
              {result.cname}
            </Text>
          ) : null}
          <ScientificName
            name={result.name}
            rank={result.rank}
            author={result.fullname.replace(result.name, '').trim()}
            kingdom={result.kingdom}
            nomenclature={result.nomenclature_name}
            // Without a vernacular the scientific name IS the title.
            className={
              result.cname
                ? 'text-sm text-gray-700 dark:text-gray-300'
                : 'text-lg font-semibold text-gray-900 dark:text-gray-100'
            }
            selectable
          />
          {result.taxon_id.startsWith('gm') ? (
            <Pressable
              onPress={async () => {
                const ext = getExternalTaxon(result.taxon_id);
                if (!ext) return;
                if (onEditManualTaxon) {
                  onEditManualTaxon(ext);
                  return;
                }
                const out = await editManualTaxon(ext);
                if (out === 'deleted') {
                  // A cached result would keep offering the deleted taxon.
                  clearSearchResultCache();
                  onClose?.();
                  return;
                }
                if (out) setResult(out.result);
              }}
              hitSlop={6}
              className="mt-2 flex-row items-center self-start rounded-full bg-amber-50 px-3 py-1.5 active:bg-amber-100 dark:bg-amber-950/40 dark:active:bg-amber-900/60"
            >
              <Ionicons name="create-outline" size={14} color="#b45309" />
              <Text className="ml-1.5 text-xs font-medium text-amber-700 dark:text-amber-300">
                {t('manualTaxon.editSelf')}
              </Text>
            </Pressable>
          ) : null}
          {result.taxon_id ? (
            <Pressable
              onPress={() => (favorited ? removeFav(result.taxon_id) : addFav(result))}
              hitSlop={6}
              className="mt-2 flex-row items-center self-start rounded-full bg-amber-50 px-3 py-1.5 active:bg-amber-100 dark:bg-amber-950/40 dark:active:bg-amber-900/60"
            >
              <Ionicons name={favorited ? 'heart' : 'heart-outline'} size={14} color={c.acornDeep} />
              <Text className="ml-1.5 text-xs font-medium text-amber-700 dark:text-amber-300">
                {favorited ? t('species.inFavorites') : t('favorites.add')}
              </Text>
            </Pressable>
          ) : null}
        </View>
        <Pressable
          onPress={async () => {
            const actions = speciesCopyActions(result);
            const idx = await showActionSheet({
              title: result.cname || result.name,
              options: actions.map((a) => ({ label: a.label })),
            });
            if (idx >= 0 && idx < actions.length) {
              const a = actions[idx];
              await copyToClipboard(buildSpeciesCopyText(result, a.mode));
            }
          }}
          hitSlop={8}
          className="ml-2"
        >
          <Ionicons name="copy-outline" size={20} color={c.ink2} />
        </Pressable>
        {onClose ? (
          <Pressable onPress={onClose} hitSlop={8} className="ml-2">
            <Ionicons name="close" size={22} color={c.ink2} />
          </Pressable>
        ) : null}
      </View>

      {result.matched_as ? (
        <View className="border-b border-gray-100 bg-orange-50 px-4 py-2 dark:border-gray-800 dark:bg-orange-950/40">
          <Text selectable className="text-xs text-orange-900 dark:text-orange-200">
            {t('species.matchedSynonymPre')}
            <ScientificName
              name={result.matched_as.name}
              rank={result.rank}
              kingdom={result.kingdom}
              nomenclature={result.nomenclature_name}
            />
            {t('species.matchedSynonymPost', { status: result.matched_as.status })}
          </Text>
        </View>
      ) : null}

      <ScrollView ref={scrollRef} className="flex-1">
        <View className="px-4 py-3">
          <RankChipRow result={result} onClose={onClose} />
        </View>

        {result.alternative_name_c ? (
          <Section title={t('species.otherNames')}>
            <Text selectable className="text-sm text-gray-700 dark:text-gray-300">
              {splitAltNames(result.alternative_name_c).join('、')}
            </Text>
          </Section>
        ) : null}

        <Section title={t('species.status')}>
          <View className="flex-row flex-wrap gap-2">
            {result.endemic ? (
              <Tag color="emerald" label={endemicTagLabel(result.taxon_id)} />
            ) : null}
            {(() => {
              const ab = alienBadge(result.alien_type, result.kingdom);
              if (!ab) return null;
              const color = ab.kind === 'invasive' || ab.kind === 'naturalized' ? 'rose' : 'purple';
              return <Tag color={color} label={ab.longLabel} />;
            })()}
            {result.is_hybrid === 'true' ? (
              <Tag color="purple" label={t('species.hybrid')} />
            ) : null}
            {habitatLabels(result).map((label) => (
              <Tag key={label} color="blue" label={label} />
            ))}
          </View>
        </Section>

        {result.redlist || result.iucn_category || result.cites || result.protected ? (
          <Section title={t('species.conservation')}>
            <ConservationBadgeRow label={t('species.redlist')} value={result.redlist} />
            <ConservationBadgeRow label="IUCN" value={result.iucn_category} />
            <ConservationRow label="CITES" value={result.cites} />
            <ConservationRow label={t('species.protected')} value={result.protected} />
          </Section>
        ) : null}

        {result.alien_status_note ? (
          <Section title={t('species.sourceLit')}>
            <View>
              {parseAlienStatusNote(result.alien_status_note).map((entry, idx) => (
                <View
                  key={idx}
                  className={`flex-row py-1.5 ${idx > 0 ? 'border-t border-gray-100 dark:border-gray-800' : ''}`}
                >
                  <Text selectable className="w-20 text-xs text-gray-500 dark:text-gray-400">
                    {entry.type}
                  </Text>
                  <Text selectable className="flex-1 text-xs text-gray-700 dark:text-gray-300">
                    {entry.citation}
                  </Text>
                </View>
              ))}
            </View>
          </Section>
        ) : null}

        {(() => {
          const nonAccepted = synonyms.filter((s) => s.status !== 'accepted');
          if (nonAccepted.length === 0) return null;
          return (
            <CollapsibleSection
              title={t('species.synonyms')}
              count={nonAccepted.length}
              defaultOpen={false}
            >
              {nonAccepted.map((s, idx) => (
                <View key={idx} className="flex-row flex-wrap items-baseline">
                  <Text selectable className="text-sm text-gray-700 dark:text-gray-300">
                    {'• '}
                    <ScientificName
                      name={s.scientificName}
                      author={s.authorship}
                      kingdom={result.kingdom}
                      nomenclature={result.nomenclature_name}
                      selectable
                    />
                  </Text>
                  <SynonymStatusBadge status={s.status} />
                </View>
              ))}
            </CollapsibleSection>
          );
        })()}

        {infraspecies.length > 0 ? (
          <Section title={t('species.infraspecies', { count: infraspecies.length })}>
            <View>
              {infraspecies.map((sp) => {
                const rc = rankColor(sp.rank);
                const row = (
                  <View className="flex-row items-start py-2">
                    <Ionicons
                      name="leaf-outline"
                      size={14}
                      color={c.accent}
                      style={{ marginRight: 8, marginTop: 3 }}
                    />
                    <View className="flex-1">
                      <Text className="text-sm text-gray-700 dark:text-gray-300">
                        {sp.common_name_c ? (
                          <Text className="font-medium text-gray-900 dark:text-gray-100">
                            {sp.common_name_c}{' '}
                          </Text>
                        ) : null}
                        <ScientificName
                          name={sp.simple_name}
                          rank={sp.rank}
                          kingdom={sp.kingdom}
                          nomenclature={sp.nomenclature_name}
                        />
                        {sp.is_autonym ? (
                          <Text className="text-xs italic text-gray-500 dark:text-gray-400">
                            {' '}
                            s.str.
                          </Text>
                        ) : null}
                      </Text>
                      {sp.rank ? (
                        <View className={`mt-0.5 self-start rounded px-1.5 py-0.5 ${rc.bg}`}>
                          <Text className={`text-[10px] font-medium ${rc.text}`}>{sp.rank}</Text>
                        </View>
                      ) : null}
                    </View>
                  </View>
                );
                return onPickSubordinate ? (
                  <Pressable
                    key={sp.taxon_id || sp.simple_name}
                    onPress={() => onPickSubordinate(sp)}
                    className="active:bg-accent-50 dark:active:bg-accent-900/40"
                  >
                    {row}
                  </Pressable>
                ) : (
                  <View key={sp.taxon_id || sp.simple_name}>{row}</View>
                );
              })}
            </View>
          </Section>
        ) : null}

        <Section title={t('species.externalLinks')}>
          <View className="flex-row flex-wrap gap-2">
            {links.map((link) => (
              <Pressable
                key={link.label}
                onPress={() => Linking.openURL(link.url)}
                className="flex-row items-center rounded-full bg-accent-50 px-3 py-1.5 active:bg-accent-100 dark:bg-accent-950/40 dark:active:bg-accent-900/60"
              >
                <Text className="text-xs font-medium text-accent-700 dark:text-accent-300">
                  {link.label}
                </Text>
                <Ionicons name="open-outline" size={12} color={c.accent} />
              </Pressable>
            ))}
          </View>
        </Section>

        {result.nomenclature_name ? (
          <View className="px-4 pt-3">
            <Text className="text-xs text-gray-400 dark:text-gray-500">
              {t('species.nomenclature', { name: result.nomenclature_name })}
            </Text>
          </View>
        ) : null}

        {onAddToSession ? (
          <View className="px-4 pb-6 pt-4">
            <Button
              label={addButtonLabel ?? t('species.addToRecord')}
              icon="add"
              onPress={onAddToSession}
              onLongPress={onAddLongPress}
              delayLongPress={350}
              size="lg"
              fullWidth
            />
            {onAddLongPress ? (
              <Text className="mt-1.5 text-center text-[11px] text-gray-400 dark:text-gray-500">
                {t('addToRecord.longPressHint')}
              </Text>
            ) : null}
          </View>
        ) : (
          <View className="h-6" />
        )}
      </ScrollView>
    </View>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View className="border-b border-gray-100 px-4 py-3 dark:border-gray-800">
      <Text className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
        {title}
      </Text>
      {children}
    </View>
  );
}

function splitAltNames(s: string): string[] {
  return s
    .split(/[,、]/)
    .map((x) => x.trim())
    .filter(Boolean);
}

/**
 * The full lineage as a row of chips, each jumping to that rank in the tree.
 *
 * Delegates every chip to the shared `TaxonomyJumpChip` rather than repeating
 * its press handler and styling. The local copy this replaced had drifted in a
 * way nothing would surface: it never called `Keyboard.dismiss()` before
 * navigating, so jumping with the search keyboard open left the taxonomy tab's
 * KeyboardStickyView latched and its search box floating mid-screen (memory
 * `feedback-taxonomy-jump`).
 */
function RankChipRow({ result, onClose }: { result: SearchResult; onClose?: () => void }) {
  const lineage = {
    kingdom: result.kingdom,
    phylum: result.phylum,
    class: result.class_name,
    order: result.order,
    family: result.family,
    genus: result.genus,
  };
  const items: Array<{ rank: Rank; name: string; nameC: string }> = [];
  if (result.kingdom)
    items.push({ rank: 'kingdom', name: result.kingdom, nameC: result.kingdom_c });
  if (result.phylum) items.push({ rank: 'phylum', name: result.phylum, nameC: result.phylum_c });
  if (result.class_name)
    items.push({ rank: 'class', name: result.class_name, nameC: result.class_c });
  if (result.order) items.push({ rank: 'order', name: result.order, nameC: result.order_c });
  if (result.family)
    items.push({ rank: 'family', name: result.family, nameC: result.family_cname });
  if (result.genus) items.push({ rank: 'genus', name: result.genus, nameC: result.genus_c });

  if (items.length === 0) return null;

  return (
    <View className="mt-1 flex-row flex-wrap gap-1.5">
      {items.map(({ rank, name, nameC }) => (
        <TaxonomyJumpChip
          key={rank}
          rank={rank}
          lineage={lineage}
          name={name}
          nameC={nameC}
          beforeJump={onClose}
        />
      ))}
    </View>
  );
}

function habitatLabels(result: SearchResult): string[] {
  const out: string[] = [];
  if (result.is_terrestrial === 'true') out.push(i18n.t('species.terrestrial'));
  if (result.is_freshwater === 'true') out.push(i18n.t('species.freshwater'));
  if (result.is_brackish === 'true') out.push(i18n.t('species.brackish'));
  if (result.is_marine === 'true') out.push(i18n.t('species.marine'));
  if (result.is_fossil === 'true') out.push(i18n.t('species.fossil'));
  return out;
}

function parseAlienStatusNote(note: string): Array<{ type: string; citation: string }> {
  return note
    .split('|')
    .map((seg) => seg.trim())
    .filter(Boolean)
    .map((seg) => {
      const m = seg.match(/^([^:]+):\s*(.+)$/);
      if (m) return { type: m[1].trim(), citation: m[2].trim() };
      return { type: '', citation: seg };
    });
}

const TAG_STYLES: Record<'emerald' | 'blue' | 'purple' | 'rose', { bg: string; text: string }> = {
  emerald: {
    bg: 'bg-emerald-100 dark:bg-emerald-900/60',
    text: 'text-emerald-700 dark:text-emerald-300',
  },
  blue: {
    bg: 'bg-accent-100 dark:bg-accent-900/60',
    text: 'text-accent-700 dark:text-accent-300',
  },
  purple: {
    bg: 'bg-purple-100 dark:bg-purple-900/60',
    text: 'text-purple-700 dark:text-purple-300',
  },
  rose: {
    bg: 'bg-rose-100 dark:bg-rose-900/60',
    text: 'text-rose-700 dark:text-rose-300',
  },
};

function Tag({ color, label }: { color: 'emerald' | 'blue' | 'purple' | 'rose'; label: string }) {
  const s = TAG_STYLES[color];
  return (
    <View className={`rounded-full px-2.5 py-1 ${s.bg}`}>
      <Text className={`text-xs font-medium ${s.text}`}>{label}</Text>
    </View>
  );
}

/** A conservation line with no data renders nothing — "CITES：–" rows only
 *  added noise (pack/external taxa carry almost none of these fields). */
function ConservationRow({ label, value }: { label: string; value: string }) {
  if (!value) return null;
  return (
    <Text selectable className="text-sm text-gray-700 dark:text-gray-300">
      {label}：<Text className="font-medium">{value}</Text>
    </Text>
  );
}

function ConservationBadgeRow({ label, value }: { label: string; value: string }) {
  if (!value) return null;
  return (
    <View className="flex-row items-center">
      <Text selectable className="text-sm text-gray-700 dark:text-gray-300">
        {label}：
      </Text>
      <ConservationBadge code={value} />
    </View>
  );
}
