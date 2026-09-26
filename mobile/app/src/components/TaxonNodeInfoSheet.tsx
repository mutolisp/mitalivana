/**
 * The ⓘ on a taxonomy-tree node (family, genus, …): what the node is, how much
 * sits under it, and the copy actions that used to hide behind a long-press.
 * A tap on the row itself still expands it; long-press now selects.
 */
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';
import { Modal, Pressable, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { TaxonNode } from '~/db';
import { buildTaxonCopyText, copyToClipboard, taxonCopyActions } from '~/lib/clipboard';

type Props = {
  node: TaxonNode | null;
  onClose: () => void;
  /** Intermediate-rank actions (subfamily, tribe …). Each is offered only when
   *  passed; the caller opens its editor after this sheet has slid out. */
  onAddChild?: (node: TaxonNode) => void;
  onChangeParent?: (node: TaxonNode) => void;
  onResetPlacement?: (node: TaxonNode) => void;
  onEdit?: (node: TaxonNode) => void;
  onDelete?: (node: TaxonNode) => void;
};

export function TaxonNodeInfoSheet({
  node,
  onClose,
  onAddChild,
  onChangeParent,
  onResetPlacement,
  onEdit,
  onDelete,
}: Props) {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  if (!node) return null;
  const stats = Object.entries(node.stats)
    .filter(([, v]) => v > 0)
    .map(([k, v]) => `${t('rank.' + k)} ${v}`)
    .join(' · ');
  return (
    <Modal visible transparent animationType="slide" onRequestClose={onClose}>
      <View className="flex-1">
        <Pressable
          onPress={onClose}
          style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.4)' }}
        />
        <View
          style={{ position: 'absolute', bottom: 0, left: 0, right: 0, paddingBottom: insets.bottom + 8 }}
          className="rounded-t-2xl bg-white dark:bg-gray-900"
        >
          <View className="border-b border-gray-200 px-4 py-3 dark:border-gray-700">
            <View className="flex-row items-baseline">
              {node.name_c ? (
                <Text className="text-lg font-semibold text-gray-900 dark:text-gray-100">
                  {node.name_c}
                </Text>
              ) : null}
              <Text
                className={`${node.name_c ? 'ml-2' : ''} text-base text-gray-700 dark:text-gray-300`}
                selectable
              >
                {node.name}
              </Text>
            </View>
            <Text className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
              {t('rank.' + node.rank_key)}
              {node.user ? ` · ${t('intermediate.userCreated')}` : ''}
              {stats ? ` · ${stats}` : ''}
            </Text>
          </View>
          {(
            [
              [onAddChild, 'add-circle-outline', 'intermediate.addChild'],
              [onChangeParent, 'git-branch-outline', 'intermediate.changeParent'],
              [onResetPlacement, 'refresh-outline', 'intermediate.resetTaicol'],
              [onEdit, 'create-outline', 'intermediate.editNode'],
              [onDelete, 'trash-outline', 'intermediate.deleteNode'],
            ] as const
          ).map(([fn, icon, label]) =>
            fn ? (
              <Pressable
                key={label}
                onPress={() => {
                  onClose();
                  fn(node);
                }}
                className="flex-row items-center border-b border-gray-100 px-4 py-3 active:bg-gray-50 dark:border-gray-800 dark:active:bg-gray-800"
              >
                <Ionicons
                  name={icon}
                  size={18}
                  color={icon === 'trash-outline' ? '#dc2626' : '#4b5563'}
                  style={{ marginRight: 12 }}
                />
                <Text
                  className={`text-base ${icon === 'trash-outline' ? 'text-red-600' : 'text-gray-900 dark:text-gray-100'}`}
                >
                  {t(label)}
                </Text>
              </Pressable>
            ) : null,
          )}
          {taxonCopyActions(node).map((a) => (
            <Pressable
              key={a.mode}
              onPress={() => {
                // Close first: the "copied" toast is root-hosted and would be
                // hidden behind this Modal.
                onClose();
                void copyToClipboard(buildTaxonCopyText(node, a.mode));
              }}
              className="flex-row items-center border-b border-gray-100 px-4 py-3 active:bg-gray-50 dark:border-gray-800 dark:active:bg-gray-800"
            >
              <Ionicons name="copy-outline" size={18} color="#4b5563" style={{ marginRight: 12 }} />
              <Text className="text-base text-gray-900 dark:text-gray-100">{a.label}</Text>
            </Pressable>
          ))}
        </View>
      </View>
    </Modal>
  );
}
