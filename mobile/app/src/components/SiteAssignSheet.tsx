/**
 * Assign a 地理樣區 to a record: the existing ones first, drawing a new one
 * after (a user with imported polygons took the draw buttons on top for the
 * only way, 2026-10-07). 多選 merges several of one kind — points, lines or
 * areas — into a new site and assigns that; the originals stay (siteMerge.ts).
 * `boundary`: a plot's 樣區範圍 — only areas are offered, and drawing is one
 * polygon button (asked 2026-10-07).
 */
import { Ionicons } from '@expo/vector-icons';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, Modal, Pressable, ScrollView, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { createSite, listSites, parseGeometry, type SiteWithProject } from '~/db';
import { errText } from '~/lib/errText';
import { dimensionOf, mergeGeometries } from '~/lib/siteMerge';

import { SITE_TYPE_ICON, SITE_TYPE_LABEL, type DrawType } from '~/lib/siteLabels';
import { useThemeColors } from '~/theme/colors';
import { Button } from '~/components/ui/Button';
import { SelectMark } from '~/components/ui/SelectMark';
import { ActionSheetLayer, sheetBack } from '~/components/ActionSheet';

export type { DrawType } from '~/lib/siteLabels';

type Props = {
  visible: boolean;
  currentSiteId: number | null;
  /** When set, sites in this project are listed first. */
  preferredProjectId?: number;
  onCancel: () => void;
  /** Pass null to detach the current site. */
  onAssign: (siteId: number | null) => void;
  /** Open map drawing mode with chosen geometry type; caller auto-assigns on
   *  save. Omit to hide the "new site" row — a collection trip can bind an
   *  EXISTING site, but drawing one needs a map scope the trip does not have
   *  yet (the map's draw mode is scoped by `?session=`). */
  onCreateNew?: (drawType: DrawType) => void;
  /** Picking a plot's or plot-style survey's boundary rather than a place. */
  boundary?: boolean;
};

