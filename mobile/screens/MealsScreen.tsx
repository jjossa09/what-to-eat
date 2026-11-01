import { useFocusEffect } from '@react-navigation/native';
import { type ComponentRef, useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, FlatList, StyleSheet, Text, View } from 'react-native';

import MealCard, { type Rect } from '../components/MealCard';
import PressScale from '../components/PressScale';
import { GlassCard, GlassScreen, PrimaryButton, ScreenTitle, useTabBarSpace } from '../components/ui';
import { loadMeals, type Meal, mealLine } from '../lib/meals';
import { loadCategories } from '../lib/profile';
import { colors, emojiFor, spacing, type } from '../theme';

// The user's meals, newest first (P1-22). Reloads each time the tab is opened. A tap on a row
// opens its detail card (P1-24), which zooms out of the row's exact position.

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

function MealRow({ meal, onOpen }: { meal: Meal; onOpen: (meal: Meal, from: Rect) => void }) {
  const ref = useRef<ComponentRef<typeof View>>(null);
  return (
    <View ref={ref} collapsable={false}>
      <PressScale
        onPress={() =>
          ref.current?.measureInWindow((x, y, width, height) => onOpen(meal, { x, y, width, height }))
        }
        accessibilityRole="button"
        accessibilityHint="Opens the meal's details"
      >
        <GlassCard>
          <View style={styles.row}>
            <Text style={styles.emoji}>{emojiFor(meal.category)}</Text>
            <View style={styles.rowText}>
              <Text style={styles.name} numberOfLines={1}>
                {meal.placeName}
              </Text>
              <Text style={styles.meta}>{mealLine(meal)}</Text>
            </View>
            {meal.stars !== null && <Stars count={meal.stars} />}
          </View>
        </GlassCard>
      </PressScale>
    </View>
  );
}

export default function MealsScreen({ userId }: { userId: string }) {
  const space = useTabBarSpace();
  const [meals, setMeals] = useState<Meal[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState<{ id: string; from: Rect } | null>(null);
  const [names, setNames] = useState<Map<string, string>>(new Map());

  useEffect(() => {
    loadCategories()
      .then((rows) => setNames(new Map(rows.map((c) => [c.id, c.name]))))
      .catch(() => undefined); // the card then shows the dish only
  }, []);

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

  const openMeal = open ? (meals ?? []).find((m) => m.id === open.id) : undefined;

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
        renderItem={({ item }) => <MealRow meal={item} onOpen={(m, from) => setOpen({ id: m.id, from })} />}
      />
    );
  }

  return (
    <GlassScreen tabBar>
      <ScreenTitle>Meals</ScreenTitle>
      {content}
      {open && openMeal && (
        <MealCard
          meal={openMeal}
          from={open.from}
          categoryName={(id) => (id ? (names.get(id) ?? null) : null)}
          onClose={() => setOpen(null)}
          onSaved={async () => {
            await fetchMeals();
          }}
        />
      )}
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
