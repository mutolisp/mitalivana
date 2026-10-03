/**
 * One code list of a template (2D-b): its name, and its codes — each a short
 * code that is what gets recorded, a name, an English name, and 停用. A code
 * the saved version has keeps its value: it cannot be renamed, and removing
 * it only marks it 停用 (still shown where it was recorded). A list in use
 * cannot be deleted.
 *
 * A list of interaction types (2F) also gives each code its direction — one
 * way or both, fixed once saved like the code — how it reads from B (one way
 * only) and an optional relation IRI.
 */
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { Alert, ScrollView, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { LabeledField } from '~/components/form/LabeledField';
import { Seg } from '~/components/form/Segmented';
import { Button } from '~/components/ui/Button';
import { Switch } from '~/components/ui/Switch';
import { BackHeaderLeft } from '~/lib/goBack';
import { useTemplateDraft } from '~/survey/builder/drafts';
import { typeName } from '~/survey/builder/words';
import { labelText } from '~/survey/components/editors/shared';
import { FormCard } from '~/survey/components/FormBits';
import { INTERACTION_IRI } from '~/survey/codesets/interactions';
import { addCode, codeListUsers, isInteractionList, labelParts, makeLabel, removeCode, removeCodeList, updateCode, updateCodeList } from '~/survey/template/edit';

export default function TemplateCodeListScreen() {
  const { t, i18n } = useTranslation();
  const params = useLocalSearchParams<{ id: string; listId: string }>();
  const id = String(params.id);
  const listId = String(params.listId);
  const { draft, saved, update } = useTemplateDraft(id);
  const lang = i18n.language;
  const tpl = draft?.template;
  const list = tpl?.codelists.find((l) => l.id === listId);

  if (!tpl || !list) {
    return (
      <SafeAreaView edges={['bottom']} className="flex-1 items-center justify-center bg-paper px-6 dark:bg-paper-dark">
        <Stack.Screen options={{ title: '', headerLeft: BackHeaderLeft }} />
        <Text className="text-center text-ink-3 dark:text-gray-400">{t('builder.notFound')}</Text>
      </SafeAreaView>
    );
  }
  const name = labelParts(list.label);
  const users = codeListUsers(tpl, listId);
  const savedCodes = new Set(saved?.codelists.find((l) => l.id === listId)?.items.map((x) => x.code) ?? []);
  const interaction = isInteractionList(tpl, listId);

  const removeList = () =>
    Alert.alert(t('builder.list.remove'), t('builder.list.removeMsg', { name: labelText(t, lang, list.label, t('builder.untitled')) }), [
      { text: t('common.cancel'), style: 'cancel' },
      {
        text: t('builder.list.remove'),
        style: 'destructive',
        onPress: () => {
          update((x) => removeCodeList(x, listId));
          router.back();
        },
      },
    ]);

  return (
    <SafeAreaView edges={['bottom']} className="flex-1 bg-paper dark:bg-paper-dark">
      <Stack.Screen options={{ title: labelText(t, lang, list.label, t('builder.untitled')), headerLeft: BackHeaderLeft }} />
      <ScrollView contentContainerClassName="gap-3 p-4 pb-10" keyboardShouldPersistTaps="handled">
        <FormCard>
          <LabeledField label={t('builder.name')} value={name.text} required onSave={(v) => update((x) => updateCodeList(x, listId, makeLabel(v, name.en) ?? { text: '' }))} />
          <LabeledField label={t('builder.nameEn')} value={name.en} onSave={(v) => update((x) => updateCodeList(x, listId, makeLabel(name.text, v) ?? { text: '' }))} />
          <Text className="text-xs leading-4 text-ink-3 dark:text-gray-400">
            {users.length ? t('builder.list.usedBy', { names: users.map((u) => labelText(t, lang, u.label, typeName(t, u.type))).join(t('builder.listSep')) }) : t('builder.list.unused')}
          </Text>
        </FormCard>

        <FormCard title={t('builder.list.codesTitle')}>
          <Text className="text-xs leading-4 text-ink-3 dark:text-gray-400">{t('builder.list.codesDesc')}</Text>
          {interaction ? <Text className="text-xs leading-4 text-ink-3 dark:text-gray-400">{t('builder.interaction.listDesc')}</Text> : null}
          {list.items.map((it, i) => {
            const parts = labelParts(it.label);
            const fixed = savedCodes.has(it.code);
            return (
              <View key={`${i}`} className="gap-1 border-t border-line pt-2 dark:border-line-dark">
                {fixed ? (
                  <Text className="text-sm text-ink-2 dark:text-gray-300">{t('builder.list.codeFixed', { code: it.code })}</Text>
                ) : (
                  <LabeledField label={t('builder.list.code')} value={it.code} required onSave={(v) => update((x) => updateCode(x, listId, i, { code: v }, saved))} />
                )}
                <LabeledField label={t('builder.name')} value={parts.text} required onSave={(v) => update((x) => updateCode(x, listId, i, { name: { text: v, en: parts.en } }, saved))} />
                <LabeledField label={t('builder.nameEn')} value={parts.en} onSave={(v) => update((x) => updateCode(x, listId, i, { name: { text: parts.text, en: v } }, saved))} />
                {interaction ? (
                  <View className="gap-1">
                    <Text className="text-xs font-bold text-ink-2 dark:text-gray-400">{t('builder.interaction.direction')}</Text>
                    {fixed ? (
                      <Text className="text-sm text-ink-2 dark:text-gray-300">{t('builder.interaction.directionFixed', { dir: t(it.mutual ? 'builder.interaction.mutual' : 'builder.interaction.oneWay') })}</Text>
                    ) : (
                      <Seg
                        value={it.mutual ? 'mutual' : 'one'}
                        options={[
                          { value: 'one', label: t('builder.interaction.oneWayLong') },
                          { value: 'mutual', label: t('builder.interaction.mutualLong') },
                        ]}
                        onChange={(v) => update((x) => updateCode(x, listId, i, { mutual: v === 'mutual' }, saved))}
                      />
                    )}
                    {!it.mutual ? (
                      <>
                        <LabeledField
                          label={t('builder.interaction.inverse')}
                          value={labelParts(it.inverse).text}
                          placeholder={t('builder.interaction.inverseHint')}
                          onSave={(v) => update((x) => updateCode(x, listId, i, { inverse: { text: v, en: labelParts(it.inverse).en } }, saved))}
                        />
                        <LabeledField
                          label={t('builder.interaction.inverseEn')}
                          value={labelParts(it.inverse).en}
                          onSave={(v) => update((x) => updateCode(x, listId, i, { inverse: { text: labelParts(it.inverse).text, en: v } }, saved))}
                        />
                      </>
                    ) : null}
                    <LabeledField label={t('builder.interaction.iri')} value={it.iri ?? ''} placeholder="http://purl.obolibrary.org/obo/RO_…" onSave={(v) => update((x) => updateCode(x, listId, i, { iri: v }, saved))} />
                    {it.iri && !INTERACTION_IRI.test(it.iri) ? <Text className="text-xs text-alert dark:text-alert-dark">{t('builder.interaction.iriBad')}</Text> : null}
                  </View>
                ) : null}
                <View className="flex-row items-center gap-3" style={{ minHeight: 44 }}>
                  <View className="flex-1">
                    <Text className="text-sm text-ink dark:text-gray-100">{t('builder.list.deprecated')}</Text>
                    <Text className="text-xs leading-4 text-ink-3 dark:text-gray-400">{t('builder.list.deprecatedDesc')}</Text>
                  </View>
                  <Switch value={!!it.deprecated} onValueChange={(v) => update((x) => updateCode(x, listId, i, { deprecated: v }, saved))} accessibilityLabel={t('builder.list.deprecated')} />
                </View>
                {!fixed ? <Button label={t('builder.list.removeCode')} icon="trash-outline" variant="ghost" onPress={() => update((x) => removeCode(x, listId, i, saved))} /> : null}
              </View>
            );
          })}
          <Button label={t('builder.list.addCode')} icon="add" variant="secondary" onPress={() => update((x) => addCode(x, listId))} />
        </FormCard>

        {!users.length ? <Button label={t('builder.list.remove')} icon="trash-outline" variant="danger" onPress={removeList} /> : null}
      </ScrollView>
    </SafeAreaView>
  );
}
