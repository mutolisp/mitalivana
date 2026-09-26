/**
 * Create / edit / re-place intermediate-rank taxa (subfamily, tribe …) from the
 * taxonomy tree's ⓘ sheet. See db/intermediateTaxa.ts for the data model.
 *
 * One full-screen Modal with three steps, because every step but the parent
 * list has text input (a floating sheet would be pushed off-screen by the
 * keyboard avoidance):
 *   - form     — rank / name / author / common name (create or edit)
 *   - members  — after creating: tick the siblings to move into the new node
 *   - parent   — pick where an existing taxon hangs
 */
import { Ionicons } from '@expo/vector-icons';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Modal, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  createIntermediateNode,
  getIntermediateNode,
  guessRankFromSuffix,
  levelContext,
  parentCandidates,
  placeChildren,
  placementCandidates,
  placementKeyOf,
  ranksForNewChild,
  updateIntermediateNode,
  type TaxonNode,
} from '~/db';
import { KeyboardAvoidingView } from './KeyboardAvoidingView';
import { ScientificName } from './ScientificName';
import { ToastHost } from './ToastHost';
import { useToast } from '~/stores/toast';

export type EditorRequest =
  | { kind: 'create'; parent: TaxonNode }
  | { kind: 'edit'; node: TaxonNode }
  | { kind: 'parent'; node: TaxonNode };

type Props = { request: EditorRequest | null; onClose: () => void };

const cap = (s: string) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

