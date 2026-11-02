import { ActivityIndicator, RefreshControl, StyleSheet, Text, View } from 'react-native';

import {
  CompanionMealsChart, FoodBySlotChart, MealDistanceChart, PriceBySlotChart, TopCategoriesChart,
} from '../components/charts/InsightCharts';
import ScrollWithBar from '../components/ScrollWithBar';
import { GlassScreen, PrimaryButton, ScreenTitle, TextLink } from '../components/ui';
import type { InsightsState } from '../lib/insights';
import { colors, spacing, type } from '../theme';

export default function InsightsScreen({ state, onClose, onRefresh }: {
  state: InsightsState; onClose: () => void; onRefresh: () => void;
}) {
  return (
    <GlassScreen>
      <View style={styles.header}>
        <ScreenTitle>Insights</ScreenTitle>
        <TextLink label="Close" onPress={onClose} />
      </View>
      {state.status === 'loading' ? <View style={styles.center}>
        <ActivityIndicator color={colors.textSecondary} accessibilityLabel="Loading insights" />
      </View> : state.status === 'unavailable' ? <View style={styles.center}>
        <Text style={styles.note}>Insights unavailable</Text>
        <PrimaryButton label="Retry" onPress={onRefresh} />
      </View> : <ScrollWithBar
        contentContainerStyle={styles.scroll}
        refreshControl={<RefreshControl refreshing={false} onRefresh={onRefresh} tintColor={colors.textSecondary} />}
      >
        {state.note && <Text accessibilityLiveRegion="polite" style={styles.note}>{state.note}</Text>}
        {state.emptyText && <Text style={styles.note}>{state.emptyText}</Text>}
        <TopCategoriesChart data={state.cards.top} />
        <FoodBySlotChart data={state.cards.food} />
        <PriceBySlotChart data={state.cards.price} />
        <MealDistanceChart data={state.cards.distance} />
        <CompanionMealsChart data={state.cards.companions} />
        {state.cards.companions.unavailable && <TextLink label="Retry names" onPress={onRefresh} />}
      </ScrollWithBar>}
    </GlassScreen>
  );
}

const styles = StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: spacing.lg },
  center: { flex: 1, justifyContent: 'center', gap: spacing.lg },
  scroll: { gap: spacing.lg, paddingBottom: spacing.lg },
  note: { color: colors.textSecondary, fontSize: type.small },
});
