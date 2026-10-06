/**
 * Photo thumbnail grid + full-screen viewer modal. Used by SpeciesDetailSheet
 * (session record detail), PlotSpeciesValueModal (plot species detail),
 * SpecimenDetailSheet and the plot's environment photos.
 *
 * `PhotoGrid` renders a 88×88 thumbnail per URI plus a trailing camera tile
 * that goes straight to the camera (`onAdd`); the library path is the
 * "choose from album" link under the grid (`onPickLibrary`) — one layout for
 * every place a photo can be added, no chooser sheet in between.
 * Tap → onView(idx); long-press → confirm-remove.
 * `PhotoViewerModal` is a horizontally pagable full-bleed image viewer; each
 * page zooms (ZoomableImage: pinch, double tap, pan), and paging stops while
 * the page in view is zoomed.
 */
import { Ionicons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, Dimensions, FlatList, Modal, Pressable, Text, View } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { ZoomableImage } from '~/components/ZoomableImage';
import { rebaseAppFileUri } from '~/lib/appFiles';
import { useThemeColors } from '~/theme/colors';
import { ActionSheetLayer, sheetBack } from '~/components/ActionSheet';

export function PhotoGrid({
  photos,
  onAdd,
  onPickLibrary,
  onView,
  onRemove,
}: {
  photos: string[];
  /** The camera tile — opens the camera directly. */
  onAdd: () => void;
  /** Renders the "choose from album" link under the grid when given. */
  onPickLibrary?: () => void;
  onView?: (index: number) => void;
  onRemove?: (uri: string) => void;
}) {
  const c = useThemeColors();
  const { t } = useTranslation();
  return (
    <View>
      <View className="mt-2 flex-row flex-wrap gap-2">
        {photos.map((uri, idx) => (
          <Pressable
            key={uri}
            onPress={onView ? () => onView(idx) : undefined}
            onLongPress={
              onRemove
                ? () => {
                    Alert.alert(t('plotValue.photo'), undefined, [
                      { text: t('common.cancel'), style: 'cancel' },
                      { text: t('common.remove'), style: 'destructive', onPress: () => onRemove(uri) },
                    ]);
                  }
                : undefined
            }
            className="overflow-hidden rounded-lg border border-gray-200 dark:border-gray-700"
            style={{ width: 88, height: 88 }}
          >
            <Image source={{ uri: rebaseAppFileUri(uri) }} style={{ width: '100%', height: '100%' }} contentFit="cover" />
          </Pressable>
        ))}
        <Pressable
          onPress={onAdd}
          className="items-center justify-center rounded-lg border border-dashed border-gray-300 dark:border-gray-600 bg-gray-50 dark:bg-gray-950 active:bg-gray-100 dark:active:bg-gray-700"
          style={{ width: 88, height: 88 }}
        >
          <Ionicons name="camera-outline" size={24} color={c.ink2} />
          <Text className="mt-1 text-xs text-gray-600 dark:text-gray-400">{t('species.takePhoto')}</Text>
        </Pressable>
      </View>
      {onPickLibrary ? (
        <Pressable onPress={onPickLibrary} hitSlop={8} className="mt-2 flex-row items-center active:opacity-70">
          <Ionicons name="images-outline" size={14} color={c.accent} />
          <Text className="ml-1 text-xs font-medium text-accent-700 dark:text-accent-300">{t('collection.fromLibrary')}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

export function PhotoViewerModal({
  photos,
  index,
  onClose,
}: {
  photos: string[];
  index: number | null;
  onClose: () => void;
}) {
  const listRef = useRef<FlatList<string>>(null);
  const [current, setCurrent] = useState(index ?? 0);
  // The page in view is zoomed: the pager holds still so a drag pans the picture.
  const [zoomed, setZoomed] = useState(false);
  const { width, height } = Dimensions.get('window');

  useEffect(() => {
    if (index !== null) setCurrent(index);
  }, [index]);

  if (index === null || photos.length === 0) return null;

  return (
    <Modal visible animationType="fade" transparent onRequestClose={sheetBack(onClose)}>
      {/* A Modal's content is outside the app's gesture root: the zoom needs its own. */}
      <GestureHandlerRootView style={{ flex: 1 }}>
        <View className="flex-1 bg-black">
          <FlatList
            ref={listRef}
            data={photos}
            keyExtractor={(uri) => uri}
            horizontal
            pagingEnabled
            scrollEnabled={!zoomed}
            showsHorizontalScrollIndicator={false}
            initialScrollIndex={index}
            getItemLayout={(_, i) => ({ length: width, offset: width * i, index: i })}
            onMomentumScrollEnd={(e) => {
              const idx = Math.round(e.nativeEvent.contentOffset.x / width);
              setCurrent(idx);
              setZoomed(false);
            }}
            renderItem={({ item, index: i }) => (
              <ZoomableImage
                uri={rebaseAppFileUri(item)}
                width={width}
                height={height}
                active={i === current}
                onZoomChange={(z) => {
                  if (i === current) setZoomed(z);
                }}
                onTap={onClose}
              />
            )}
          />
          <Pressable onPress={onClose} hitSlop={12} style={{ position: 'absolute', top: 56, right: 20 }}>
            <Ionicons name="close" size={32} color="#fff" />
          </Pressable>
          {photos.length > 1 ? (
            <View style={{ position: 'absolute', bottom: 40, left: 0, right: 0 }} className="items-center">
              <View className="rounded-full bg-black/60 px-3 py-1">
                <Text className="text-sm text-white">
                  {current + 1} / {photos.length}
                </Text>
              </View>
            </View>
          ) : null}
        </View>
      </GestureHandlerRootView>
      <ActionSheetLayer />
    </Modal>
  );
}