export function IntermediateEditor({ request, onClose }: Props) {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const toast = useToast((s) => s.show);

  const [step, setStep] = useState<'form' | 'members' | 'parent'>('form');
  const [rank, setRank] = useState('');
  const [name, setName] = useState('');
  const [author, setAuthor] = useState('');
  const [cname, setCname] = useState('');
  const [createdRef, setCreatedRef] = useState<string | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());

  const rankOptions = useMemo(() => {
    if (!request) return [];
    if (request.kind === 'create') return ranksForNewChild(request.parent);
    return [];
  }, [request]);

  useEffect(() => {
    if (!request) return;
    setPicked(new Set());
    setCreatedRef(null);
    if (request.kind === 'parent') {
      setStep('parent');
      return;
    }
    setStep('form');
    if (request.kind === 'edit') {
      const n = request.node.ref ? getIntermediateNode(request.node.ref) : undefined;
      setRank(request.node.rank_key);
      setName(request.node.name);
      setAuthor(n?.name_author ?? '');
      setCname(request.node.name_c);
    } else {
      setRank(ranksForNewChild(request.parent)[0] ?? '');
      setName('');
      setAuthor('');
      setCname('');
    }
  }, [request]);

  // The members step lists the new node's siblings, so it needs the parent.
  const memberCandidates = useMemo(() => {
    if (step !== 'members' || request?.kind !== 'create') return [];
    return placementCandidates(request.parent, createdRef ?? undefined);
  }, [step, request, createdRef]);

  const parentOptions = useMemo(() => {
    if (step !== 'parent' || request?.kind !== 'parent') return [];
    return parentCandidates(request.node);
  }, [step, request]);

  if (!request) return null;

  const kingdom =
    request.kind === 'create'
      ? (levelContext(request.parent)?.kingdom ?? '')
      : (request.node.ancestors.kingdom ?? '');

  const onNameChange = (v: string) => {
    setName(v);
    if (request.kind !== 'create') return;
    const g = guessRankFromSuffix(v);
    if (g && rankOptions.includes(g)) setRank(g);
  };

  const saveForm = () => {
    const trimmed = name.trim();
    if (!trimmed) {
      toast(t('intermediate.nameRequired'));
      return;
    }
    if (request.kind === 'edit' && request.node.ref) {
      updateIntermediateNode(request.node.ref, {
        simple_name: trimmed,
        name_author: author,
        common_name_c: cname,
      });
      toast(t('intermediate.saved'));
      onClose();
      return;
    }
    if (request.kind !== 'create') return;
    const ctx = levelContext(request.parent);
    if (!ctx || !rank) {
      toast(t('intermediate.noRank'));
      return;
    }
    const id = createIntermediateNode({
      rank,
      simple_name: trimmed,
      name_author: author,
      common_name_c: cname,
      kingdom: ctx.kingdom,
      anchorRank: ctx.anchorRank,
      anchorName: ctx.anchorName,
      parentRef: ctx.parentRef,
    });
    setCreatedRef(id);
    setStep('members');
  };

  const saveMembers = () => {
    if (createdRef && picked.size > 0) {
      placeChildren([...picked], createdRef);
      toast(t('intermediate.placed'));
    } else {
      toast(t('intermediate.saved'));
    }
    onClose();
  };

  const pickParent = (ref: string | null) => {
    if (request.kind !== 'parent') return;
    const key = placementKeyOf(request.node);
    if (key) {
      placeChildren([key], ref);
      toast(t('intermediate.placed'));
    }
    onClose();
  };

  const title =
    request.kind === 'parent'
      ? t('intermediate.parentTitle', { name: request.node.name_c || request.node.name })
      : step === 'members'
        ? t('intermediate.pickMembers', { name: name.trim() })
        : request.kind === 'edit'
          ? t('intermediate.formTitleEdit')
          : t('intermediate.formTitleNew');

  const right =
    step === 'form' ? (
      <Pressable onPress={saveForm} hitSlop={8}>
        <Text
          className={`text-base font-semibold ${name.trim() ? 'text-blue-600 dark:text-blue-400' : 'text-gray-300'}`}
        >
          {t('common.save')}
        </Text>
      </Pressable>
    ) : step === 'members' ? (
      <Pressable onPress={saveMembers} hitSlop={8}>
        <Text className="text-base font-semibold text-blue-600 dark:text-blue-400">
          {picked.size > 0 ? t('common.done') : t('intermediate.skipMembers')}
        </Text>
      </Pressable>
    ) : (
      <View style={{ width: 40 }} />
    );

  return (
    <Modal visible animationType="slide" onRequestClose={onClose}>
      <View
        className="flex-1 bg-white dark:bg-gray-900"
        style={{ paddingTop: insets.top, paddingBottom: insets.bottom }}
      >
        <View className="flex-row items-center justify-between border-b border-gray-200 px-4 py-3 dark:border-gray-700">
          <Pressable onPress={onClose} hitSlop={8}>
            <Text className="text-base text-gray-700 dark:text-gray-300">
              {step === 'members' ? t('common.close') : t('common.cancel')}
            </Text>
          </Pressable>
          <Text
            className="mx-2 flex-1 text-center text-base font-semibold text-gray-900 dark:text-gray-100"
            numberOfLines={1}
          >
            {title}
          </Text>
          {right}
        </View>

        {step === 'form' ? (
          <KeyboardAvoidingView className="flex-1" behavior="padding">
            <ScrollView className="flex-1" keyboardShouldPersistTaps="handled">
              {request.kind === 'create' ? (
                <Text className="px-4 pt-3 text-sm text-gray-500 dark:text-gray-400">
                  {t('intermediate.under', {
                    parent: request.parent.name_c
                      ? `${request.parent.name_c} ${request.parent.name}`
                      : request.parent.name,
                  })}
                </Text>
              ) : null}
              {request.kind === 'create' ? (
                <View className="px-4 pt-3">
                  <Text className="mb-1 text-sm text-gray-600 dark:text-gray-400">{t('intermediate.rank')}</Text>
                  {rankOptions.length === 0 ? (
                    <Text className="text-sm text-red-600">{t('intermediate.noRank')}</Text>
                  ) : (
                    <View className="flex-row flex-wrap">
                      {rankOptions.map((r) => (
                        <Pressable
                          key={r}
                          onPress={() => setRank(r)}
                          className={`mb-2 mr-2 rounded-full border px-3 py-1 ${
                            rank === r
                              ? 'border-blue-600 bg-blue-600'
                              : 'border-gray-300 dark:border-gray-600'
                          }`}
                        >
                          <Text
                            className={`text-sm ${rank === r ? 'text-white' : 'text-gray-800 dark:text-gray-200'}`}
                          >
                            {t('rank.' + r)}
                          </Text>
                        </Pressable>
                      ))}
                    </View>
                  )}
                </View>
              ) : null}
              <Field label={t('intermediate.name')}>
                <TextInput
                  value={name}
                  onChangeText={onNameChange}
                  autoFocus
                  autoCapitalize="words"
                  autoCorrect={false}
                  className="rounded border border-gray-300 px-3 py-2 text-base text-gray-900 dark:border-gray-600 dark:text-gray-100"
                  placeholder="Bambusoideae"
                  placeholderTextColor="#9ca3af"
                />
              </Field>
              <Field label={t('intermediate.author')}>
                <TextInput
                  value={author}
                  onChangeText={setAuthor}
                  autoCorrect={false}
                  className="rounded border border-gray-300 px-3 py-2 text-base text-gray-900 dark:border-gray-600 dark:text-gray-100"
                  placeholderTextColor="#9ca3af"
                />
              </Field>
              <Field label={t('intermediate.cname')}>
                <TextInput
                  value={cname}
                  onChangeText={setCname}
                  className="rounded border border-gray-300 px-3 py-2 text-base text-gray-900 dark:border-gray-600 dark:text-gray-100"
                  placeholderTextColor="#9ca3af"
                />
              </Field>
            </ScrollView>
          </KeyboardAvoidingView>
        ) : null}

        {step === 'members' ? (
          <ScrollView className="flex-1">
            <Text className="px-4 py-3 text-sm text-gray-500 dark:text-gray-400">
              {t('intermediate.pickMembersHint')}
            </Text>
            {memberCandidates.map((c) => {
              const on = picked.has(c.key);
              return (
                <Pressable
                  key={c.key}
                  onPress={() => {
                    const next = new Set(picked);
                    if (on) next.delete(c.key);
                    else next.add(c.key);
                    setPicked(next);
                  }}
                  className="flex-row items-center border-b border-gray-100 px-4 py-3 active:bg-gray-50 dark:border-gray-800 dark:active:bg-gray-800"
                >
                  <Ionicons
                    name={on ? 'checkbox' : 'square-outline'}
                    size={22}
                    color={on ? '#2563eb' : '#9ca3af'}
                    style={{ marginRight: 12 }}
                  />
                  <View className="flex-1">
                    {c.name_c ? (
                      <Text className="text-base text-gray-900 dark:text-gray-100">{c.name_c}</Text>
                    ) : null}
                    <ScientificName
                      name={c.name}
                      kingdom={kingdom}
                      rank={cap(c.rank)}
                      className="text-sm text-gray-600 dark:text-gray-400"
                    />
                  </View>
                  <Text className="text-xs text-gray-500">{t('rank.' + c.rank)}</Text>
                </Pressable>
              );
            })}
          </ScrollView>
        ) : null}

        {step === 'parent' ? (
          <ScrollView className="flex-1">
            {parentOptions.map((p) => (
              <Pressable
                key={p.ref ?? 'anchor'}
                onPress={() => pickParent(p.ref)}
                className="flex-row items-center border-b border-gray-100 py-3 pr-4 active:bg-gray-50 dark:border-gray-800 dark:active:bg-gray-800"
                style={{ paddingLeft: 16 + p.depth * 14 }}
              >
                <View className="flex-1">
                  <Text className="text-base text-gray-900 dark:text-gray-100">
                    {p.ref === null
                      ? t('intermediate.directUnder', { name: p.name_c ? `${p.name_c} ${p.name}` : p.name })
                      : p.name_c
                        ? `${p.name_c} ${p.name}`
                        : p.name}
                  </Text>
                </View>
                <Text className="text-xs text-gray-500">{t('rank.' + p.rank)}</Text>
              </Pressable>
            ))}
          </ScrollView>
        ) : null}
      </View>
      <ToastHost inModal />
    </Modal>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <View className="px-4 pt-3">
      <Text className="mb-1 text-sm text-gray-600 dark:text-gray-400">{label}</Text>
      {children}
    </View>
  );
}
