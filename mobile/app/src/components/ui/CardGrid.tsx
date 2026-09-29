/**
 * Photo-card grid whose column count follows the window (04-collection-
 * listrow.md §2): 2 on a phone, 4 on an iPad held upright, 6 across.
 *
 * FlatList cannot change `numColumns` on a mounted list, so the list is keyed
 * by the column count and remounts on rotation. The scroll position is kept
 * as a fraction of the content height and restored once the new list has
 * measured itself — close enough to land on the same cards.
 */
import { useRef, type ReactElement } from 'react';
import { FlatList, useWindowDimensions, View, type FlatListProps } from 'react-native';

const MIN_CARD = 160;
const GAP = 10;
const PAD = 16;

/** Columns for a given width: as many 160-pt cards as fit, 2 to 6. */
export function gridColumns(width: number): number {
  return Math.min(6, Math.max(2, Math.floor((width - PAD * 2 + GAP) / (MIN_CARD + GAP))));
}

export function CardGrid<T>({
  data,
  keyExtractor,
  renderCard,
  ...rest
}: Omit<FlatListProps<T>, 'renderItem' | 'numColumns' | 'key'> & {
  data: readonly T[];
  keyExtractor: (item: T) => string;
  /** `width` is the card's width in points. */
  renderCard: (item: T, width: number) => ReactElement;
}) {
  const { width } = useWindowDimensions();
  const columns = gridColumns(width);
  const cardWidth = (width - PAD * 2 - GAP * (columns - 1)) / columns;

  const list = useRef<FlatList<T>>(null);
  const fraction = useRef(0);
  const restoreFor = useRef<number | null>(null);
  const lastColumns = useRef(columns);
  if (lastColumns.current !== columns) {
    lastColumns.current = columns;
    restoreFor.current = columns;
  }

  return (
    <FlatList
      {...rest}
      ref={list}
      key={`grid-${columns}`}
      data={data}
      numColumns={columns}
      keyExtractor={keyExtractor}
      columnWrapperStyle={{ gap: GAP }}
      contentContainerStyle={[{ padding: PAD, gap: GAP }, rest.contentContainerStyle]}
      renderItem={({ item }) => <View style={{ width: cardWidth }}>{renderCard(item, cardWidth)}</View>}
      onScroll={(e) => {
        const { contentOffset, contentSize } = e.nativeEvent;
        if (contentSize.height > 0) fraction.current = contentOffset.y / contentSize.height;
        rest.onScroll?.(e);
      }}
      scrollEventThrottle={rest.scrollEventThrottle ?? 64}
      onContentSizeChange={(w, h) => {
        if (restoreFor.current === columns && h > 0) {
          restoreFor.current = null;
          list.current?.scrollToOffset({ offset: fraction.current * h, animated: false });
        }
        rest.onContentSizeChange?.(w, h);
      }}
    />
  );
}
