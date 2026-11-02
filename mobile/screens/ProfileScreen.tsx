import { useFocusEffect } from '@react-navigation/native';
import { type ReactNode, useCallback, useRef, useState } from 'react';
import { ActivityIndicator, Modal, ScrollView, StyleSheet, Text, View } from 'react-native';

import { Chip, GlassCard, GlassScreen, PrimaryButton, SecondaryButton, useTabBarSpace } from '../components/ui';
import { getInsights } from '../lib/api';
import { type InsightsState, loadInsights, localInsightsDate } from '../lib/insights';
import {
  BUDGETS,
  type Category,
  loadCategories,
  loadCompanions,
  loadCompanionChoices,
  loadDisplayName,
  loadTastePrior,
  type TastePrior,
} from '../lib/profile';
import { colors, emojiFor, spacing, type } from '../theme';
import InsightsScreen from './InsightsScreen';

// Read-only profile (P1-22). Editing is a later ticket.

type Data = {
  name: string | null;
  prior: TastePrior;
  companions: string[];
  categories: Category[];
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
  const [insights, setInsights] = useState<InsightsState>({ status: 'loading' });
  const [showInsights, setShowInsights] = useState(false);
  const insightRequest = useRef(0);

  const refreshInsights = useCallback(async (categories: Category[]) => {
    const requestId = ++insightRequest.current;
    setInsights({ status: 'loading' });
    const state = await loadInsights(localInsightsDate(), getInsights,
      () => loadCompanionChoices(userId), categories);
    if (requestId === insightRequest.current) setInsights(state);
  }, [userId]);

  const fetchProfile = useCallback(
    (isLive: () => boolean = () => true) =>
      Promise.all([
        loadDisplayName(userId),
        loadTastePrior(userId),
        loadCompanions(userId),
        loadCategories(),
      ])
        .then(([name, prior, companions, categories]) => {
          if (!isLive()) return;
          setData({ name, prior, companions, categories });
          setFailed(false);
          void refreshInsights(categories);
        })
        .catch(() => {
          if (!isLive()) return;
          setFailed(true);
          setInsights({ status: 'unavailable' });
        }),
    [userId, refreshInsights],
  );

  useFocusEffect(
    useCallback(() => {
      let live = true;
      setInsights({ status: 'loading' });
      fetchProfile(() => live);
      return () => {
        live = false;
        insightRequest.current++;
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
          {insights.status === 'ready' && <Section label="Most eaten">
            <Text style={insights.mostEatenIds.length ? styles.value : styles.muted}>
              {insights.mostEatenIds.length ? insights.mostEatenIds.map((id) =>
                `${emojiFor(id)} ${names.get(id) ?? id}`).join(', ')
                : insights.response.complete ? 'No food saved' : 'No usable data'}
            </Text>
            {insights.note && <Text style={styles.muted}>{insights.note}</Text>}
          </Section>}
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

        <SecondaryButton label="Insights" onPress={() => setShowInsights(true)} />
        <PrimaryButton label="Sign out" onPress={onSignOut} />
      </ScrollView>
      <Modal visible={showInsights} animationType="slide" presentationStyle="fullScreen"
        onRequestClose={() => setShowInsights(false)}>
        <InsightsScreen state={insights} onClose={() => setShowInsights(false)}
          onRefresh={() => { void refreshInsights(data.categories); }} />
      </Modal>
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
