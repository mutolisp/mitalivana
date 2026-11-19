/**
 * `react-native-draggable-flatlist` without dragging: rows render in order
 * and `drag` does nothing. Reordering (surveyors, unit species) is not
 * offered on the web yet; the stored order is shown and kept.
 */
import type { ReactNode } from 'react';
import { FlatList, type FlatListProps } from '../rn/core';

export type RenderItemParams<T> = { item: T; getIndex: () => number | undefined; drag: () => void; isActive: boolean };

type Props<T> = Omit<FlatListProps<T>, 'renderItem'> & {
  renderItem: (p: RenderItemParams<T>) => ReactNode;
  onDragEnd?: (p: { data: T[]; from: number; to: number }) => void;
  onDragBegin?: () => void;
  activationDistance?: number;
  containerStyle?: unknown;
};

export default function DraggableFlatList<T>(p: Props<T>) {
  const { renderItem, onDragEnd: _a, onDragBegin: _b, activationDistance: _c, containerStyle: _d, ...rest } = p;
  return <FlatList {...rest} renderItem={({ item, index }) => renderItem({ item, getIndex: () => index, drag: () => {}, isActive: false })} />;
}

export function ScaleDecorator({ children }: { children?: ReactNode; activeScale?: number }) {
  return <>{children}</>;
}
export const ShadowDecorator = ScaleDecorator;
export const OpacityDecorator = ScaleDecorator;

/** The nested variant: rows in the page's own scroller (NestableScrollContainer). */
export function NestableDraggableFlatList<T>(p: Props<T>) {
  const { renderItem, data, keyExtractor, ListHeaderComponent, ListFooterComponent, ListEmptyComponent, ItemSeparatorComponent } = p;
  const list = data ?? [];
  const show = (c: ReactNode | (() => ReactNode)) => (typeof c === 'function' ? c() : c);
  return (
    <div className="rn-view">
      {show(ListHeaderComponent)}
      {list.length === 0
        ? show(ListEmptyComponent)
        : list.map((item, index) => (
            <div key={keyExtractor ? keyExtractor(item, index) : String(index)} className="rn-view">
              {index > 0 && ItemSeparatorComponent ? ItemSeparatorComponent() : null}
              {renderItem({ item, getIndex: () => index, drag: () => {}, isActive: false })}
            </div>
          ))}
      {show(ListFooterComponent)}
    </div>
  );
}

export { ScrollView as NestableScrollContainer } from '../rn/core';
