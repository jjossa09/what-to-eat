import { BlurView } from 'expo-blur';
import { type ReactNode, useId, useState } from 'react';
import { type LayoutChangeEvent, StyleSheet, View, type ViewStyle } from 'react-native';
import Svg, { Defs, LinearGradient, RadialGradient, Rect, Stop } from 'react-native-svg';

import { useReduceTransparency } from '../lib/accessibility';
import { blur, colors, frame } from '../theme';

// Shared glass frame (P1-19): the map's "What to eat?!" button, and later the meal detail card,
// so both share one style. Layers, back to front: a BlurView, a white radial veil (strongest
// at the edge, light in the middle), the accent gradient stroke (border only), and a thin
// white outer ring. Every value lives in theme.ts (frame). With Reduce Transparency on, a
// plain frosted fill replaces the blur and veil.

type Props = {
  children?: ReactNode;
  /** circle: needs size. rounded: sized by its content or style, with radius. */
  shape: 'circle' | 'rounded';
  size?: number;
  radius?: number;
  style?: ViewStyle;
};

export default function GlassFrame({ children, shape, size, radius = 0, style }: Props) {
  const reduce = useReduceTransparency();
  const id = useId().replace(/[^a-zA-Z0-9]/g, ''); // gradient ids, unique per frame
  const [box, setBox] = useState(size ? { w: size, h: size } : { w: 0, h: 0 });
  const r = shape === 'circle' ? box.w / 2 : radius;
  const bw = frame.borderWidth;

  function onLayout(e: LayoutChangeEvent) {
    const { width, height } = e.nativeEvent.layout;
    if (width !== box.w || height !== box.h) setBox({ w: width, h: height });
  }

  const sizeStyle = shape === 'circle' && size ? { width: size, height: size } : null;

  return (
    <View style={[styles.outer, sizeStyle, { borderRadius: r }, style]} onLayout={onLayout}>
      <View style={[StyleSheet.absoluteFill, styles.clip, { borderRadius: r }]}>
        {reduce ? (
          <View style={[StyleSheet.absoluteFill, styles.solid]} />
        ) : (
          <BlurView intensity={frame.blurIntensity} tint={blur.tint} style={StyleSheet.absoluteFill} />
        )}
        {box.w > 0 && (
          <Svg width={box.w} height={box.h} style={StyleSheet.absoluteFill}>
            <Defs>
              <RadialGradient id={`veil${id}`} cx="50%" cy="50%" rx="50%" ry="50%">
                <Stop offset="0" stopColor={colors.veil} stopOpacity={frame.veil.center} />
                <Stop offset={frame.veil.midOffset} stopColor={colors.veil} stopOpacity={frame.veil.mid} />
                <Stop offset="1" stopColor={colors.veil} stopOpacity={frame.veil.edge} />
              </RadialGradient>
              <LinearGradient
                id={`edge${id}`}
                x1={frame.start.x}
                y1={frame.start.y}
                x2={frame.end.x}
                y2={frame.end.y}
              >
                {frame.gradient.map((c, i) => (
                  <Stop key={c} offset={i / (frame.gradient.length - 1)} stopColor={c} />
                ))}
              </LinearGradient>
            </Defs>
            {!reduce && <Rect x={0} y={0} width={box.w} height={box.h} rx={r} fill={`url(#veil${id})`} />}
            <Rect
              x={bw / 2}
              y={bw / 2}
              width={Math.max(0, box.w - bw)}
              height={Math.max(0, box.h - bw)}
              rx={Math.max(0, r - bw / 2)}
              fill="none"
              stroke={`url(#edge${id})`}
              strokeWidth={bw}
            />
          </Svg>
        )}
      </View>
      <View
        pointerEvents="none"
        style={[styles.ring, { borderRadius: r + frame.ringWidth }]}
      />
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  outer: {
    // No overflow here, so the shadow shows; the clip view below rounds the blur.
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
  ring: {
    position: 'absolute',
    top: -frame.ringWidth,
    left: -frame.ringWidth,
    right: -frame.ringWidth,
    bottom: -frame.ringWidth,
    borderWidth: frame.ringWidth,
    borderColor: colors.ring,
  },
});
