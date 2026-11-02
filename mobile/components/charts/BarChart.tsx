import { StyleSheet, Text, View } from 'react-native';

import type { InsightCard } from '../../lib/insights';
import { colors, radii, spacing, type } from '../../theme';
import { GlassCard } from '../ui';

export type ChartProps = { data: InsightCard; variant?: 'card' | 'inline' };

/** Presentation only: counts, leaders, medians and ordering come from the API. */
export default function BarChart({
  title, data, variant = 'card',
}: ChartProps & { title: string }) {
  const hasBars = data.groups.some((g) => g.bars.length > 0);
  const maximum = Math.max(1, ...data.groups.flatMap((g) =>
    g.bars.map((b) => b.value + (b.budgetValue ?? 0))));
  const content = (
    <View style={styles.content}>
      <Text accessibilityRole="header" style={styles.title}>{title}</Text>
      {data.note && <Text style={styles.muted}>{data.note}</Text>}
      {data.unavailable ? <Text style={styles.muted}>{data.unavailable}</Text> : !hasBars ? (
        <Text style={styles.muted}>{data.emptyText}</Text>
      ) : data.groups.map((group) => (
        <View key={group.id} style={styles.group}>
          {group.label && <View style={styles.heading}>
            <Text style={styles.label}>{group.label}</Text>
            {group.detail && <Text style={styles.muted}>{group.detail}</Text>}
          </View>}
          {group.bars.length === 0 && <Text style={styles.muted}>{data.emptyText}</Text>}
          {group.bars.map((bar) => (
            <View key={bar.id} accessible accessibilityLabel={`${bar.label}, ${bar.valueLabel}`} style={styles.row}>
              <View style={styles.heading}>
                <Text numberOfLines={1} style={styles.barLabel}>{bar.label}</Text>
                <Text style={styles.value}>{bar.valueLabel}</Text>
              </View>
              <View style={styles.track} accessibilityElementsHidden>
                <View style={[styles.fill, { width: `${100 * bar.value / maximum}%` }]} />
                {!!bar.budgetValue && <View style={[styles.fill, styles.budget,
                  { width: `${100 * bar.budgetValue / maximum}%` }]} />}
              </View>
            </View>
          ))}
        </View>
      ))}
    </View>
  );
  return variant === 'card' ? <GlassCard>{content}</GlassCard> : content;
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
  fill: { height: '100%', backgroundColor: colors.textSecondary },
  budget: { opacity: 0.35 },
});
