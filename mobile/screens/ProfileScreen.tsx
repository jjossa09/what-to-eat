import { useFocusEffect } from '@react-navigation/native';
import { type ReactNode, useCallback, useRef, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';

import ScrollWithBar from '../components/ScrollWithBar';
import { PreferenceFields } from '../components/CompanionCards';
import { Chip, GlassCard, GlassScreen, PrimaryButton, SecondaryButton, useTabBarSpace } from '../components/ui';
import { companionCall, getInsights } from '../lib/api';
import { profileDraft, type Profile, type ProfileDraft } from '../lib/companionActions';
import { type InsightsState, loadInsights, localInsightsDate, withInsightsDeadline } from '../lib/insights';
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
import { chart, colors, emojiFor, spacing, type } from '../theme';
import InsightsScreen from './InsightsScreen';

// Profile and taste editing share the confirmed, version-checked preference writer with chat.

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

export default function ProfileScreen({ userId, onSignOut, showInsights, onInsightsChange }: {
  userId: string; onSignOut: () => void; showInsights: boolean; onInsightsChange: (show: boolean) => void;
}) {
  const space = useTabBarSpace();
  const [data, setData] = useState<Data | null>(null);
  const [failed, setFailed] = useState(false);
  const [insights, setInsights] = useState<InsightsState>({ status: 'loading' });
  const insightRequest = useRef(0);
  const [editing, setEditing] = useState<ProfileDraft | null>(null);
  const [editBusy, setEditBusy] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);
  const editLock = useRef(false);
  async function openEditor() {
    if (editLock.current) return;
    editLock.current = true; setEditBusy(true); setEditError(null);
    try { setEditing(profileDraft(await companionCall<Profile>('/conversation/profile'), 'profile')); }
    catch { setEditError("Couldn't load your taste profile."); }
    finally { editLock.current = false; setEditBusy(false); }
  }
  async function saveEditor() {
    if (!editing || editLock.current) return;
    editLock.current = true; setEditBusy(true); setEditError(null);
    try {
      await companionCall('/profile/preferences', editing);
      setEditing(null);
      void withInsightsDeadline(() => fetchProfile(), 5000).catch(() => setFailed(true));
    } catch { setEditError("Couldn't save. If your profile changed, cancel and reopen."); }
    finally { editLock.current = false; setEditBusy(false); }
  }

  const refreshInsights = useCallback(async (categories: Category[]) => {
    const requestId = ++insightRequest.current;
    setInsights({ status: 'loading' });
    const state = await loadInsights(localInsightsDate(), getInsights,
      () => loadCompanionChoices(userId), categories, chart.categories);
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

  if (showInsights) {
    return <InsightsScreen state={insights} onClose={() => onInsightsChange(false)}
      onRefresh={() => { void refreshInsights(data.categories); }} />;
  }

  const names = new Map(data.categories.map((c) => [c.id, c.name]));
  const budget = BUDGETS.find((b) => b.level === data.prior.budget);
  const usually =
    data.prior.mostlySolo === null ? null : data.prior.mostlySolo ? 'Solo' : 'With people';

  return (
    <GlassScreen tabBar>
      <ScrollWithBar
        contentContainerStyle={[styles.scroll, { paddingBottom: space }]}
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

        <SecondaryButton label="Insights" onPress={() => onInsightsChange(true)} />
        {editing ? <GlassCard>
          <PreferenceFields value={editing} onChange={setEditing} categories={data.categories} disabled={editBusy} />
          <PrimaryButton label="Confirm changes" feedback={false} onPress={saveEditor} busy={editBusy}
            disabled={editing.favorites.length < 1 || editing.favorites.length > 5} />
          <SecondaryButton label="Cancel" disabled={editBusy} onPress={() => { setEditing(null); setEditError(null); }} />
        </GlassCard> : <SecondaryButton label="Edit taste quiz" disabled={editBusy} onPress={openEditor} />}
        {editError && <Text accessibilityLiveRegion="polite" style={styles.muted}>{editError}</Text>}
        <PrimaryButton label="Sign out" onPress={onSignOut} />
      </ScrollWithBar>
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
