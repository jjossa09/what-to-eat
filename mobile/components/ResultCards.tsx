import { useEffect, useRef, useState } from 'react';
import { Animated, Linking, StyleSheet, Text, View } from 'react-native';

import { useReduceMotion } from '../lib/accessibility';
import { haptic } from '../lib/haptics';
import { ApiError, getReasons, logInterested, logNone, logPicked, type Pick } from '../lib/api';
import type { Position } from '../lib/location';
import { directionsUrl } from '../lib/places';
import { type ReasonsCache, swapReason, type ReasonsEnvelope, type ReasonsObserver } from '../lib/reasons';
import { colors, emojiFor, radii, spacing, type } from '../theme';
import { Attribution, MiniMap } from './PlaceMap';
import PressScale from './PressScale';
import { Chip, GlassCard } from './ui';

// The round's 3 picks as glass cards with a mini map (P1-13, FR8). Funnel events (ML8):
// card tap and Directions log "interested"; Pick this records the decision. None of these
// (P2-05): before the cap it hands over to the chat (a refinement question, session stays
// open, no call); on the cap round (final) it records the session's outcome as none.

const METERS_PER_MILE = 1609.344;

function miles(meters: number): string {
  return `${Math.max(0.1, meters / METERS_PER_MILE).toFixed(1)} mi`;
}

type Decision = 'open' | 'saving' | 'done';

type Props = {
  envelope?: ReasonsEnvelope | null;
  reasonsCache: ReasonsCache;
  generation: number;
  userId: string;
  /** False rejects a stale/busy press; the optional guard owns only chat updates,
   * never the save itself. Void preserves callers without conversation ownership. */
  onDecisionStart: () => false | (() => boolean) | void;
  lifecycle?: ReasonsObserver;
  active?: boolean;
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
  /** The cap round (best so far): None of these ends the session as none. */
  final?: boolean;
  /** Before the cap: None of these asks the chat for a refinement question instead. False
   * when the chat is busy: the buttons stay so the user can tap again. */
  onNoneOfThese?: () => boolean;
};

