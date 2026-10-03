/**
 * Development only: every survey component's input on one page (Phase 2B),
 * through the builder's preview (src/survey/builder/TemplatePreview.tsx): the
 * values go into a scratch database built with the real migrations and are
 * read back, with each one's summary and raw values shown.
 */
import { Stack } from 'expo-router';
import { ScrollView, Text } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { BackHeaderLeft } from '~/lib/goBack';
import { NumAccessory } from '~/components/form/NumField';
import { TemplatePreview } from '~/survey/builder/TemplatePreview';
import type { SurveyTemplate } from '~/survey/template/types';
import { withRequired } from '~/survey/template/validate';

const TEMPLATE: SurveyTemplate = withRequired({
  schema: 1,
  id: 'preview:components',
  version: 1,
  origin: 'user',
  name: { text: '元件預覽' },
  style: 'plot',
  units: [
    { key: 'subplot', label: { text: '小區', tr: { en: 'Subplot' } } },
    { key: 'quadrat', label: { text: '小樣方', tr: { en: 'Quadrat' } } },
  ],
  components: [
    { key: 'layers', type: 'structure', level: 'survey', required: false, params: { layers: 4, methods: ['BB', 'percent', 'DBH'] } },
    { key: 'env', type: 'environment', level: 'survey', required: false, params: { fields: ['elevation_m', 'slope_deg', 'aspect_deg', 'terrain_position', 'vascular_cover_pct', 'litter_cover_pct', 'rock_cover_pct'] } },
    { key: 'sublayers', type: 'structure', level: 'unit', unit: 'subplot', required: false, params: { layers: 4, methods: ['BB'] } },
    { key: 'subworkers', type: 'workers', level: 'unit', unit: 'subplot', required: false, params: { roles: ['recorder'] } },
    { key: 'qwhere', type: 'location', level: 'unit', unit: 'quadrat', required: false, params: { methods: ['gps'] } },
    { key: 'qphotos', type: 'photos', level: 'unit', unit: 'quadrat', required: false, params: { max: 6 } },
    { key: 'abundance', type: 'abundance', level: 'occurrence', required: false, params: { kinds: ['BB', 'percent', 'count', 'DBH', 'custom'], default: 'BB' } },
    { key: 'freq', type: 'frequency', level: 'occurrence', required: false, params: { mode: 'cells', n: 5, top_edge: 'upslope' } },
    { key: 'layer', type: 'structure', level: 'occurrence', required: false, params: { layers: 4, methods: ['BB'] } },
    { key: 'pheno', type: 'phenology', level: 'occurrence', required: false, params: { fields: ['sex', 'life_stage', 'reproductive_condition', 'leaf_phenology', 'degree_of_establishment'] } },
    { key: 'leaf', type: 'traits', level: 'occurrence', required: false, params: { traits: [{ id: 'length_cm', label: { text: '葉長', tr: { en: 'Leaf length' } }, unit: 'cm', min: 0, max: 50 }, { id: 'leaves', label: { text: '葉數', tr: { en: 'Leaves' } }, integer: true, min: 0 }] } },
    { key: 'workers', type: 'workers', level: 'occurrence', required: false, params: { roles: ['recorder', 'identifier'] } },
    { key: 'where', type: 'location', level: 'occurrence', required: false, params: { methods: ['gps'] } },
    { key: 'height', type: 'height', level: 'occurrence', required: false, params: {} },
    { key: 'photos', type: 'photos', level: 'occurrence', required: false, params: { max: 6 } },
    { key: 'audio', type: 'audio', level: 'occurrence', required: false, params: { max: 3 } },
  ],
  codelists: [],
  quick_add: false,
});

export default function ComponentsPreview() {
  return (
    <SafeAreaView edges={['bottom']} className="flex-1 bg-paper dark:bg-paper-dark">
      <Stack.Screen options={{ title: '元件預覽（開發版）', headerLeft: BackHeaderLeft }} />
      <ScrollView contentContainerClassName="gap-3 p-4" keyboardShouldPersistTaps="handled">
        <Text className="text-xs leading-5 text-ink-2 dark:text-gray-400">
          每個元件寫進暫存資料庫（實際 migration），再讀回顯示；離開頁面即刪除。不動使用者資料。
        </Text>
        <TemplatePreview template={TEMPLATE} raw />
      </ScrollView>
      <NumAccessory />
    </SafeAreaView>
  );
}
