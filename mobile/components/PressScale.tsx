import { useEffect, useState } from 'react';
import { Animated, type GestureResponderEvent, Pressable, type PressableProps, type StyleProp, type ViewStyle } from 'react-native';

import { useReduceMotion } from '../lib/accessibility';
import { haptic, type HapticKind } from '../lib/haptics';
import { motion } from '../theme';

// Shared press feedback (P1-22): chips, primary buttons, and tab bar items. Scales to 0.96 on
// press in and springs back on release, on the native driver. No scale with Reduce Motion on.

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

export type PressScaleProps = Omit<PressableProps, 'style'> & {
  style?: StyleProp<ViewStyle>;
  feedback?: HapticKind | false;
};

export default function PressScale({ style, onPress, onPressIn, onPressOut, disabled, feedback = false, ...rest }: PressScaleProps) {
  // Created once per mount; Animated values are mutable, so state never changes.
  const [scale] = useState(() => new Animated.Value(1));
  const reduceMotion = useReduceMotion(true);
  const interactive = !!onPress && !disabled;

  useEffect(() => {
    if (reduceMotion || !interactive) {
      scale.stopAnimation();
      scale.setValue(1);
    }
    return () => scale.stopAnimation();
  }, [interactive, reduceMotion, scale]);

  function springTo(toValue: number, config: typeof motion.pressIn) {
    Animated.spring(scale, { toValue, ...config, useNativeDriver: true }).start();
  }

  return (
    <AnimatedPressable
      {...rest}
      disabled={!interactive}
      onPress={interactive ? (e: GestureResponderEvent) => {
        e?.stopPropagation?.();
        if (feedback) haptic(feedback);
        onPress?.(e);
      } : undefined}
      onPressIn={(e: GestureResponderEvent) => {
        if (!interactive) return;
        e?.stopPropagation?.();
        if (!reduceMotion) springTo(motion.pressedScale, motion.pressIn);
        onPressIn?.(e);
      }}
      onPressOut={(e: GestureResponderEvent) => {
        if (!interactive) return;
        e?.stopPropagation?.();
        if (!reduceMotion) springTo(1, motion.release);
        onPressOut?.(e);
      }}
      style={[style, { transform: [{ scale }] }]}
    />
  );
}
