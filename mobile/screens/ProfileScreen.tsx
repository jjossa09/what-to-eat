import { useFocusEffect } from '@react-navigation/native';
import { type ReactNode, useCallback, useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, Text, View } from 'react-native';

import { Chip, GlassCard, GlassScreen, PrimaryButton, useTabBarSpace } from '../components/ui';
import { loadMeals, mostEatenCategory } from '../lib/meals';
import {
  BUDGETS,
  type Category,
  loadCategories,
  loadCompanions,
  loadDisplayName,
  loadTastePrior,
  type TastePrior,
} from '../lib/profile';
import { colors, emojiFor, spacing, type } from '../theme';

// Read-only profile (P1-22). Editing is a later ticket.

type Data = {
  name: string | null;
  prior: TastePrior;
  companions: string[];
  categories: Category[];
  mostEaten: string | null;
};

function initials(name: string | null): string {
  if (!name) return '?';
  const words = name.trim().split(/\s+/).slice(0, 2);
  return words.map((w) => w[0]?.toUpperCase() ?? '').join('') || '?';
}

function Section({ label, children }: { label: string; children: ReactNode }) {
  return (
    <View style={styles.section}>
      <Text style={styles.label}>{label}</Text>
      {children}
    </View>
  );
}

export default function ProfileScreen({ userId, onSignOut }: { userId: string; onSignOut: () => void }) {
  const space = useTabBarSpace();
  const [data, setData] = useState<Data | null>(null);
  const [failed, setFailed] = useState(false);

  const fetchProfile = useCallback(
    (isLive: () => boolean = () => true) =>
      Promise.all([
        loadDisplayName(userId),
        loadTastePrior(userId),
        loadCompanions(userId),
        loadCategories(),
        loadMeals(userId),
      ])
        .then(([name, prior, companions, categories, meals]) => {
          if (!isLive()) return;
          setData({ name, prior, companions, categories, mostEaten: mostEatenCategory(meals) });
          setFailed(false);
        })
        .catch(() => isLive() && setFailed(true)),
    [userId],
  );

  useFocusEffect(
    useCallback(() => {
      let live = true;
      fetchProfile(() => live);
      return () => {
        live = false;
      };
    }, [fetchProfile]),
  );

  if (!data) {
    return (
      <GlassScreen tabBar>
        <View style={[styles.center, { paddingBottom: space }]}>
          {failed ? (
            <>
              <Text style={styles.muted}>Couldn&apos;t load.</Text>
              <PrimaryButton label="Retry" onPress={() => fetchProfile()} />
            </>
          ) : (
            <ActivityIndicator />
          )}
        </View>
      </GlassScreen>
    );
  }

  const names = new Map(data.categories.map((c) => [c.id, c.name]));
  const budget = BUDGETS.find((b) => b.level === data.prior.budget);
  const usually =
    data.prior.mostlySolo === null ? null : data.prior.mostlySolo ? 'Solo' : 'With people';

  return (
    <GlassScreen tabBar>
      <ScrollView
        contentContainerStyle={[styles.scroll, { paddingBottom: space }]}
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.top}>
          <View style={styles.avatar}>
            <Text style={styles.avatarText}>{initials(data.name)}</Text>
          </View>
          <Text style={styles.name}>{data.name ?? ''}</Text>
        </View>

        <GlassCard>
          <Section label="Favorites">
            <View style={styles.chips}>
              {data.prior.favorites.map((id) => (
                <Chip key={id} label={`${emojiFor(id)} ${names.get(id) ?? id}`} />
              ))}
            </View>
          </Section>
          <Section label="Most eaten">
            <Text style={data.mostEaten ? styles.value : styles.muted}>
              {data.mostEaten
                ? `${emojiFor(data.mostEaten)} ${names.get(data.mostEaten) ?? data.mostEaten}`
                : 'Not enough meals yet'}
            </Text>
          </Section>
          {budget && (
            <Section label="Budget">
              <Text style={styles.value}>{`${budget.label} · ${budget.detail}`}</Text>
            </Section>
          )}
          {usually && (
            <Section label="Usually">
              <Text style={styles.value}>{usually}</Text>
            </Section>
          )}
          <Section label="Eats with">
            <Text style={data.companions.length ? styles.value : styles.muted}>
              {data.companions.length ? data.companions.join(', ') : 'No one yet'}
            </Text>
          </Section>
        </GlassCard>

        <PrimaryButton label="Sign out" onPress={onSignOut} />
      </ScrollView>
    </GlassScreen>
  );
}

const AVATAR = 88;

const styles = StyleSheet.create({
  center: {
    flex: 1,
    justifyContent: 'center',
    gap: spacing.lg,
  },
  scroll: {
    gap: spacing.xl,
    paddingBottom: spacing.lg,
  },
  top: {
    alignItems: 'center',
    gap: spacing.md,
    marginTop: spacing.lg,
  },
  avatar: {
    width: AVATAR,
    height: AVATAR,
    borderRadius: AVATAR / 2,
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarText: {
    fontSize: 32,
    fontWeight: '700',
    color: colors.onAccent,
  },
  name: {
    fontSize: type.heading,
    fontWeight: '600',
    color: colors.text,
  },
  section: {
    gap: spacing.sm,
  },
  label: {
    fontSize: type.caption,
    fontWeight: '600',
    color: colors.textSecondary,
    textTransform: 'uppercase',
    letterSpacing: 0.6,
  },
  value: {
    fontSize: type.body,
    color: colors.text,
  },
  muted: {
    fontSize: type.body,
    color: colors.textSecondary,
    textAlign: 'left',
  },
  chips: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
  },
});
