import { useFocusEffect } from '@react-navigation/native';
import { useCallback, useState } from 'react';
import { ActivityIndicator, FlatList, StyleSheet, Text, View } from 'react-native';

import { GlassCard, GlassScreen, PrimaryButton, ScreenTitle, useTabBarSpace } from '../components/ui';
import { loadMeals, type Meal, mealLine } from '../lib/meals';
import { colors, emojiFor, spacing, type } from '../theme';

// The user's meals, newest first (P1-22). Reloads each time the tab is opened.

function Stars({ count }: { count: number }) {
  return (
    <Text style={styles.stars} accessibilityLabel={`${count} of 5 stars`}>
      {Array.from({ length: 5 }, (_, i) => (
        <Text key={i} style={i < count ? styles.starOn : styles.starOff}>
          ★
        </Text>
      ))}
    </Text>
  );
}

export default function MealsScreen({ userId }: { userId: string }) {
  const space = useTabBarSpace();
  const [meals, setMeals] = useState<Meal[] | null>(null);
  const [failed, setFailed] = useState(false);

  const fetchMeals = useCallback(
    (isLive: () => boolean = () => true) =>
      loadMeals(userId)
        .then((rows) => {
          if (!isLive()) return;
          setMeals(rows);
          setFailed(false);
        })
        .catch(() => isLive() && setFailed(true)),
    [userId],
  );

  useFocusEffect(
    useCallback(() => {
      let live = true;
      fetchMeals(() => live);
      return () => {
        live = false;
      };
    }, [fetchMeals]),
  );

  let content;
  if (failed && !meals) {
    content = (
      <View style={[styles.center, { paddingBottom: space }]}>
        <Text style={styles.empty}>Couldn&apos;t load.</Text>
        <PrimaryButton label="Retry" onPress={() => fetchMeals()} />
      </View>
    );
  } else if (!meals) {
    content = <ActivityIndicator style={styles.spinner} />;
  } else if (meals.length === 0) {
    content = <Text style={styles.empty}>No meals yet.</Text>;
  } else {
    content = (
      <FlatList
        data={meals}
        keyExtractor={(m) => m.id}
        contentContainerStyle={[styles.list, { paddingBottom: space }]}
        showsVerticalScrollIndicator={false}
        renderItem={({ item }) => (
          <GlassCard>
            <View style={styles.row}>
              <Text style={styles.emoji}>{emojiFor(item.category)}</Text>
              <View style={styles.rowText}>
                <Text style={styles.name} numberOfLines={1}>
                  {item.placeName}
                </Text>
                <Text style={styles.meta}>{mealLine(item)}</Text>
              </View>
              {item.stars !== null && <Stars count={item.stars} />}
            </View>
          </GlassCard>
        )}
      />
    );
  }

  return (
    <GlassScreen tabBar>
      <ScreenTitle>Meals</ScreenTitle>
      {content}
    </GlassScreen>
  );
}

const styles = StyleSheet.create({
  center: {
    flex: 1,
    justifyContent: 'center',
    gap: spacing.lg,
  },
  spinner: {
    marginTop: spacing.xxl,
  },
  empty: {
    fontSize: type.body,
    color: colors.textSecondary,
    textAlign: 'center',
    marginTop: spacing.xxl,
  },
  list: {
    gap: spacing.md,
    paddingBottom: spacing.lg,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    marginVertical: -spacing.xs,
  },
  emoji: {
    fontSize: 28,
  },
  rowText: {
    flex: 1,
    gap: 2,
  },
  name: {
    fontSize: type.body,
    fontWeight: '600',
    color: colors.text,
  },
  meta: {
    fontSize: type.small,
    color: colors.textSecondary,
  },
  stars: {
    fontSize: type.small,
  },
  starOn: {
    color: colors.star,
  },
  starOff: {
    color: colors.starEmpty,
  },
});
