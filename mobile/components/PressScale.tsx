import { useState } from 'react';
import { Animated, type GestureResponderEvent, Pressable, type PressableProps, type StyleProp, type ViewStyle } from 'react-native';

import { useReduceMotion } from '../lib/accessibility';
import { motion } from '../theme';

// Shared press feedback (P1-22): chips, primary buttons, and tab bar items. Scales to 0.96 on
// press in and springs back on release, on the native driver. No scale with Reduce Motion on.

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

export type PressScaleProps = Omit<PressableProps, 'style'> & {
  style?: StyleProp<ViewStyle>;
};

export default function PressScale({ style, onPressIn, onPressOut, disabled, ...rest }: PressScaleProps) {
  // Created once per mount; Animated values are mutable, so state never changes.
  const [scale] = useState(() => new Animated.Value(1));
  const reduceMotion = useReduceMotion();

  function springTo(toValue: number, config: typeof motion.pressIn) {
    Animated.spring(scale, { toValue, ...config, useNativeDriver: true }).start();
  }

  return (
    <AnimatedPressable
      {...rest}
      disabled={disabled}
      onPressIn={(e: GestureResponderEvent) => {
        if (!reduceMotion && !disabled) springTo(motion.pressedScale, motion.pressIn);
        onPressIn?.(e);
      }}
      onPressOut={(e: GestureResponderEvent) => {
        if (!reduceMotion) springTo(1, motion.release);
        onPressOut?.(e);
      }}
      style={[style, { transform: [{ scale }] }]}
    />
  );
}
