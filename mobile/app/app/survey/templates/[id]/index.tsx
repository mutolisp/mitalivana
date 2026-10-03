/**
 * The builder (Phase 2D-a; canvas 12a–12c): one template's draft. Its name
 * (plus an optional English name), quick add, the unit levels of a plot, and
 * the components on each place — the survey, each unit level, each
 * occurrence. A component opens its own page (component/[key].tsx).
 *
 * Every change is stored in the draft at once (survey_template_drafts).
 * 儲存 makes it the template's next version; when the change only adds or
 * widens, open surveys on the older version are offered the new one.
 *
 * A tree census template (2D-b, a copy of the built-in) has no quick add and
 * no preview (the census screens are not template forms); its places are the
 * census, each quadrat, tree and stem.
 */
import { Ionicons } from '@expo/vector-icons';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { Alert, Pressable, ScrollView, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { showActionSheet } from '~/components/ActionSheet';
import { LabeledField } from '~/components/form/LabeledField';
import { HeaderIconButton } from '~/components/HeaderIconButton';
import { Button } from '~/components/ui/Button';
import { Switch } from '~/components/ui/Switch';
import { BackHeaderLeft } from '~/lib/goBack';
import { useToast } from '~/stores/toast';
import { useThemeColors } from '~/theme/colors';
import { componentHref, listHref, previewHref, useTemplateDraft } from '~/survey/builder/drafts';
import { issueText, paramsSummary, placeTitle, styleName, typeName } from '~/survey/builder/words';
import { labelText } from '~/survey/components/editors/shared';
import { FormCard } from '~/survey/components/FormBits';
import { commitDraft, discardDraft, templateUseCounts, upgradableSurveys, upgradeSurveys } from '~/survey/db/surveys';
import type { ComponentType } from '~/survey/registry';
import {
  addChoice,
  addCodeList,
  addComponent,
  addableTypes,
  codeListUsers,
  addUnitLevel,
  componentsAt,
  draftIssues,
  isFixedComponent,
  labelParts,
  makeLabel,
  moveUnitLevel,
  placesOf,
  removeUnitLevel,
  updateUnitLevel,
  type Place,
} from '~/survey/template/edit';
import { MAX_UNIT_LEVELS, type SurveyTemplate } from '~/survey/template/types';
import { classifyChange, validateTemplate, withRequired } from '~/survey/template/validate';

export default function TemplateEditorScreen() {
  const { t, i18n } = useTranslation();
  const c = useThemeColors();
  const toast = useToast((s) => s.show);
  const id = String(useLocalSearchParams<{ id: string }>().id);
  const { draft, saved, update } = useTemplateDraft(id);

  if (!draft) {
    return (
      <SafeAreaView edges={['bottom']} className="flex-1 items-center justify-center bg-paper px-6 dark:bg-paper-dark">
        <Stack.Screen options={{ title: t('builder.title'), headerLeft: BackHeaderLeft }} />
        <Text className="text-center text-ink-3 dark:text-gray-400">{t('builder.notFound')}</Text>
      </SafeAreaView>
    );
  }
  const tpl = draft.template;
  const lang = i18n.language;
  const name = labelParts(tpl.name);
  const issues = draftIssues(tpl);
  const nextVersion = (saved?.version ?? 0) + 1;
  const census = tpl.style === 'individual';

  const setName = (text: string, en: string) => update((x) => ({ ...x, name: makeLabel(text, en) ?? { text: '' } }));

  const addTo = async (place: Place) => {
    const types = addableTypes(tpl, place);
    if (!types.length) {
      toast(t('builder.nothingToAdd'));
      return;
    }
    const idx = await showActionSheet({
      title: t('builder.addComponentTitle', { place: placeTitle(t, lang, tpl, place) }),
      options: types.map((type) => ({ label: typeName(t, type) })),
      cancelLabel: t('common.cancel'),
    });
    const type: ComponentType | undefined = types[idx];
    if (!type) return;
    // On the stored draft (update reads it), keeping the new key for the page it opens.
    let key: string | null = null;
    update((x) => {
      // A choice needs a code list: the first one, or a new one when there is none yet.
      const added = type === 'choice' ? addChoice(x, place, makeLabel(t('builder.list.newName', { n: x.codelists.length + 1 }))!) : addComponent(x, type, place);
      key = added.key;
      return added.template;
    });
    if (key) router.push(componentHref(id, key));
  };

  const removeLevel = (key: string) =>
    Alert.alert(t('builder.removeUnit'), t('builder.removeUnitMsg', { name: labelText(t, lang, tpl.units?.find((u) => u.key === key)?.label, key) }), [
      { text: t('common.cancel'), style: 'cancel' },
      { text: t('builder.removeUnit'), style: 'destructive', onPress: () => update((x) => removeUnitLevel(x, key)) },
    ]);

  const discard = () =>
    Alert.alert(saved ? t('builder.discard.title') : t('builder.discard.newTitle'), saved ? t('builder.discard.msg', { n: saved.version }) : t('builder.discard.newMsg'), [
      { text: t('common.cancel'), style: 'cancel' },
      {
        text: saved ? t('builder.discard.go') : t('builder.discard.newGo'),
        style: 'destructive',
        onPress: () => {
          discardDraft(id);
          router.back();
        },
      },
    ]);

  const more = async () => {
    const items = [
      ...(census ? [] : [{ label: t('builder.preview'), run: () => router.push(previewHref(id)) }]),
      { label: saved ? t('builder.discard.go') : t('builder.discard.newGo'), destructive: true, run: discard },
    ];
    const idx = await showActionSheet({ title: labelText(t, lang, tpl.name, t('builder.untitled')), options: items, cancelLabel: t('common.cancel') });
    items[idx]?.run();
  };

  /** After saving: open surveys on an older version that can take this one. */
  const offerUpgrade = (to: SurveyTemplate) => {
    const open = upgradableSurveys(to);
    if (!open.length) return;
    Alert.alert(t('builder.upgrade.title'), t('builder.upgrade.msg', { count: open.length, n: to.version }), [
      { text: t('builder.upgrade.skip'), style: 'cancel' },
      {
        text: t('builder.upgrade.go'),
        onPress: () => toast(t('builder.upgrade.done', { count: upgradeSurveys(open.map((s) => s.id), to) })),
      },
    ]);
  };

  const save = () => {
    if (issues.length) {
      Alert.alert(t('builder.save.fixFirst'), issues.map((x) => `• ${issueText(t, lang, tpl, x)}`).join('\n'));
      return;
    }
    const next = { ...withRequired(tpl), version: nextVersion };
    // The validator is the last word: anything the builder let through is said as it is.
    const problems = validateTemplate(next);
    if (problems.length) {
      Alert.alert(t('builder.save.fixFirst'), t('builder.save.invalid', { detail: problems.join('\n') }));
      return;
    }
    const kind = saved ? classifyChange(saved, next) : 'new';
    if (kind === 'same') {
      discardDraft(id);
      toast(t('builder.save.noChange'));
      router.back();
      return;
    }
    const used = templateUseCounts().get(id)?.all ?? 0;
    const msg = kind === 'new' ? t('builder.save.msgNew') : !used ? t('builder.save.msgNext') : kind === 'additive' ? t('builder.save.msgAdditive') : t('builder.save.msgBreaking');
    Alert.alert(t('builder.save.title', { n: nextVersion }), msg, [
      { text: t('common.cancel'), style: 'cancel' },
      {
        text: t('builder.save.go'),
        onPress: () => {
          const done = commitDraft(id);
          toast(t('builder.save.saved', { n: done.version }));
          router.back();
          if (kind === 'additive') offerUpgrade(done);
        },
      },
    ]);
  };

  return (
    <SafeAreaView edges={['bottom']} className="flex-1 bg-paper dark:bg-paper-dark">
      <Stack.Screen
        options={{
          title: labelText(t, lang, tpl.name, t('builder.untitled')),
          headerLeft: BackHeaderLeft,
          headerRight: () => <HeaderIconButton icon="ellipsis-horizontal" label={t('common.more')} onPress={() => void more()} />,
        }}
      />
      <ScrollView contentContainerClassName="gap-3 p-4 pb-10" keyboardShouldPersistTaps="handled">
        <FormCard title={t('builder.basics')}>
          <LabeledField label={t('builder.name')} value={name.text} required onSave={(v) => setName(v, name.en)} />
          <LabeledField label={t('builder.nameEn')} value={name.en} onSave={(v) => setName(name.text, v)} />
          <Text className="text-sm text-ink-2 dark:text-gray-300">
            {[styleName(t, tpl.style), saved ? t('builder.versionNext', { n: saved.version, next: nextVersion }) : t('builder.newTemplate')].join(' · ')}
          </Text>
          {!census ? (
            <View className="flex-row items-center gap-3">
              <View className="flex-1">
                <Text className="text-sm font-semibold text-ink dark:text-gray-100">{t('builder.quickAdd')}</Text>
                <Text className="mt-0.5 text-xs leading-4 text-ink-3 dark:text-gray-400">{t('builder.quickAddDesc')}</Text>
              </View>
              <Switch value={tpl.quick_add} onValueChange={(v) => update((x) => ({ ...x, quick_add: v }))} accessibilityLabel={t('builder.quickAdd')} />
            </View>
          ) : (
            <Text className="text-xs leading-4 text-ink-3 dark:text-gray-400">{t('builder.census.intro')}</Text>
          )}
        </FormCard>

        {tpl.style === 'plot' ? (
          <FormCard title={t('builder.units')}>
            <Text className="text-xs leading-4 text-ink-3 dark:text-gray-400">{t('builder.unitsDesc', { max: MAX_UNIT_LEVELS })}</Text>
            {(tpl.units ?? []).map((u, i, all) => {
              const parts = labelParts(u.label);
              return (
                <View key={u.key} className="gap-1 border-t border-line pt-2 dark:border-line-dark">
                  <Text className="text-xs font-bold text-ink-2 dark:text-gray-400">{t('builder.unitN', { n: i + 1 })}</Text>
                  <LabeledField label={t('builder.name')} value={parts.text} required onSave={(v) => update((x) => updateUnitLevel(x, u.key, makeLabel(v, parts.en) ?? { text: '' }))} />
                  <LabeledField label={t('builder.nameEn')} value={parts.en} onSave={(v) => update((x) => updateUnitLevel(x, u.key, makeLabel(parts.text, v) ?? { text: '' }))} />
                  <View className="flex-row gap-2">
                    {/* A saved level keeps its place: its key is its position, shared with the plot's layout. */}
                    {!saved ? (
                      <>
                        <Button label={t('builder.moveUp')} icon="arrow-up" variant="ghost" disabled={i === 0} onPress={() => update((x) => moveUnitLevel(x, u.key, -1))} />
                        <Button label={t('builder.moveDown')} icon="arrow-down" variant="ghost" disabled={i === all.length - 1} onPress={() => update((x) => moveUnitLevel(x, u.key, 1))} />
                      </>
                    ) : null}
                    {all.length > 1 ? <Button label={t('builder.removeUnit')} icon="trash-outline" variant="ghost" onPress={() => removeLevel(u.key)} /> : null}
                  </View>
                </View>
              );
            })}
            {(tpl.units ?? []).length < MAX_UNIT_LEVELS ? (
              <Button
                label={t('builder.addUnit')}
                icon="add"
                variant="secondary"
                onPress={() => update((x) => addUnitLevel(x, makeLabel(t('builder.unitN', { n: (x.units ?? []).length + 1 }))!))}
              />
            ) : null}
          </FormCard>
        ) : null}

        {placesOf(tpl).map((place) => {
          const here = componentsAt(tpl, place);
          return (
            <FormCard key={place.level === 'unit' ? `unit:${place.unit}` : place.level} title={placeTitle(t, lang, tpl, place)}>
              {here.map((comp) => {
                const fixed = isFixedComponent(tpl, comp);
                const summary = paramsSummary(t, lang, comp, tpl);
                return (
                  <Pressable
                    key={comp.key}
                    onPress={() => router.push(componentHref(id, comp.key))}
                    accessibilityRole="button"
                    className="flex-row items-center gap-2 border-t border-line pt-2 active:opacity-70 dark:border-line-dark"
                  >
                    <View className="flex-1">
                      <Text className="text-sm font-semibold text-ink dark:text-gray-100">{labelText(t, lang, comp.label, typeName(t, comp.type))}</Text>
                      <Text className="text-xs text-ink-3 dark:text-gray-400" numberOfLines={2}>
                        {[comp.label ? typeName(t, comp.type) : null, summary || null, fixed ? t('builder.fixed') : comp.required ? t('builder.requiredTag') : null].filter(Boolean).join(' · ')}
                      </Text>
                    </View>
                    {fixed ? <Ionicons name="lock-closed-outline" size={14} color={c.ink3} /> : null}
                    <Ionicons name="chevron-forward" size={18} color={c.ink3} />
                  </Pressable>
                );
              })}
              {/* A census offers only what its screens ask, on the tree. */}
              {!census || addableTypes(tpl, place).length ? <Button label={t('builder.addComponent')} icon="add" variant="secondary" onPress={() => void addTo(place)} /> : null}
            </FormCard>
          );
        })}

        <FormCard title={t('builder.lists')}>
          <Text className="text-xs leading-4 text-ink-3 dark:text-gray-400">{census ? t('builder.census.listsDesc') : t('builder.listsDesc')}</Text>
          {tpl.codelists.map((l) => {
            const users = codeListUsers(tpl, l.id);
            return (
              <Pressable
                key={l.id}
                onPress={() => router.push(listHref(id, l.id))}
                accessibilityRole="button"
                className="flex-row items-center gap-2 border-t border-line pt-2 active:opacity-70 dark:border-line-dark"
              >
                <View className="flex-1">
                  <Text className="text-sm font-semibold text-ink dark:text-gray-100">{labelText(t, lang, l.label, t('builder.untitled'))}</Text>
                  <Text className="text-xs text-ink-3 dark:text-gray-400" numberOfLines={2}>
                    {[
                      t('builder.list.codes', { count: l.items.filter((x) => !x.deprecated).length }),
                      users.length ? t('builder.list.usedBy', { names: users.map((u) => labelText(t, lang, u.label, typeName(t, u.type))).join(t('builder.listSep')) }) : t('builder.list.unused'),
                    ].join(' · ')}
                  </Text>
                </View>
                <Ionicons name="chevron-forward" size={18} color={c.ink3} />
              </Pressable>
            );
          })}
          <Button
            label={t('builder.list.add')}
            icon="add"
            variant="secondary"
            onPress={() => {
              let made: string | null = null;
              update((x) => {
                const r = addCodeList(x, makeLabel(t('builder.list.newName', { n: x.codelists.length + 1 }))!);
                made = r.id;
                return r.template;
              });
              if (made) router.push(listHref(id, made));
            }}
          />
        </FormCard>

        {issues.length ? (
          <FormCard title={t('builder.save.fixFirst')}>
            {issues.map((x, i) => (
              <Text key={i} className="text-sm leading-5 text-alert dark:text-alert-dark">
                {`• ${issueText(t, lang, tpl, x)}`}
              </Text>
            ))}
          </FormCard>
        ) : null}
      </ScrollView>
      <View className="flex-row gap-3 border-t border-line bg-card px-4 py-3 dark:border-line-dark dark:bg-card-dark">
        {!census ? (
          <View className="flex-1">
            <Button label={t('builder.preview')} icon="eye-outline" variant="secondary" fullWidth onPress={() => router.push(previewHref(id))} />
          </View>
        ) : null}
        <View className="flex-1">
          <Button label={t('builder.save.go')} icon="checkmark" fullWidth onPress={save} />
        </View>
      </View>
    </SafeAreaView>
  );
}
