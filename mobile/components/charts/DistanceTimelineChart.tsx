import { useId } from 'react';
import { Animated, StyleSheet, Text, View } from 'react-native';
import Svg, { Circle, ClipPath, Defs, Line, LinearGradient, Path, Rect, Stop, Text as SvgText } from 'react-native-svg';

import type { InsightSlot } from '../../lib/api';
import { type DistanceSlot, formatMiles, mealCount, timelineGeometry } from '../../lib/insights';
import { chart, colors, radii, spacing, type } from '../../theme';
import PressScale from '../PressScale';
import { ChartCard, type ChartProps } from './BarChart';
import { useOpeningProgress, useTimelineSwitch } from './OpeningMotion';

const AnimatedRect = Animated.createAnimatedComponent(Rect);
const WIDTH = 320;
const HEIGHT = 190;
const LEFT = 40;
const RIGHT = WIDTH - 8;
const TOP = 20;
const BOTTOM = HEIGHT - 28;
const DOT = 3;

function Timeline({ slot }: { slot: DistanceSlot }) {
  const geometry = timelineGeometry(slot);
  const axes = useOpeningProgress('distance:axes');
  const trace = useOpeningProgress('distance:trace');
  const typical = useOpeningProgress('distance:typical');
  const uid = useId().replace(/[^a-zA-Z0-9]/g, '');
  const gradientId = `distanceGradient${uid}`;
  const clipId = `distanceClip${uid}`;
  const points = geometry.points.map((p) => ({
    x: LEFT + p.x * (RIGHT - LEFT), y: TOP + p.y * (BOTTOM - TOP),
  }));
  const path = points.map((p, i) => `${i ? 'L' : 'M'}${p.x},${p.y}`).join(' ');
  const medianY = TOP + geometry.medianY * (BOTTOM - TOP);
  const reveal = trace.interpolate({ inputRange: [0, 1], outputRange: [0, RIGHT - LEFT + 2 * DOT] });
  const crossYear = geometry.first?.slice(0, 4) !== geometry.last?.slice(0, 4);
  const dateLabel = (date: string) => crossYear ? date : date.slice(5);
  if (!points.length) return <Text style={styles.muted}>No distances yet</Text>;
  const summary = `${mealCount(slot.measured_meal_count)}; Typical ${formatMiles(slot.median_m!)}; `
    + `${geometry.first} to ${geometry.last}; maximum ${formatMiles(geometry.maximum)}`;
  return <View style={styles.content}>
    <Text style={styles.muted}>{mealCount(slot.measured_meal_count)}</Text>
    <View style={styles.plot} accessible accessibilityLabel={summary}>
      <Animated.View style={[StyleSheet.absoluteFill, { opacity: axes }]}>
        <Svg width="100%" height={HEIGHT} viewBox={`0 0 ${WIDTH} ${HEIGHT}`} accessibilityElementsHidden>
          <Line x1={LEFT} x2={LEFT} y1={TOP} y2={BOTTOM} stroke={chart.neutral} />
          <Line x1={LEFT} x2={RIGHT} y1={BOTTOM} y2={BOTTOM} stroke={chart.neutral} />
        </Svg>
      </Animated.View>
      <Animated.View style={[StyleSheet.absoluteFill, { opacity: points.length === 1 ? axes : 1 }]}>
        <Svg width="100%" height={HEIGHT} viewBox={`0 0 ${WIDTH} ${HEIGHT}`} accessibilityElementsHidden>
          <Defs>
            <LinearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
              <Stop offset="0" stopColor={chart.accent} stopOpacity={chart.areaOpacity} />
              <Stop offset="1" stopColor={chart.accent} stopOpacity={0} />
            </LinearGradient>
            <ClipPath id={clipId}>
              <AnimatedRect x={LEFT - DOT} y={0} width={reveal} height={HEIGHT} />
            </ClipPath>
          </Defs>
          {points.length >= 2 && <>
            <Path d={`${path} L${points.at(-1)!.x},${BOTTOM} L${points[0].x},${BOTTOM} Z`}
              fill={`url(#${gradientId})`} clipPath={`url(#${clipId})`} />
            <Path d={path} fill={colors.transparent} stroke={chart.accent} strokeWidth={2}
              clipPath={`url(#${clipId})`} />
          </>}
          {points.map((p, i) => <Circle key={i} cx={p.x} cy={p.y} r={DOT} fill={chart.accent}
            clipPath={points.length >= 2 ? `url(#${clipId})` : undefined} />)}
        </Svg>
      </Animated.View>
      <Animated.View style={[StyleSheet.absoluteFill, { opacity: typical }]}>
        <Svg width="100%" height={HEIGHT} viewBox={`0 0 ${WIDTH} ${HEIGHT}`} accessibilityElementsHidden>
          <Line x1={LEFT} x2={RIGHT} y1={medianY} y2={medianY}
            stroke={chart.neutral} strokeDasharray="4 4" />
        </Svg>
      </Animated.View>
      <Svg width="100%" height={HEIGHT} viewBox={`0 0 ${WIDTH} ${HEIGHT}`} accessibilityElementsHidden>
        <SvgText x={LEFT - 5} y={BOTTOM + 4} textAnchor="end" fontSize={type.caption} fill={colors.textSecondary}>0</SvgText>
        {geometry.maximum > 0 && <SvgText x={LEFT} y={TOP - 6} fontSize={type.caption}
          fill={colors.textSecondary}>{formatMiles(geometry.maximum)}</SvgText>}
        <SvgText x={RIGHT} y={Math.max(TOP + 12, medianY - 6)} textAnchor="end"
          fontSize={type.caption} fill={colors.textSecondary}>Typical · {formatMiles(slot.median_m!)}</SvgText>
        {geometry.first === geometry.last ? <SvgText x={(LEFT + RIGHT) / 2} y={HEIGHT - 5}
          textAnchor="middle" fontSize={type.caption} fill={colors.textSecondary}>{dateLabel(geometry.first!)}</SvgText> : <>
          <SvgText x={LEFT} y={HEIGHT - 5} fontSize={type.caption}
            fill={colors.textSecondary}>{dateLabel(geometry.first!)}</SvgText>
          <SvgText x={RIGHT} y={HEIGHT - 5} textAnchor="end" fontSize={type.caption}
            fill={colors.textSecondary}>{dateLabel(geometry.last!)}</SvgText>
        </>}
      </Svg>
    </View>
    {geometry.message && <Text style={styles.muted}>{geometry.message}</Text>}
  </View>;
}

