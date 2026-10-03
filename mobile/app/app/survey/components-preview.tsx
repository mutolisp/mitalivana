/**
 * Development only: every survey component's input on one page (Phase 2B,
 * before the checklist and plot-style screens of 2C exist). The values are
 * written through surveyCore.writeComponent into a scratch database built
 * with the real migrations, then read back and shown, so the round trip runs
 * on op-sqlite itself. user.db is not touched; the scratch file is deleted on
 * leaving the page.
 */
import { open, type DB } from '@op-engineering/op-sqlite';
import { File, Paths } from 'expo-file-system';
import { Stack } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ScrollView, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { BackHeaderLeft } from '~/lib/goBack';
import { NumAccessory } from '~/components/form/NumField';
import { runUserMigrations } from '~/db/migrations';
import { generateUuid } from '~/db/uuid';
import { errText } from '~/lib/errText';
import { componentProblems } from '~/survey/componentRules';
import type { Ctx } from '~/survey/db/stemmapCore';
import * as core from '~/survey/db/surveyCore';
import { ComponentEditor, componentLabel, componentSummary } from '~/survey/components/editors/ComponentEditor';
import { FormCard } from '~/survey/components/FormBits';
import { componentDef, type ComponentValues, type FieldValue } from '~/survey/registry';
import type { ComponentInstance, SurveyTemplate } from '~/survey/template/types';
import { withRequired } from '~/survey/template/validate';

const PREVIEW_DB = 'component-preview.db';

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

type Scratch = { db: DB; ctx: Ctx; owners: Record<string, core.ComponentOwner> };

async function openScratch(): Promise<Scratch> {
  const file = new File(Paths.document, PREVIEW_DB);
  if (file.exists) file.delete();
  const db = open({ name: PREVIEW_DB, location: Paths.document.uri });
  await runUserMigrations(db);
  db.executeSync('PRAGMA foreign_keys = ON;');
  const ctx: Ctx = { db, now: Date.now, uuid: generateUuid };
  const survey = core.createSurvey(ctx, { template: TEMPLATE });
  const subplot = core.addUnit(ctx, survey, { levelKey: 'subplot', code: 'A' });
  const quadrat = core.addUnit(ctx, survey, { levelKey: 'quadrat', code: 'A1', parentId: subplot });
  // A placeholder taxon: the species search is the record screens' (2C).
  const occurrence = core.addOccurrence(ctx, survey, { taxon_id: 'preview', unit_id: quadrat });
  return {
    db,
    ctx,
    owners: { survey: { kind: 'survey', id: survey }, subplot: { kind: 'unit', id: subplot }, quadrat: { kind: 'unit', id: quadrat }, occurrence: { kind: 'occurrence', id: occurrence } },
  };
}

const ownerOf = (s: Scratch, c: ComponentInstance) => (c.level === 'unit' ? s.owners[c.unit ?? ''] : s.owners[c.level]);

export default function ComponentsPreview() {
  const { t, i18n } = useTranslation();
  const [scratch, setScratch] = useState<Scratch | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [values, setValues] = useState<Record<string, ComponentValues>>({});
  const [refused, setRefused] = useState<Record<string, string>>({});

  useEffect(() => {
    let s: Scratch | null = null;
    openScratch()
      .then((x) => {
        s = x;
        setScratch(x);
        setValues(Object.fromEntries(TEMPLATE.components.filter((c) => ownerOf(x, c)).map((c) => [c.key, core.readComponent(x.ctx, ownerOf(x, c), c.key)])));
      })
      .catch((e) => setFailure(errText(e)));
    return () => {
      s?.db.close();
      const file = new File(Paths.document, PREVIEW_DB);
      if (file.exists) file.delete();
    };
  }, []);

  const shown = useMemo(() => (scratch ? TEMPLATE.components.filter((c) => ownerOf(scratch, c)) : []), [scratch]);

  const reread = (c: ComponentInstance) => {
    if (!scratch) return;
    setValues((v) => ({ ...v, [c.key]: core.readComponent(scratch.ctx, ownerOf(scratch, c), c.key) }));
  };
  const write = (c: ComponentInstance, patch: Record<string, FieldValue>) => {
    if (!scratch) return;
    try {
      core.writeComponent(scratch.ctx, ownerOf(scratch, c), c.key, patch);
      setRefused((r) => ({ ...r, [c.key]: '' }));
    } catch (e) {
      // What the store refuses is shown as is: the forms are expected to stop it first.
      setRefused((r) => ({ ...r, [c.key]: errText(e) }));
    }
    reread(c);
  };

  return (
    <SafeAreaView edges={['bottom']} className="flex-1 bg-paper dark:bg-paper-dark">
      <Stack.Screen options={{ title: '元件預覽（開發版）', headerLeft: BackHeaderLeft }} />
      <ScrollView contentContainerClassName="gap-3 p-4" keyboardShouldPersistTaps="handled">
        <Text className="text-xs leading-5 text-ink-2 dark:text-gray-400">
          每個元件寫進暫存資料庫（實際 migration），再讀回顯示；離開頁面即刪除。不動使用者資料。
        </Text>
        {failure ? <Text className="text-sm text-alert dark:text-alert-dark">{failure}</Text> : null}
        {scratch
          ? shown.map((c) => {
              const def = componentDef(c.type);
              const v = values[c.key] ?? {};
              const problems = def ? componentProblems(def, c.params, c.level, c.key, v) : [];
              const owner = ownerOf(scratch, c);
              const summary = componentSummary(t, i18n.language, c, v);
              return (
                <FormCard key={c.key} title={`${componentLabel(t, i18n.language, c)} · ${c.level}${c.unit ? `:${c.unit}` : ''}`}>
                  <ComponentEditor
                    instance={c}
                    values={v}
                    problems={problems}
                    onChange={(patch) => write(c, patch)}
                    context={{
                      kingdom: 'Plantae',
                      layerCount: 4,
                      onAddMedia: (uri) => {
                        try {
                          core.addMedia(scratch.ctx, owner, c.key, uri);
                        } catch (e) {
                          setRefused((r) => ({ ...r, [c.key]: errText(e) }));
                        }
                        reread(c);
                      },
                      onRemoveMedia: (uri) => {
                        core.removeMedia(scratch.ctx, owner, c.key, uri);
                        reread(c);
                      },
                    }}
                  />
                  {refused[c.key] ? <Text className="text-xs text-alert dark:text-alert-dark">{refused[c.key]}</Text> : null}
                  <View className="gap-0.5 border-t border-line pt-1.5 dark:border-line-dark">
                    <Text className="text-[11px] text-ink-3 dark:text-gray-400">摘要：{summary || '—'}</Text>
                    <Text className="text-[11px] text-ink-3 dark:text-gray-400">
                      讀回：{JSON.stringify(v)}
                    </Text>
                  </View>
                </FormCard>
              );
            })
          : null}
      </ScrollView>
      <NumAccessory />
    </SafeAreaView>
  );
}
