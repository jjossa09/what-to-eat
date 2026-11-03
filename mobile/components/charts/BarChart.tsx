import type { ReactNode } from 'react';
import { Animated, StyleSheet, Text, View } from 'react-native';

import type { InsightCard } from '../../lib/insights';
import { colors, radii, spacing, type } from '../../theme';
import { GlassCard } from '../ui';
import { useOpeningProgress } from './OpeningMotion';

export type ChartProps = { data: InsightCard; variant?: 'card' | 'inline' };

export function ChartCard({ title, data, variant = 'card', children }: ChartProps & {
  title: string; children: ReactNode;
}) {
  const content = <View style={styles.content}>
    <Text accessibilityRole="header" style={styles.title}>{title}</Text>
    {data.note && <Text style={styles.muted}>{data.note}</Text>}
    {data.unavailable ? <Text style={styles.muted}>{data.unavailable}</Text> : children}
  </View>;
  return variant === 'card' ? <GlassCard>{content}</GlassCard> : content;
}

function BarFill({ id, fraction }: { id: string; fraction: number }) {
  const progress = useOpeningProgress(id);
  return <Animated.View style={[styles.fill, {
    width: `${fraction * 100}%`, transform: [{ scaleX: progress }],
  }]} />;
}

/** Presentation only: counts, leaders, medians and ordering come from the API. */
export default function BarChart({
  title, data, variant, chartId, beforeBars, maximum: suppliedMaximum,
}: ChartProps & { title: string; chartId: string; beforeBars?: ReactNode; maximum?: number }) {
  const hasGroups = data.groups.some((g) => g.label || g.bars.length);
  const maximum = Math.max(1, suppliedMaximum ?? Math.max(0,
    ...data.groups.flatMap((g) => g.bars.map((b) => b.value))));
  return (
    <ChartCard title={title} data={data} variant={variant}>
      {beforeBars}
      {!hasGroups ? (
        <Text style={styles.muted}>{data.emptyText}</Text>
      ) : data.groups.map((group) => (
        <View key={group.id} style={styles.group}>
          {group.bars.length === 0 ? <View style={styles.heading}>
            <Text style={styles.muted}>{group.label}</Text>
            <Text style={styles.muted}>{data.emptyText}</Text>
          </View> : group.label && <View style={styles.heading}>
            <Text style={styles.label}>{group.label}</Text>
            {group.detail && <Text style={styles.muted}>{group.detail}</Text>}
          </View>}
          {group.bars.map((bar) => (
            <View key={bar.id} accessible accessibilityLabel={`${bar.label}, ${bar.valueLabel}`} style={styles.row}>
              <View style={styles.heading}>
                <Text numberOfLines={1} style={styles.barLabel}>{bar.label}</Text>
                <Text style={styles.value}>{bar.valueLabel}</Text>
              </View>
              <View style={styles.track} accessibilityElementsHidden>
                <BarFill id={`${chartId}:${group.id}:${bar.id}`} fraction={bar.value / maximum} />
              </View>
            </View>
          ))}
        </View>
      ))}
    </ChartCard>
  );
}

const styles = StyleSheet.create({
  content: { gap: spacing.md },
  title: { color: colors.text, fontSize: type.heading, fontWeight: '600' },
  muted: { color: colors.textSecondary, fontSize: type.caption },
  group: { gap: spacing.md },
  heading: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', gap: spacing.sm },
  label: { color: colors.text, fontSize: type.small, fontWeight: '600' },
  barLabel: { color: colors.text, fontSize: type.small, flex: 1 },
  value: { color: colors.textSecondary, fontSize: type.caption, flexShrink: 0 },
  row: { gap: spacing.xs },
  track: { height: spacing.sm, borderRadius: radii.pill, backgroundColor: colors.hairline,
    flexDirection: 'row', overflow: 'hidden' },
  fill: { height: '100%', backgroundColor: colors.textSecondary, transformOrigin: 'left center' },
});
