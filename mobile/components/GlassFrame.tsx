import { BlurView } from 'expo-blur';
import { GlassView, isGlassEffectAPIAvailable, isLiquidGlassAvailable } from 'expo-glass-effect';
import { type ReactNode, useId, useState } from 'react';
import { type LayoutChangeEvent, StyleSheet, View, type ViewStyle } from 'react-native';
import Svg, { Defs, LinearGradient, Rect, Stop } from 'react-native-svg';

import { useReduceTransparency } from '../lib/accessibility';
import { blur, colors, frame } from '../theme';

// Shared glass frame (P1-19, P1-24): the map's "What to eat?!" button and the meal detail card,
// so both share one style. Apple-style, like the dock (P1-22). Back to front, clipped to the
// shape:
//   1. fully clear glass: Liquid Glass "clear" on iOS 26+, else a light BlurView with no tint;
//   2. the rim: the accent gradient (bottom to top) in stacked bands from the edge inward,
//      fading to transparent within rim.width. Nothing red under the center.
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

/** Rim bands, outermost first: inset, width, and opacity (eased to about 0 at rim.width). */
function rimBands() {
  const { width, bands, edgeOpacity, falloff } = frame.rim;
  const step = width / bands;
  return Array.from({ length: bands }, (_, i) => ({
    inset: i * step + step / 2,
    width: step,
    opacity: edgeOpacity * Math.pow(1 - i / bands, falloff),
  }));
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
        ) : LIQUID_GLASS ? (
          <GlassView glassEffectStyle={frame.glassStyle} style={[StyleSheet.absoluteFill, { borderRadius: r }]} />
        ) : (
          <BlurView intensity={frame.blurIntensity} tint={blur.tint} style={StyleSheet.absoluteFill} />
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
  solid: {
    backgroundColor: colors.glassStrong,
  },
});
