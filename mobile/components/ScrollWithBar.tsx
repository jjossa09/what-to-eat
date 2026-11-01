import { type ReactNode, type Ref, useEffect, useState } from 'react';
import {
  Animated,
  type LayoutChangeEvent,
  type ScrollViewInstance,
  type ScrollViewProps,
  StyleSheet,
  View,
  type ViewStyle,
} from 'react-native';

import { colors, scrollBar } from '../theme';

// Chat scroll view with its own indicator (P1-19). The iOS indicator's width can't be set, so
// the native one is hidden and an Animated thumb follows the scroll position on the native
// driver. It sits at the right edge of this view (the chat places it at the screen edge),
// shows while scrolling, and fades out after a short hold. Values in theme.ts (scrollBar).

type Props = Omit<ScrollViewProps, 'onScroll' | 'style'> & {
  scrollRef?: Ref<ScrollViewInstance>;
  /** The outer view (the thumb's track runs its full height). */
  style?: ViewStyle;
  children?: ReactNode;
};

export default function ScrollWithBar({
  scrollRef,
  style,
  children,
  onLayout,
  onContentSizeChange,
  ...rest
}: Props) {
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
    return { y, opacity, onScroll, stop: () => clearTimeout(timer) };
  });
  useEffect(() => bar.stop, [bar]);

  const [view, setView] = useState(0);
  const [content, setContent] = useState(0);
  const scrollable = view > 0 && content > view + 1;
  const thumb = scrollable ? Math.max(scrollBar.minThumb, (view * view) / content) : 0;
  const translateY = bar.y.interpolate({
    inputRange: [0, Math.max(1, content - view)],
    outputRange: [0, Math.max(0, view - thumb)],
    extrapolate: 'clamp',
  });

  return (
    <View style={[styles.wrap, style]}>
      <Animated.ScrollView
        {...rest}
        ref={scrollRef}
        showsVerticalScrollIndicator={false}
        scrollEventThrottle={16}
        onScroll={bar.onScroll}
        onLayout={(e: LayoutChangeEvent) => {
          setView(e.nativeEvent.layout.height);
          onLayout?.(e);
        }}
        onContentSizeChange={(w: number, h: number) => {
          setContent(h);
          onContentSizeChange?.(w, h);
        }}
      >
        {children}
      </Animated.ScrollView>
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
