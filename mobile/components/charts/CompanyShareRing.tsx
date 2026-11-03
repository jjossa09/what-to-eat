import { Animated, StyleSheet, Text, View } from 'react-native';
import Svg, { Circle } from 'react-native-svg';

import type { CompanyRing } from '../../lib/insights';
import { chart, colors, spacing, type } from '../../theme';
import { useOpeningProgress } from './OpeningMotion';

const AnimatedCircle = Animated.createAnimatedComponent(Circle);
const SIZE = 80;
const STROKE = 8;
const RADIUS = (SIZE - STROKE) / 2;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

export default function CompanyShareRing({ data }: { data: CompanyRing }) {
  const progress = useOpeningProgress('companions:ring');
  const offset = progress.interpolate({ inputRange: [0, 1],
    outputRange: [CIRCUMFERENCE, CIRCUMFERENCE * (1 - data.fraction)] });
  return <View style={styles.ring} accessible accessibilityLabel={data.label}>
    <Svg width={SIZE} height={SIZE} viewBox={`0 0 ${SIZE} ${SIZE}`} accessibilityElementsHidden>
      <Circle cx={SIZE / 2} cy={SIZE / 2} r={RADIUS} stroke={colors.hairline}
        strokeWidth={STROKE} fill={colors.transparent} />
      <AnimatedCircle cx={SIZE / 2} cy={SIZE / 2} r={RADIUS} stroke={chart.accent}
        strokeWidth={STROKE} fill={colors.transparent}
        strokeDasharray={[CIRCUMFERENCE, CIRCUMFERENCE]} strokeDashoffset={offset}
        transform={`rotate(-90 ${SIZE / 2} ${SIZE / 2})`} />
    </Svg>
    <Text style={styles.label}>{data.label}</Text>
  </View>;
}

const styles = StyleSheet.create({
  ring: { alignItems: 'center', gap: spacing.sm, marginBottom: spacing.sm },
  label: { color: colors.textSecondary, fontSize: type.small },
});