export default function DistanceTimelineChart({ selectedSlot, onSlotChange, ...props }: ChartProps & {
  selectedSlot: InsightSlot; onSlotChange: (slot: InsightSlot) => void;
}) {
  const slots = props.data.timeline ?? [];
  const switchTimeline = useTimelineSwitch();
  const selected = slots.find((s) => s.id === selectedSlot);
  return <ChartCard title="Meal distance" {...props}>
    <View style={styles.segments}>
      {slots.map((slot) => <PressScale key={slot.id} accessibilityRole="button"
        feedback={slot.id === selectedSlot ? false : 'selection'}
        accessibilityState={{ selected: slot.id === selectedSlot }}
        onPress={() => {
          if (slot.id === selectedSlot) return;
          onSlotChange(slot.id);
          switchTimeline(slot.points.length);
        }} style={[styles.segment, slot.id === selectedSlot && styles.selected]}>
        <Text style={styles.segmentLabel}>{slot.label}</Text>
      </PressScale>)}
    </View>
    {selected && <Timeline slot={selected} />}
  </ChartCard>;
}

const styles = StyleSheet.create({
  content: { gap: spacing.sm },
  plot: { height: HEIGHT },
  muted: { color: colors.textSecondary, fontSize: type.caption },
  segments: { flexDirection: 'row', backgroundColor: colors.glass, borderRadius: radii.bubble, padding: spacing.xs },
  segment: { flex: 1, minHeight: 44, alignItems: 'center', justifyContent: 'center',
    borderRadius: radii.bubble, borderWidth: 1, borderColor: colors.transparent },
  selected: { backgroundColor: colors.glassStrong, borderColor: chart.accent },
  segmentLabel: { color: colors.text, fontSize: type.caption, textAlign: 'center' },
});
