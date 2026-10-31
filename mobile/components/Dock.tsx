import { BlurView } from 'expo-blur';
import { GlassView, isGlassEffectAPIAvailable, isLiquidGlassAvailable } from 'expo-glass-effect';
import { StyleSheet, View } from 'react-native';

import { useReduceTransparency } from '../lib/accessibility';
import { blur, colors, radii } from '../theme';

// The floating tab bar's capsule background (P1-22). Liquid Glass (expo-glass-effect) on iOS 26+;
// elsewhere a BlurView capsule with a light white tint and hairline border. With Reduce
// Transparency on, a plain frosted fill.

// Checked once: isGlassEffectAPIAvailable guards iOS 26 betas that lack the API (expo docs).
const LIQUID_GLASS = isLiquidGlassAvailable() && isGlassEffectAPIAvailable();

export default function DockBackground() {
  const reduce = useReduceTransparency();
  if (reduce) {
    return <View style={[styles.capsule, styles.solid]} />;
  }
  if (LIQUID_GLASS) {
    return <GlassView glassEffectStyle="regular" style={styles.capsule} />;
  }
  return (
    <View style={styles.capsule}>
      <BlurView intensity={blur.intensity} tint={blur.tint} style={StyleSheet.absoluteFill} />
      <View style={[StyleSheet.absoluteFill, styles.tint]} />
    </View>
  );
}

const styles = StyleSheet.create({
  capsule: {
    ...StyleSheet.absoluteFill,
    borderRadius: radii.pill,
    overflow: 'hidden',
  },
  tint: {
    backgroundColor: colors.glass,
    borderRadius: radii.pill,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.hairline,
  },
  solid: {
    backgroundColor: colors.glassStrong,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.hairline,
  },
});
