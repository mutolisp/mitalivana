/**
 * A template's forms, filled in for real but on a scratch database (the
 * development component preview of 2B; the builder's 預覽 until 2G-e, which
 * opens the real survey screen instead, previewSurvey.ts). The
 * scratch file is built with the real migrations, gets one survey of the
 * template — on a plot, one unit per level (A, A1, A1a) — and one occurrence
 * in the lowest unit; every input writes through surveyCore and reads back,
 * so a preview behaves as the survey will. user.db is not touched; the file
 * is deleted when the preview closes.
 */
import { open, type DB } from '@op-engineering/op-sqlite';
import { File, Paths } from 'expo-file-system';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Text, View } from 'react-native';
import { runUserMigrations } from '~/db/migrations';
import { generateUuid } from '~/db/uuid';
import { errText } from '~/lib/errText';
import { instanceProblems } from '~/survey/componentRules';
import type { Ctx } from '~/survey/db/stemmapCore';
import * as core from '~/survey/db/surveyCore';
import { ComponentEditor, componentLabel, componentSummary } from '~/survey/components/editors/ComponentEditor';
import { FormCard } from '~/survey/components/FormBits';
import { isRequiredMissing, RequiredMissingLine } from '~/survey/components/editors/shared';
import type { ComponentValues, FieldValue } from '~/survey/registry';
import { componentsAt, placesOf, type Place } from '~/survey/template/edit';
import type { ComponentInstance, SurveyTemplate } from '~/survey/template/types';
import { placeTitle } from './words';

const PREVIEW_DB = 'template-preview.db';

type Scratch = { db: DB; ctx: Ctx; survey: core.ComponentOwner; units: Record<string, core.ComponentOwner>; occurrence: core.ComponentOwner };

async function openScratch(template: SurveyTemplate): Promise<Scratch> {
  const file = new File(Paths.document, PREVIEW_DB);
  if (file.exists) file.delete();
  const db = open({ name: PREVIEW_DB, location: Paths.document.uri });
  await runUserMigrations(db);
  db.executeSync('PRAGMA foreign_keys = ON;');
  const ctx: Ctx = { db, now: Date.now, uuid: generateUuid };
  // add-guard: a scratch database, not user.db; nothing there is active.
  const survey = core.createSurvey(ctx, { template, name: 'preview' });
  const units: Record<string, core.ComponentOwner> = {};
  let parent: number | undefined;
  const codes = ['A', 'A1', 'A1a'];
  (template.style === 'plot' ? (template.units ?? []) : []).forEach((u, i) => {
    parent = core.addUnit(ctx, survey, { levelKey: u.key, code: codes[i] ?? `L${i}`, ...(parent != null ? { parentId: parent } : {}) });
    units[u.key] = { kind: 'unit', id: parent };
  });
  // A placeholder taxon: species are searched on the survey screens.
  const occurrence = core.addOccurrence(ctx, survey, { taxon_id: 'preview', unit_id: parent ?? null });
  return { db, ctx, survey: { kind: 'survey', id: survey }, units, occurrence: { kind: 'occurrence', id: occurrence } };
}

const ownerOf = (s: Scratch, c: ComponentInstance): core.ComponentOwner | null =>
  c.level === 'survey' ? s.survey : c.level === 'occurrence' ? s.occurrence : c.level === 'unit' ? (s.units[c.unit ?? ''] ?? null) : null;

const placeKey = (p: Place) => (p.level === 'unit' ? `unit:${p.unit}` : p.level);

/** `raw`: also show each component's summary and what was read back (the development page). */
export function TemplatePreview({ template, raw = false }: { template: SurveyTemplate; raw?: boolean }) {
  const { t, i18n } = useTranslation();
  const [scratch, setScratch] = useState<Scratch | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [values, setValues] = useState<Record<string, ComponentValues>>({});
  const [refused, setRefused] = useState<Record<string, string>>({});

  useEffect(() => {
    let s: Scratch | null = null;
    openScratch(template)
      .then((x) => {
        s = x;
        setScratch(x);
        const shown = template.components.filter((c) => ownerOf(x, c));
        setValues(Object.fromEntries(shown.map((c) => [c.key, core.readComponent(x.ctx, ownerOf(x, c)!, c.key)])));
      })
      .catch((e) => setFailure(errText(e)));
    return () => {
      s?.db.close();
      const file = new File(Paths.document, PREVIEW_DB);
      if (file.exists) file.delete();
    };
  }, [template]);

  const places = useMemo(() => placesOf(template), [template]);

  const reread = (c: ComponentInstance) => {
    const owner = scratch ? ownerOf(scratch, c) : null;
    if (!scratch || !owner) return;
    setValues((v) => ({ ...v, [c.key]: core.readComponent(scratch.ctx, owner, c.key) }));
  };
  const write = (c: ComponentInstance, patch: Record<string, FieldValue>) => {
    const owner = scratch ? ownerOf(scratch, c) : null;
    if (!scratch || !owner) return;
    try {
      core.writeComponent(scratch.ctx, owner, c.key, patch);
      setRefused((r) => ({ ...r, [c.key]: '' }));
    } catch (e) {
      // What the store refuses is shown as is: the forms are expected to stop it first.
      setRefused((r) => ({ ...r, [c.key]: errText(e) }));
    }
    reread(c);
  };

  if (failure) return <Text className="text-sm text-alert dark:text-alert-dark">{failure}</Text>;
  if (!scratch) return null;
  return (
    <View className="gap-3">
      {places.map((place) => {
        const here = componentsAt(template, place).filter((c) => ownerOf(scratch, c));
        if (!here.length) return null;
        return (
          <View key={placeKey(place)} className="gap-2">
            <Text className="pt-1 text-xs font-bold text-ink-2 dark:text-gray-400">{placeTitle(t, i18n.language, template, place)}</Text>
            {here.map((c) => {
              const v = values[c.key] ?? {};
              const problems = instanceProblems(c, v);
              const owner = ownerOf(scratch, c)!;
              return (
                <FormCard key={c.key} title={componentLabel(t, i18n.language, c)}>
                  <RequiredMissingLine problems={problems} />
                  <ComponentEditor
                    instance={c}
                    values={v}
                    problems={problems.filter((p) => !isRequiredMissing(p))}
                    onChange={(patch) => write(c, patch)}
                    context={{
                      noAutoFocus: true,
                      codelists: template.codelists,
                      kingdom: 'Plantae',
                      layerCount: typeof c.params.layers === 'number' ? c.params.layers : 4,
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
                  {raw ? (
                    <View className="gap-0.5 border-t border-line pt-1.5 dark:border-line-dark">
                      <Text className="text-[11px] text-ink-3 dark:text-gray-400">摘要：{componentSummary(t, i18n.language, c, v, template.codelists) || '—'}</Text>
                      <Text className="text-[11px] text-ink-3 dark:text-gray-400">讀回：{JSON.stringify(v)}</Text>
                    </View>
                  ) : null}
                </FormCard>
              );
            })}
          </View>
        );
      })}
    </View>
  );
}
