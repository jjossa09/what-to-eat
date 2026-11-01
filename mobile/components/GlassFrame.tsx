import { BlurView } from 'expo-blur';
import { GlassView, isGlassEffectAPIAvailable, isLiquidGlassAvailable } from 'expo-glass-effect';
import { type ReactNode, useId, useState } from 'react';
import { type LayoutChangeEvent, StyleSheet, View, type ViewStyle } from 'react-native';
import Svg, { Defs, LinearGradient, Rect, Stop } from 'react-native-svg';

import { useReduceTransparency } from '../lib/accessibility';
import { blur, colors, frame } from '../theme';

// Shared glass frame (P1-19): the map's "What to eat?!" button, and later the meal detail card,
// so both share one style. Apple-style, like the dock (P1-22). Back to front, clipped to the
// shape:
//   1. the accent gradient (bottom to top) at low opacity, under the glass;
//   2. the glass: Liquid Glass on iOS 26+, else a BlurView with the glass tint (the dock's
//      fallback), which both pick up the gradient beneath;
//   3. a soft rim: the same gradient in stacked bands from the edge inward, each fainter, so it
//      fades into the body with no hard line.
// Reduce Transparency: a plain frosted fill under the rim. Values in theme.ts (frame).

// Checked once, as in the dock: isGlassEffectAPIAvailable guards iOS 26 betas without the API.
const LIQUID_GLASS = isLiquidGlassAvailable() && isGlassEffectAPIAvailable();

type Props = {
  children?: ReactNode;
  /** circle: needs size. rounded: sized by its content or style, with radius. */
  shape: 'circle' | 'rounded';
  size?: number;
  radius?: number;
  style?: ViewStyle;
};

/** Rim bands, outermost first: inset, width, and opacity (eased from the edge inward). */
function rimBands() {
  const { width, bands, edgeOpacity, innerOpacity } = frame.rim;
  const step = width / bands;
  return Array.from({ length: bands }, (_, i) => {
    const t = bands === 1 ? 0 : i / (bands - 1);
    return {
      inset: i * step + step / 2,
      width: step,
      opacity: edgeOpacity * Math.pow(innerOpacity / edgeOpacity, t),
    };
  });
}

const BANDS = rimBands();

export default function GlassFrame({ children, shape, size, radius = 0, style }: Props) {
  const reduce = useReduceTransparency();
  const id = useId().replace(/[^a-zA-Z0-9]/g, ''); // gradient ids, unique per frame
  const [box, setBox] = useState(size ? { w: size, h: size } : { w: 0, h: 0 });
  const r = shape === 'circle' ? box.w / 2 : radius;

  function onLayout(e: LayoutChangeEvent) {
    const { width, height } = e.nativeEvent.layout;
    if (width !== box.w || height !== box.h) setBox({ w: width, h: height });
  }

  const sizeStyle = shape === 'circle' && size ? { width: size, height: size } : null;
  const clip = [StyleSheet.absoluteFill, styles.clip, { borderRadius: r }];

  function gradient(gid: string) {
    return (
      <LinearGradient id={gid} x1={frame.start.x} y1={frame.start.y} x2={frame.end.x} y2={frame.end.y}>
        {frame.gradient.map((c, i) => (
          <Stop key={c} offset={i / (frame.gradient.length - 1)} stopColor={c} />
        ))}
      </LinearGradient>
    );
  }

  return (
    <View style={[styles.outer, sizeStyle, { borderRadius: r }, style]} onLayout={onLayout}>
      <View style={clip}>
        {reduce ? (
          <View style={[StyleSheet.absoluteFill, styles.solid]} />
        ) : (
          <>
            {box.w > 0 && (
              <Svg width={box.w} height={box.h} style={StyleSheet.absoluteFill}>
                <Defs>{gradient(`under${id}`)}</Defs>
                <Rect width={box.w} height={box.h} fill={`url(#under${id})`} opacity={frame.underOpacity} />
              </Svg>
            )}
            {LIQUID_GLASS ? (
              <GlassView glassEffectStyle={frame.glassStyle} style={[StyleSheet.absoluteFill, { borderRadius: r }]} />
            ) : (
              <>
                <BlurView intensity={frame.blurIntensity} tint={blur.tint} style={StyleSheet.absoluteFill} />
                <View style={[StyleSheet.absoluteFill, styles.tint]} />
              </>
            )}
          </>
        )}
        {box.w > 0 && (
          <Svg width={box.w} height={box.h} style={StyleSheet.absoluteFill} pointerEvents="none">
            <Defs>{gradient(`rim${id}`)}</Defs>
            {BANDS.map((b) => (
              <Rect
                key={b.inset}
                x={b.inset}
                y={b.inset}
                width={Math.max(0, box.w - 2 * b.inset)}
                height={Math.max(0, box.h - 2 * b.inset)}
                rx={Math.max(0, r - b.inset)}
                fill="none"
                stroke={`url(#rim${id})`}
                strokeWidth={b.width}
                strokeOpacity={b.opacity}
              />
            ))}
          </Svg>
        )}
      </View>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  outer: {
    // No overflow here, so the shadow shows; the clip view below rounds the layers.
    shadowColor: colors.shadow,
    shadowOpacity: frame.shadowOpacity,
    shadowRadius: frame.shadowRadius,
    shadowOffset: { width: 0, height: frame.shadowOffsetY },
  },
  clip: {
    overflow: 'hidden',
  },
  tint: {
    backgroundColor: colors.glass,
  },
  solid: {
    backgroundColor: colors.glassStrong,
  },
});