export default function ResultCards({
  picks,
  envelope, reasonsCache, generation, userId, onDecisionStart,
  lifecycle, active = true,
  user,
  sessionId,
  round,
  onSay,
  onPicked,
  onDecided,
  readOnly = false,
  final = false,
  onNoneOfThese,
}: Props) {
  const [enhanced, setEnhanced] = useState<Record<string, string>>({});
  useEffect(() => {
    if (envelope && sessionId && round !== null && !final && !readOnly
      && reasonsCache.isCurrent(generation)) {
      return reasonsCache.watch(`${userId}:${sessionId}:${round}`, picks.map((p) => p.id),
        generation, () => getReasons(envelope), (result) => {
          lifecycle?.accepted();
          setEnhanced((previous) => Object.keys(previous).length === result.reasons.length
            && result.reasons.every((r) => previous[r.id] === r.line) ? previous
            : Object.fromEntries(result.reasons.map((r) => [r.id, r.line])));
        }, () => lifecycle?.fallback());
    }
    if (!readOnly && reasonsCache.isCurrent(generation)) lifecycle?.fallback();
  }, [envelope, sessionId, round, final, readOnly, reasonsCache, generation, userId, picks, lifecycle]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [decision, setDecision] = useState<Decision>('open');
  const [failed, setFailed] = useState<{ message: string; retry?: () => void } | null>(null);
  const interested = useRef(new Set<string>());
  const interaction = useRef({ mounted: true, active, busy: false, selected: null as string | null });
  useEffect(() => { interaction.current.active = active && !readOnly; }, [active, readOnly]);
  useEffect(() => {
    const current = interaction.current;
    current.mounted = true;
    return () => { current.mounted = false; };
  }, []);
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
    if (!readOnly && interaction.current.selected !== p.id) haptic('selection');
    interaction.current.selected = p.id;
    setSelectedId(p.id);
    logInterest(p.id, 'card');
  }

  function directions(p: Pick) {
    logInterest(p.id, 'directions');
    Linking.openURL(directionsUrl(p.lat, p.lon));
  }

  function decide(save: () => Promise<unknown>, done: string, after?: () => void) {
    if (interaction.current.busy || !interaction.current.mounted) return;
    const current = onDecisionStart();
    if (current === false) return;

    // Retries retain the original request and chat ownership. They must never
    // cancel reasons or claim a conversation that has since moved on.
    async function attempt() {
      if (interaction.current.busy || !interaction.current.mounted) return;
      interaction.current.busy = true;
      setDecision('saving');
      setFailed(null);
      try {
        await save();
      } catch (e) {
        if (!interaction.current.mounted) return;
        if (e instanceof ApiError && e.kind === 'conflict') {
          setDecision('done');
          setFailed({ message: 'Search already decided.' });
          // This search is closed, but this choice was not saved. Never celebrate
          // or schedule its reminder; an older conflict cannot end newer chat.
          if (!current || current()) onDecided?.();
        }
        else {
          setDecision('open');
          interaction.current.busy = false;
          setFailed({ message: "Couldn't save. Try again.", retry: attempt });
        }
        return;
      }
      if (!interaction.current.mounted) return;
      setDecision('done');
      if (!current || current()) {
        if (interaction.current.active) haptic('success');
        onSay(done);
        onDecided?.();
      }
      // A changed conversation cannot discard the recorded pick's reminder.
      after?.();
    }
    void attempt();
  }

  function pick(p: Pick) {
    if (!canRecord || sessionId === null || round === null || decision !== 'open') return;
    interaction.current.selected = p.id;
    setSelectedId(p.id);
    decide(() => logPicked(sessionId, round, p.id), `Enjoy ${p.name}!`, onPicked);
  }

  /** Before the cap: hand over to the chat, nothing saved. On the cap round: outcome none. */
  const refines = !final && onNoneOfThese !== undefined;

  function none() {
    if (readOnly || decision !== 'open') return;
    if (refines) {
      if (!interaction.current.busy && onNoneOfThese?.()) {
        interaction.current.busy = true;
        haptic('light');
        setDecision('done');
      }
      return;
    }
    if (!canRecord || sessionId === null) return;
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
            <ReasonText id={p.id} template={p.reason} enhanced={enhanced[p.id]}
              cache={reasonsCache} generation={generation} lifecycle={lifecycle} active={active} />
            <View style={styles.actions}>
              {canRecord && open && <Chip label="Pick this" feedback={false} onPress={() => pick(p)} />}
              <Chip label="Directions" onPress={() => directions(p)} />
            </View>
          </GlassCard>
        </PressScale>
      ))}
      {failed && (
        <View style={styles.problem}>
          <Text style={styles.problemText}>{failed.message}</Text>
          {failed.retry && <Chip label="Try again" feedback={false} onPress={failed.retry} />}
        </View>
      )}
      {open && !failed && (refines ? !readOnly : canRecord) && (
        <View style={styles.center}>
          <Chip label="None of these" feedback={false} onPress={none} />
        </View>
      )}
      {/* Once under the results: only the latest round shows it. */}
      {!readOnly && <Attribution quiet />}
    </View>
  );
}

function ReasonText({ id, template, enhanced, cache, generation, lifecycle, active }: {
  id: string; template: string; enhanced?: string; cache: ReasonsCache; generation: number;
  lifecycle?: ReasonsObserver; active: boolean;
}) {
  const reduceMotion = useReduceMotion(true);
  const [display, setDisplay] = useState({ line: template, finished: false });
  const completed = useRef<string | null>(null);
  const [opacity] = useState(() => new Animated.Value(1));
  useEffect(() => {
    opacity.setValue(1);
    if (!enhanced || enhanced === template || completed.current === enhanced) return;
    const stop = swapReason(reduceMotion || !active, () => cache.isCurrent(generation),
      () => setDisplay({ line: enhanced, finished: false }), (toValue, duration, done) => {
        const animation = Animated.timing(opacity, { toValue, duration, useNativeDriver: true });
        animation.start(({ finished }) => { if (finished) done(); });
        return () => animation.stop();
      }, () => {
        completed.current = enhanced;
        setDisplay({ line: enhanced, finished: true });
      });
    return () => { stop(); opacity.setValue(1); };
  }, [enhanced, template, reduceMotion, active, cache, generation, opacity]);
  // Effects run after the text commit, including immediate and unchanged replacements.
  useEffect(() => {
    if (enhanced && display.line === enhanced && (enhanced === template || display.finished)
      && cache.isCurrent(generation) && lifecycle?.current()) {
      lifecycle.displayed(id);
    }
  }, [display, enhanced, template, cache, generation, lifecycle, id]);
  return <Animated.Text style={[styles.reason, { opacity }]}>{display.line}</Animated.Text>;
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
