import { type ReactNode, type Ref, useEffect, useState } from 'react';
import {
  Animated,
  type FlatListProps,
  type LayoutChangeEvent,
  type ScrollViewInstance,
  type ScrollViewProps,
  StyleSheet,
  View,
  type ViewStyle,
} from 'react-native';

import { colors, layout, scrollBar } from '../theme';

// Shared scroll view with its own indicator (P1-19). The iOS indicator's width can't be set, so
// the native one is hidden and an Animated thumb follows the scroll position on the native
// driver. The viewport extends through GlassScreen's gutters to the screen edge, while
// content keeps the shared inset. The optional list uses the same indicator and preserves
// FlatList virtualization, with no second scrolling surface. The thumb shows while scrolling
// and fades out after a short hold. Values in theme.ts (scrollBar).

// Only the scroll event is animated; row data keeps FlatList's ordinary generic item type.
const AnimatedFlatList = Animated.FlatList as <Item>(props: FlatListProps<Item>) => ReactNode;

type Props<Item> = Omit<ScrollViewProps, 'onScroll' | 'style'> & {
  scrollRef?: Ref<ScrollViewInstance>;
  /** The outer view (the thumb's track runs its full height). */
  style?: ViewStyle;
  children?: ReactNode;
  list?: Pick<FlatListProps<Item>, 'data' | 'keyExtractor' | 'renderItem'>;
};

export function scrollGeometry(view: number, content: number) {
  const scrollable = view > 0 && content > view + 1;
  const thumb = scrollable ? Math.min(view, Math.max(scrollBar.minThumb, (view * view) / content)) : 0;
  return { scrollable, thumb, range: Math.max(1, content - view), travel: Math.max(0, view - thumb) };
}

export default function ScrollWithBar<Item>({
  scrollRef,
  style,
  children,
  list,
  contentContainerStyle,
  onLayout,
  onContentSizeChange,
  ...rest
}: Props<Item>) {
  // Created once: the scroll value, the thumb's opacity, and the scroll handler that wakes it.
  const [bar] = useState(() => {
    const y = new Animated.Value(0);
    const opacity = new Animated.Value(0);
    let shown = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const fade = (toValue: number, duration: number) =>
      Animated.timing(opacity, { toValue, duration, useNativeDriver: true }).start();
    const wake = () => {
      if (!shown) {
        shown = true;
        fade(1, scrollBar.fadeInMs);
      }
      clearTimeout(timer);
      timer = setTimeout(() => {
        shown = false;
        fade(0, scrollBar.fadeOutMs);
      }, scrollBar.holdMs);
    };
    const onScroll = Animated.event([{ nativeEvent: { contentOffset: { y } } }], {
      useNativeDriver: true,
      listener: wake,
    });
    return { y, opacity, onScroll, stop: () => {
      clearTimeout(timer);
      opacity.stopAnimation();
    } };
  });
  useEffect(() => bar.stop, [bar]);

  const [view, setView] = useState(0);
  const [content, setContent] = useState(0);
  const { scrollable, thumb, range, travel } = scrollGeometry(view, content);
  const translateY = bar.y.interpolate({
    inputRange: [0, range],
    outputRange: [0, travel],
    extrapolate: 'clamp',
  });

  const scrollProps = {
    ...rest,
    contentContainerStyle: [styles.content, contentContainerStyle],
    showsVerticalScrollIndicator: false,
    scrollEventThrottle: 16,
    onScroll: bar.onScroll,
    onLayout: (e: LayoutChangeEvent) => {
      setView(e.nativeEvent.layout.height);
      onLayout?.(e);
    },
    onContentSizeChange: (w: number, h: number) => {
      setContent(h);
      onContentSizeChange?.(w, h);
    },
  };

  return (
    <View style={[styles.wrap, style]}>
      {list ? <AnimatedFlatList {...list} {...scrollProps} /> : (
        <Animated.ScrollView {...scrollProps} ref={scrollRef}>
          {children}
        </Animated.ScrollView>
      )}
      {scrollable && (
        <Animated.View
          pointerEvents="none"
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          style={[styles.thumb, { height: thumb, opacity: bar.opacity, transform: [{ translateY }] }]}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    flex: 1,
    marginHorizontal: -layout.gutter,
  },
  content: {
    paddingHorizontal: layout.gutter,
  },
  thumb: {
    position: 'absolute',
    top: 0,
    right: scrollBar.edgeInset,
    width: scrollBar.width,
    borderRadius: scrollBar.width / 2,
    backgroundColor: colors.scrollThumb,
  },
});
