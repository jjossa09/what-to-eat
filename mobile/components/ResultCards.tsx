import { useRef, useState } from 'react';
import { Linking, StyleSheet, Text, View } from 'react-native';

import { ApiError, logInterested, logNone, logPicked, type Pick } from '../lib/api';
import type { Position } from '../lib/location';
import { directionsUrl } from '../lib/places';
import { colors, emojiFor, radii, spacing, type } from '../theme';
import { Attribution, MiniMap } from './PlaceMap';
import PressScale from './PressScale';
import { Chip, GlassCard, TextLink } from './ui';

// The round's 3 picks as glass cards with a mini map (P1-13, FR8). Funnel events (ML8):
// card tap and Directions log "interested"; Pick this / None of these record the decision.

const METERS_PER_MILE = 1609.344;

function miles(meters: number): string {
  return `${Math.max(0.1, meters / METERS_PER_MILE).toFixed(1)} mi`;
}

type Decision = 'open' | 'saving' | 'done';

type Props = {
  picks: Pick[];
  user: Position | null;
  /** Null when the round was not logged: then picks can't be recorded, so those buttons hide. */
  sessionId: string | null;
  round: number | null;
  /** Adds one assistant line to the chat (confirmations). */
  onSay: (text: string) => void;
  /** After a pick is recorded (or was already): sets up the feedback reminder (P1-16). */
  onPicked: () => void;
  /** After Pick this or None of these is saved: the chat stops offering follow-ups. */
  onDecided?: () => void;
  /** An earlier round (P1-14): cards and Directions stay, the decision buttons hide. */
  readOnly?: boolean;
};

export default function ResultCards({
  picks,
  user,
  sessionId,
  round,
  onSay,
  onPicked,
  onDecided,
  readOnly = false,
}: Props) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [decision, setDecision] = useState<Decision>('open');
  const [failed, setFailed] = useState<(() => void) | null>(null);
  const interested = useRef(new Set<string>());
  const canRecord = !readOnly && sessionId !== null && round !== null;

  function logInterest(placeId: string, kind: 'card' | 'directions') {
    if (sessionId === null || round === null) return;
    const key = `${kind}:${placeId}`;
    if (interested.current.has(key)) return;
    interested.current.add(key);
    // Background only: a failed funnel event never interrupts the user.
    logInterested(sessionId, round, placeId, kind).catch(() => interested.current.delete(key));
  }

  function select(p: Pick) {
    setSelectedId(p.id);
    logInterest(p.id, 'card');
  }

  function directions(p: Pick) {
    logInterest(p.id, 'directions');
    Linking.openURL(directionsUrl(p.lat, p.lon));
  }

  async function decide(save: () => Promise<unknown>, done: string, after?: () => void) {
    setDecision('saving');
    setFailed(null);
    try {
      await save();
      setDecision('done');
      onSay(done);
      onDecided?.();
      after?.();
    } catch (e) {
      if (e instanceof ApiError && e.kind === 'conflict') {
        setDecision('done');
        onSay('Already saved.');
        onDecided?.();
        after?.();
      } else {
        setDecision('open');
        setFailed(() => () => decide(save, done, after));
      }
    }
  }

  function pick(p: Pick) {
    if (!canRecord || sessionId === null || round === null || decision !== 'open') return;
    setSelectedId(p.id);
    decide(() => logPicked(sessionId, round, p.id), `Enjoy ${p.name}!`, onPicked);
  }

  function none() {
    if (!canRecord || sessionId === null || decision !== 'open') return;
    decide(() => logNone(sessionId), 'Got it, no pick this time.');
  }

  const open = decision === 'open';

  return (
    <View style={styles.wrap}>
      <MiniMap places={picks} user={user} selectedId={selectedId} />
      {picks.map((p) => (
        <PressScale key={p.id} onPress={() => select(p)} accessibilityRole="button">
          <GlassCard style={p.id === selectedId ? styles.selected : undefined}>
            <View style={styles.top}>
              <Text style={styles.name} numberOfLines={1}>
                {emojiFor(p.category)} {p.name}
              </Text>
              <Text style={styles.distance}>{miles(p.distance_m)}</Text>
            </View>
            <Text style={styles.reason}>{p.reason}</Text>
            <View style={styles.actions}>
              {canRecord && open && <Chip label="Pick this" onPress={() => pick(p)} />}
              <Chip label="Directions" onPress={() => directions(p)} />
            </View>
          </GlassCard>
        </PressScale>
      ))}
      {failed && (
        <View style={styles.problem}>
          <Text style={styles.problemText}>Couldn&apos;t save. Try again.</Text>
          <Chip label="Try again" onPress={failed} />
        </View>
      )}
      {canRecord && open && !failed && (
        <View style={styles.center}>
          <TextLink label="None of these" onPress={none} />
        </View>
      )}
      {/* Once under the results: only the latest round shows it. */}
      {!readOnly && <Attribution quiet />}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    gap: spacing.md,
  },
  selected: {
    borderColor: colors.accent,
    borderRadius: radii.card,
  },
  top: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: spacing.md,
  },
  name: {
    flex: 1,
    fontSize: type.body,
    fontWeight: '600',
    color: colors.text,
  },
  distance: {
    fontSize: type.small,
    color: colors.textSecondary,
  },
  reason: {
    fontSize: type.small,
    color: colors.text,
    marginTop: -spacing.sm,
  },
  actions: {
    flexDirection: 'row',
    gap: spacing.sm,
  },
  problem: {
    gap: spacing.sm,
    alignItems: 'flex-start',
  },
  problemText: {
    fontSize: type.small,
    color: colors.error,
  },
  center: {
    alignItems: 'center',
  },
});
