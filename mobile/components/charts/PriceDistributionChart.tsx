import { Animated, StyleSheet, Text, View } from 'react-native';

import type { InsightGroup } from '../../lib/insights';
import { colors, radii, spacing, type } from '../../theme';
import { ChartCard, type ChartProps } from './BarChart';
import { useOpeningProgress } from './OpeningMotion';

const LEVEL_COLORS = [colors.text, colors.textSecondary, colors.accentDark, colors.accentLight];

function SlotBar({ group }: { group: InsightGroup }) {
  const progress = useOpeningProgress(`price:${group.id}`);
  const segments = group.segments ?? [];
  const hasPrice = segments.some((s) => s.fraction > 0);
  if (!hasPrice) return <Text style={styles.muted}>
    {group.label} · No prices yet · {group.detail}
  </Text>;
  const description = segments.map((s) => `${s.label}: ${s.paidCount} paid, ${s.budgetCount} budget`).join('; ');
  return <View style={styles.slot} accessible
    accessibilityLabel={`${group.label}; ${description}; ${group.detail}`}>
    <View style={styles.heading}>
      <Text style={styles.label}>{group.label}</Text>
      <Text style={styles.muted}>{group.detail}</Text>
    </View>
    <View style={styles.track} accessibilityElementsHidden>
      <Animated.View style={[styles.stack, { transform: [{ scaleX: progress }] }]}>
        {segments.filter((s) => s.fraction > 0).map((s) => (
          <View key={s.level} style={[styles.segment, { width: `${100 * s.fraction}%` }]}>
            <View style={{ width: `${100 * s.paidFraction}%`, backgroundColor: LEVEL_COLORS[s.level - 1] }} />
            <View style={{ width: `${100 * s.budgetFraction}%`, backgroundColor: LEVEL_COLORS[s.level - 1], opacity: 0.35 }} />
          </View>
        ))}
      </Animated.View>
    </View>
  </View>;
}

export default function PriceDistributionChart(props: ChartProps) {
  return <ChartCard title="Price by meal slot" {...props}>
    <View style={styles.legend}>
      {LEVEL_COLORS.map((color, i) => <View key={i} style={styles.legendItem}>
        <View style={[styles.swatch, { backgroundColor: color }]} />
        <Text style={styles.muted}>{'$'.repeat(i + 1)}</Text>
      </View>)}
    </View>
    {props.data.groups.map((group) => <SlotBar key={group.id} group={group} />)}
  </ChartCard>;
}

const styles = StyleSheet.create({
  slot: { gap: spacing.sm },
  heading: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between' },
  label: { color: colors.text, fontSize: type.small, fontWeight: '600' },
  muted: { color: colors.textSecondary, fontSize: type.caption },
  track: { height: spacing.md, borderRadius: radii.pill, overflow: 'hidden', backgroundColor: colors.hairline },
  stack: { width: '100%', height: '100%', flexDirection: 'row', transformOrigin: 'left center' },
  segment: { height: '100%', flexDirection: 'row' },
  legend: { flexDirection: 'row', justifyContent: 'space-between', gap: spacing.sm },
  legendItem: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  swatch: { width: spacing.sm, height: spacing.sm, borderRadius: spacing.xs },
});
