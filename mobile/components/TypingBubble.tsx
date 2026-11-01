import { useEffect, useState } from 'react';
import { Animated, StyleSheet, Text, View } from 'react-native';

import { useReduceMotion } from '../lib/accessibility';
import { colors, radii, typing, type } from '../theme';

// The "…" bubble shown while a typed message is parsed (P1-19). Three dots pulse in turn on the
// native driver; with Reduce Motion on, a still "…". Rounds keep their "Finding spots…" line.

const DOTS = [0, 1, 2];

export default function TypingBubble() {
  const reduceMotion = useReduceMotion();
  const [values] = useState(() => DOTS.map(() => new Animated.Value(typing.dimOpacity)));

  useEffect(() => {
    if (reduceMotion) return;
    const pulse = (v: Animated.Value, i: number) =>
      Animated.loop(
        Animated.sequence([
          Animated.delay(i * typing.stepMs),
          Animated.timing(v, { toValue: 1, duration: typing.pulseMs, useNativeDriver: true }),
          Animated.timing(v, { toValue: typing.dimOpacity, duration: typing.pulseMs, useNativeDriver: true }),
          Animated.delay((DOTS.length - 1 - i) * typing.stepMs),
        ]),
      );
    const run = Animated.parallel(values.map(pulse));
    run.start();
    return () => run.stop();
  }, [reduceMotion, values]);

  return (
    <View style={styles.bubble} accessibilityLabel="Typing" accessibilityRole="text">
      {reduceMotion ? (
        <Text style={styles.still}>…</Text>
      ) : (
        <View style={styles.row}>
          {values.map((v, i) => (
            <Animated.View key={DOTS[i]} style={[styles.dot, { opacity: v }]} />
          ))}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  // Same shape as the chat's assistant bubble.
  bubble: {
    alignSelf: 'flex-start',
    paddingVertical: 14,
    paddingHorizontal: 16,
    borderRadius: radii.bubble,
    backgroundColor: colors.glass,
    borderWidth: 1,
    borderColor: colors.glassBorder,
  },
  row: {
    flexDirection: 'row',
    gap: typing.gap,
  },
  dot: {
    width: typing.dotSize,
    height: typing.dotSize,
    borderRadius: typing.dotSize / 2,
    backgroundColor: colors.textSecondary,
  },
  still: {
    fontSize: type.body,
    color: colors.textSecondary,
  },
});
