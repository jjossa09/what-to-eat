import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Linking, ScrollView, type ScrollViewInstance, StyleSheet, Text, View } from 'react-native';

import {
  ApiError,
  deviceTimezone,
  getRecommendations,
  localTimeIso,
  type Pick,
  type RoundRequest,
  type TranscriptMessage,
} from '../lib/api';
import { getPosition, type LocationResult } from '../lib/location';
import { type Category, loadCategories, loadTastePrior, type TastePrior } from '../lib/profile';
import { colors, emojiFor, radii, type } from '../theme';
import { Chip, GlassCard, GlassScreen } from './ui';

// Chat (P1-09) with the fixed Phase 1 questions (P1-10): craving, budget, distance.
// Company is not asked: it comes from the quiz prior (mostly_solo). One question per message (R1).

type Step = 'craving' | 'budget' | 'distance' | 'loading' | 'results' | 'error';
type Problem = 'denied' | 'nofix' | 'network' | 'server' | 'auth' | 'load';
type Bubble = { id: number; role: 'assistant' | 'user'; text: string };
type Radius = RoundRequest['radius_m'];

const QUESTIONS = {
  craving: 'What are you craving?',
  budget: 'Budget this time?',
  distance: 'How far?',
} as const;

const BUDGETS = [
  { level: 1, label: '$' },
  { level: 2, label: '$$' },
  { level: 3, label: '$$$' },
  { level: 4, label: '$$$$' },
] as const;

const DISTANCES: { radius: Radius; label: string }[] = [
  { radius: 1500, label: 'Walk' },
  { radius: 5000, label: 'Short drive' },
  { radius: 15000, label: 'Worth the drive' },
];

const PROBLEM_TEXT: Record<Problem, string> = {
  denied: 'Location is off.',
  nofix: "Couldn't find you.",
  network: "Couldn't reach the server.",
  server: "Couldn't get picks.",
  auth: 'Please sign in again.',
  load: "Couldn't load.",
};

const METERS_PER_MILE = 1609.344;
const OSM_COPYRIGHT = 'https://www.openstreetmap.org/copyright';

function miles(meters: number): string {
  return `${Math.max(0.1, meters / METERS_PER_MILE).toFixed(1)} mi`;
}

type ChatProps = {
  userId: string;
  onSignOut: () => void;
  /** Space kept clear for the floating tab bar. */
  bottom: number;
};

