import Ionicons from '@expo/vector-icons/Ionicons';
import { useFocusEffect } from '@react-navigation/native';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, BackHandler, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';

import {
  CompanionMealsChart, FoodBySlotChart, MealDistanceChart, PriceBySlotChart, TopCategoriesChart,
} from '../components/charts/InsightCharts';
import { OpeningMotion } from '../components/charts/OpeningMotion';
import ScrollWithBar from '../components/ScrollWithBar';
import { GlassScreen, PrimaryButton, ScreenTitle, TextLink, useTabBarSpace } from '../components/ui';
import { defaultDistanceSlot, type InsightsState } from '../lib/insights';
import { getInsightsTakeaway, type InsightSlot, type InsightsResponse } from '../lib/api';
import { colors, spacing, type } from '../theme';

export default function InsightsScreen({ state, onClose, onRefresh }: {
  state: InsightsState; onClose: () => void; onRefresh: () => void;
}) {
  const space = useTabBarSpace();
  const [selectedSlot, setSelectedSlot] = useState<InsightSlot | null>(null);
  const [takeaway, setTakeaway] = useState<{ stats: InsightsResponse; line: string | null } | null>(null);
  useEffect(() => {
    if (state.status !== 'ready') return;
    let live = true;
    const saved = state.cards.companions.groups.flatMap((g) => g.bars.map((b) => ({ id: b.id, name: b.label })));
    getInsightsTakeaway(state.response, saved).then((result) => {
      if (live) setTakeaway({ stats: state.response, line: result.line });
    });
    return () => { live = false; };
  }, [state]);
  const activeSlot = selectedSlot ?? (state.status === 'ready'
    ? defaultDistanceSlot(state.cards.distance.timeline ?? []) : 'breakfast');
  useEffect(() => {
    if (state.status === 'ready' && selectedSlot === null) setSelectedSlot(activeSlot);
  }, [activeSlot, selectedSlot, state]);
  useFocusEffect(useCallback(() => {
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      onClose();
      return true;
    });
    return () => subscription.remove();
  }, [onClose]));
  return (
    <OpeningMotion cards={state.status === 'ready' ? state.cards : undefined} selectedSlot={activeSlot}>
    <GlassScreen tabBar>
      <View style={styles.header}>
        <Pressable accessibilityRole="button" accessibilityLabel="Back to Profile"
          hitSlop={spacing.sm} onPress={onClose} style={styles.back}>
          <Ionicons name="chevron-back" size={spacing.xxl} color={colors.text} />
        </Pressable>
        <ScreenTitle>Insights</ScreenTitle>
      </View>
      {state.status === 'loading' ? <View style={[styles.center, { paddingBottom: space }]}>
        <ActivityIndicator color={colors.textSecondary} accessibilityLabel="Loading insights" />
      </View> : state.status === 'unavailable' ? <View style={[styles.center, { paddingBottom: space }]}>
        <Text style={styles.note}>Insights unavailable</Text>
        <PrimaryButton label="Retry" onPress={onRefresh} />
      </View> : <ScrollWithBar
        contentContainerStyle={[styles.scroll, { paddingBottom: space }]}
        refreshControl={<RefreshControl refreshing={false} onRefresh={onRefresh} tintColor={colors.textSecondary} />}
      >
        {takeaway?.stats === state.response && takeaway.line &&
          <Text style={styles.takeaway} numberOfLines={1}>{takeaway.line}</Text>}
        {state.note && <Text accessibilityLiveRegion="polite" style={styles.note}>{state.note}</Text>}
        {state.emptyText && <Text style={styles.note}>{state.emptyText}</Text>}
        <TopCategoriesChart data={state.cards.top} />
        <FoodBySlotChart data={state.cards.food} />
        <PriceBySlotChart data={state.cards.price} />
        <MealDistanceChart data={state.cards.distance} selectedSlot={activeSlot}
          onSlotChange={setSelectedSlot} />
        <CompanionMealsChart data={state.cards.companions} />
        {state.cards.companions.unavailable && <TextLink label="Retry names" onPress={onRefresh} />}
      </ScrollWithBar>}
    </GlassScreen>
    </OpeningMotion>
  );
}

const styles = StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginBottom: spacing.lg },
  back: { width: 44, height: 44, justifyContent: 'center', alignItems: 'center' },
  center: { flex: 1, justifyContent: 'center', gap: spacing.lg },
  scroll: { gap: spacing.lg, paddingBottom: spacing.lg },
  note: { color: colors.textSecondary, fontSize: type.small },
  takeaway: { color: colors.text, fontSize: type.small },
});