export function SiteAssignSheet({
  visible,
  currentSiteId,
  preferredProjectId,
  onCancel,
  onAssign,
  onCreateNew,
  boundary = false,
}: Props) {
  const c = useThemeColors();
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const [sites, setSites] = useState<SiteWithProject[]>([]);
  /** 多選: rows toggle instead of assigning; null when picking one. */
  const [picked, setPicked] = useState<number[] | null>(null);

  useEffect(() => {
    if (visible) {
      setSites(boundary ? listSites().filter((x) => dimensionOf(x.geometry_type) === 'area') : listSites());
      setPicked(null);
    }
  }, [visible, boundary]);

  const pickedSites = picked ? sites.filter((x) => picked.includes(x.id)) : [];
  // Only one kind merges: once a site is picked, the other kinds are greyed out.
  const pickedDim = pickedSites.length ? dimensionOf(pickedSites[0].geometry_type) : null;

  const assignMerged = () => {
    try {
      // Name order (S1, S2 … S10), not the order they were tapped in.
      const ordered = sites
        .filter((x) => picked?.includes(x.id))
        .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
      const geometry = mergeGeometries(ordered.map((x) => parseGeometry(x)));
      if (!geometry) return;
      const id = createSite({
        project_id: preferredProjectId ?? ordered[0].project_id,
        name: ordered.map((x) => x.name).join(t('builder.listSep')),
        geometry,
      });
      onAssign(id);
    } catch (e) {
      Alert.alert(t('sheets.assignSite'), errText(e));
    }
  };

  // Sort: current project first, then by updated_at desc (already from listSites)
  const sortedSites = [...sites].sort((a, b) => {
    if (preferredProjectId !== undefined) {
      if (a.project_id === preferredProjectId && b.project_id !== preferredProjectId) return -1;
      if (a.project_id !== preferredProjectId && b.project_id === preferredProjectId) return 1;
    }
    return b.updated_at - a.updated_at;
  });

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={sheetBack(onCancel)}>
      <View className="flex-1">
        <Pressable
          onPress={onCancel}
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            backgroundColor: 'rgba(0,0,0,0.4)',
          }}
        />
        <View
          style={{
            position: 'absolute',
            bottom: 0,
            left: 0,
            right: 0,
            paddingBottom: insets.bottom + 8,
          }}
          className="rounded-t-2xl bg-card dark:bg-gray-900"
        >
          <View className="flex-row items-center border-b border-gray-200 px-4 py-3 dark:border-gray-700">
            <View className="flex-1">
              <Text className="text-base font-semibold text-gray-900 dark:text-gray-100">
                {boundary ? t('plot.rangeTitle') : t('sheets.assignSite')}
              </Text>
              <Text className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
                {t(picked ? (boundary ? 'sheets.boundaryMergeHint' : 'sheets.mergeHint') : boundary ? 'sheets.boundaryDesc' : 'sheets.assignSiteDesc')}
              </Text>
            </View>
            {sites.length >= 2 ? (
              <Pressable
                onPress={() => setPicked(picked ? null : [])}
                accessibilityRole="button"
                hitSlop={8}
                className="ml-3 rounded-full px-3 py-1.5 active:bg-gray-100 dark:active:bg-gray-800"
              >
                <Text className="text-sm font-semibold text-accent-700 dark:text-accent-300">
                  {picked ? t('common.cancel') : t('sheets.multiPick')}
                </Text>
              </Pressable>
            ) : null}
          </View>

          <ScrollView className="max-h-96">
            {sortedSites.length === 0 ? (
              <View className="px-4 py-6">
                <Text className="text-center text-sm text-gray-500 dark:text-gray-400">
                  {boundary ? t('sheets.emptyAreas') : t('sheets.emptySites')}
                </Text>
              </View>
            ) : (
              sortedSites.map((s) => {
                const active = picked ? picked.includes(s.id) : s.id === currentSiteId;
                const blocked = !!picked && !active && pickedDim !== null && dimensionOf(s.geometry_type) !== pickedDim;
                return (
                  <Pressable
                    key={s.id}
                    disabled={blocked}
                    onPress={() =>
                      picked
                        ? setPicked(active ? picked.filter((id) => id !== s.id) : [...picked, s.id])
                        : onAssign(s.id)
                    }
                    accessibilityState={picked ? { checked: active, disabled: blocked } : undefined}
                    className={`flex-row items-center border-b border-gray-100 px-4 py-3 dark:border-gray-800 ${blocked ? 'opacity-40' : ''} ${active ? 'bg-accent-50 dark:bg-accent-950/40' : 'active:bg-gray-50 dark:active:bg-gray-800'}`}
                  >
                    {picked ? (
                      <View style={{ marginRight: 12 }}>
                        <SelectMark state={active ? 'on' : 'off'} disabled={blocked} />
                      </View>
                    ) : (
                      <Ionicons
                        name={SITE_TYPE_ICON[s.geometry_type]}
                        size={20}
                        color={active ? c.accent : c.ink2}
                        style={{ marginRight: 12 }}
                      />
                    )}
                    <View className="flex-1">
                      <Text
                        className={`text-base ${active ? 'font-semibold text-accent-700 dark:text-accent-300' : 'text-gray-900 dark:text-gray-100'}`}
                        numberOfLines={1}
                      >
                        {s.name}
                      </Text>
                      <Text className="text-xs text-gray-500 dark:text-gray-400" numberOfLines={1}>
                        {t(SITE_TYPE_LABEL[s.geometry_type])} · {s.project_name}
                      </Text>
                    </View>
                    {active && !picked ? <Ionicons name="checkmark" size={20} color={c.accent} /> : null}
                  </Pressable>
                );
              })
            )}
          </ScrollView>

          {picked ? (
            <View className="px-4 pt-3">
              <Button
                label={picked.length < 2 ? t('sheets.pickTwo') : t('sheets.assignMerged', { count: picked.length })}
                icon="git-merge-outline"
                disabled={picked.length < 2}
                onPress={assignMerged}
              />
            </View>
          ) : (
            <>
              {currentSiteId !== null ? (
                <Pressable
                  onPress={() => onAssign(null)}
                  className="flex-row items-center border-b border-gray-100 bg-gray-50 px-4 py-3 active:bg-gray-100 dark:border-gray-800 dark:bg-gray-950 dark:active:bg-gray-700"
                >
                  <Ionicons
                    name="close-circle-outline"
                    size={20}
                    color={c.ink2}
                    style={{ marginRight: 12 }}
                  />
                  <Text className="flex-1 text-base text-gray-700 dark:text-gray-300">
                    {boundary ? t('plot.removeRange') : t('sheets.removeAssign')}
                  </Text>
                </Pressable>
              ) : null}
              {onCreateNew && boundary ? (
                <View className="px-4 pt-3">
                  <Button
                    label={currentSiteId !== null ? t('plot.editRange') : t('plot.drawRange')}
                    icon="shapes-outline"
                    onPress={() => onCreateNew('Polygon')}
                  />
                </View>
              ) : onCreateNew ? (
              <View className="bg-accent-50 dark:bg-accent-950/40">
                <View className="px-4 pb-2 pt-3">
                  <Text className="text-xs font-medium uppercase tracking-wide text-accent-700 dark:text-accent-300">
                    {t('sheets.newSite')}
                  </Text>
                </View>
                <View className="flex-row gap-2 px-4 pb-3">
                  <NewSiteButton
                    icon="pin-outline"
                    label={t('sheets.btnPoint')}
                    onPress={() => onCreateNew('Point')}
                  />
                  <NewSiteButton
                    icon="analytics-outline"
                    label={t('sheets.btnLine')}
                    onPress={() => onCreateNew('LineString')}
                  />
                  <NewSiteButton
                    icon="shapes-outline"
                    label={t('sheets.btnPolygon')}
                    onPress={() => onCreateNew('Polygon')}
                  />
                </View>
              </View>
              ) : null}
            </>
          )}
        </View>
      </View>
      <ActionSheetLayer visible={visible} />
    </Modal>
  );
}

function NewSiteButton({
  icon,
  label,
  onPress,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  onPress: () => void;
}) {
  return (
    <Button label={label} icon={icon} onPress={onPress} className="flex-1" />
  );
}