export default function Chat({ userId, onSignOut, bottom }: ChatProps) {
  const [categories, setCategories] = useState<Category[] | null>(null);
  const [prior, setPrior] = useState<TastePrior | null>(null);
  const [bubbles, setBubbles] = useState<Bubble[]>([]);
  const [step, setStep] = useState<Step>('craving');
  const [problem, setProblem] = useState<Problem | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [picks, setPicks] = useState<Pick[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(null);

  const transcript = useRef<TranscriptMessage[]>([]);
  const answers = useRef<{ craving: string | null; budget: number; radius: Radius }>({
    craving: null,
    budget: 2,
    radius: 1500,
  });
  const location = useRef<Promise<LocationResult> | null>(null);
  const nextId = useRef(0);
  const scroll = useRef<ScrollViewInstance>(null);

  function say(role: Bubble['role'], text: string) {
    nextId.current += 1;
    const id = nextId.current;
    setBubbles((prev) => [...prev, { id, role, text }]);
  }

  function ask(key: keyof typeof QUESTIONS) {
    say('assistant', QUESTIONS[key]);
    transcript.current.push({ role: 'assistant', body: QUESTIONS[key], question_key: key });
  }

  function answer(
    key: keyof typeof QUESTIONS,
    label: string,
    value: TranscriptMessage['answer'],
    mode: 'chip' | 'prefill' = 'chip',
  ) {
    say('user', label);
    transcript.current.push({ role: 'user', body: label, question_key: key, answer: value, input_mode: mode });
  }

  // Start: the prior and categories for the chips, and location in the background so it is
  // usually ready by the third answer.
  useEffect(() => {
    let live = true;
    location.current = getPosition();
    Promise.all([loadCategories(), loadTastePrior(userId)])
      .then(([rows, quiz]) => {
        if (!live) return;
        setCategories(rows);
        setPrior(quiz);
        if (quiz.budget) answers.current.budget = quiz.budget;
        nextId.current += 1;
        setBubbles([{ id: nextId.current, role: 'assistant', text: QUESTIONS.craving }]);
        transcript.current = [{ role: 'assistant', body: QUESTIONS.craving, question_key: 'craving' }];
      })
      .catch(() => {
        if (!live) return;
        setProblem('load');
        setStep('error');
      });
    return () => {
      live = false;
    };
  }, [userId]);

  function chooseCraving(id: string | null, label: string) {
    answers.current.craving = id;
    answer('craving', label, { craving: id });
    ask('budget');
    setStep('budget');
  }

  function chooseBudget(level: number, label: string) {
    answers.current.budget = level;
    answer('budget', label, { budget_level: level }, prior?.budget === level ? 'prefill' : 'chip');
    ask('distance');
    setStep('distance');
  }

  function chooseDistance(radius: Radius, label: string) {
    answers.current.radius = radius;
    answer('distance', label, { radius_m: radius });
    fetchRound();
  }

  async function fetchRound() {
    setProblem(null);
    setStep('loading');
    const where = await (location.current ?? getPosition());
    if (!where.ok) {
      location.current = null; // the next try asks again
      setProblem(where.reason === 'denied' ? 'denied' : 'nofix');
      setStep('error');
      return;
    }
    try {
      const round = await getRecommendations({
        lat: where.position.lat,
        lon: where.position.lon,
        local_time: localTimeIso(),
        timezone: deviceTimezone(),
        craving: answers.current.craving,
        budget_level: answers.current.budget,
        radius_m: answers.current.radius,
        solo: prior?.mostlySolo ?? null,
        ...(sessionId ? { session_id: sessionId } : {}),
        exclude_ids: [],
        transcript: sessionId ? [] : transcript.current,
      });
      if (!round.logged && __DEV__) console.warn('Round not logged');
      if (round.session_id) setSessionId(round.session_id);
      setPicks(round.picks);
      say('assistant', round.picks.length ? 'Here are 3 spots.' : 'No spots nearby.');
      setStep('results');
    } catch (e) {
      setProblem(e instanceof ApiError ? e.kind : 'network');
      setStep('error');
    }
  }

  function retry() {
    if (problem === 'auth') {
      onSignOut();
    } else if (problem === 'load') {
      setProblem(null);
      setStep('craving');
      Promise.all([loadCategories(), loadTastePrior(userId)])
        .then(([rows, quiz]) => {
          setCategories(rows);
          setPrior(quiz);
          if (quiz.budget) answers.current.budget = quiz.budget;
          ask('craving');
        })
        .catch(() => {
          setProblem('load');
          setStep('error');
        });
    } else {
      fetchRound();
    }
  }

  const names = new Map((categories ?? []).map((c) => [c.id, c.name]));
  const favorites = (prior?.favorites ?? []).filter((id) => names.has(id));

  let controls = null;
  if (step === 'craving' && categories) {
    const list = showAll ? categories.map((c) => c.id) : favorites;
    controls = (
      <View style={styles.chips}>
        {list.map((id) => (
          <Chip key={id} label={names.get(id) ?? id} onPress={() => chooseCraving(id, names.get(id) ?? id)} />
        ))}
        <Chip label="Anything" onPress={() => chooseCraving(null, 'Anything')} />
        {!showAll && <Chip label="More" onPress={() => setShowAll(true)} />}
      </View>
    );
  } else if (step === 'budget') {
    controls = (
      <View style={styles.chips}>
        {BUDGETS.map((b) => (
          <Chip
            key={b.level}
            label={b.label}
            selected={prior?.budget === b.level}
            onPress={() => chooseBudget(b.level, b.label)}
          />
        ))}
      </View>
    );
  } else if (step === 'distance') {
    controls = (
      <View style={styles.chips}>
        {DISTANCES.map((d) => (
          <Chip key={d.radius} label={d.label} onPress={() => chooseDistance(d.radius, d.label)} />
        ))}
      </View>
    );
  } else if (step === 'error' && problem) {
    controls = (
      <View style={styles.problem}>
        <Text style={styles.problemText}>{PROBLEM_TEXT[problem]}</Text>
        <View style={styles.chips}>
          {problem === 'denied' && <Chip label="Open Settings" onPress={() => Linking.openSettings()} />}
          <Chip label={problem === 'auth' ? 'Sign in' : 'Try again'} onPress={retry} />
        </View>
      </View>
    );
  }

  return (
    <GlassScreen tabBar>
      <ScrollView
        ref={scroll}
        // Without chips below, the thread scrolls behind the tab bar and ends above it.
        contentContainerStyle={[styles.thread, !controls && { paddingBottom: bottom }]}
        onContentSizeChange={() => scroll.current?.scrollToEnd({ animated: true })}
      >
        {!categories && step !== 'error' && <ActivityIndicator style={styles.spinner} />}
        {bubbles.map((b) => (
          <View key={b.id} style={[styles.bubble, b.role === 'user' ? styles.mine : styles.theirs]}>
            <Text style={[styles.bubbleText, b.role === 'user' && styles.mineText]}>{b.text}</Text>
          </View>
        ))}
        {step === 'loading' && (
          <View style={[styles.bubble, styles.theirs]}>
            <Text style={styles.bubbleText}>Finding spots…</Text>
          </View>
        )}
        {step === 'results' && picks.length > 0 && (
          <GlassCard>
            {picks.map((p) => (
              <View key={p.id} style={styles.pick}>
                <View style={styles.pickTop}>
                  <Text style={styles.pickName} numberOfLines={1}>
                    {emojiFor(p.category)} {p.name}
                  </Text>
                  <Text style={styles.pickDistance}>{miles(p.distance_m)}</Text>
                </View>
                <Text style={styles.pickReason}>{p.reason}</Text>
              </View>
            ))}
            <Text style={styles.attribution}>
              Powered by Geoapify ·{' '}
              <Text style={styles.link} onPress={() => Linking.openURL(OSM_COPYRIGHT)}>
                © OpenStreetMap contributors
              </Text>
            </Text>
          </GlassCard>
        )}
      </ScrollView>
      {controls && <View style={[styles.controls, { marginBottom: bottom }]}>{controls}</View>}
    </GlassScreen>
  );
}

const styles = StyleSheet.create({
  thread: {
    gap: 10,
    paddingBottom: 16,
  },
  spinner: {
    marginTop: 24,
  },
  bubble: {
    maxWidth: '80%',
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderRadius: radii.bubble,
  },
  theirs: {
    alignSelf: 'flex-start',
    backgroundColor: colors.glass,
    borderWidth: 1,
    borderColor: colors.glassBorder,
  },
  mine: {
    alignSelf: 'flex-end',
    backgroundColor: colors.text,
  },
  bubbleText: {
    fontSize: type.body,
    color: colors.text,
  },
  mineText: {
    color: colors.textInverse,
  },
  pick: {
    gap: 2,
  },
  pickTop: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: 12,
  },
  pickName: {
    flex: 1,
    fontSize: 16,
    fontWeight: '600',
    color: colors.text,
  },
  pickDistance: {
    fontSize: 15,
    color: colors.textSecondary,
  },
  pickReason: {
    fontSize: 15,
    color: colors.text,
  },
  attribution: {
    fontSize: 12,
    color: colors.textSecondary,
  },
  link: {
    textDecorationLine: 'underline',
  },
  controls: {
    paddingTop: 12,
  },
  chips: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  problem: {
    gap: 10,
  },
  problemText: {
    fontSize: 15,
    color: colors.error,
  },
});
