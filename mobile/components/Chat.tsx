import { Fragment, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Linking,
  ScrollView,
  type ScrollViewInstance,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import {
  ApiError,
  type Change,
  deviceTimezone,
  getRecommendations,
  localTimeIso,
  parseAnswer,
  type Pick,
  type QuestionKey,
  type RoundRequest,
  type RoundResponse,
  type TranscriptMessage,
} from '../lib/api';
import { getPosition, type LocationResult, type Position } from '../lib/location';
import { remindAfterPick } from '../lib/notify';
import { type Category, loadCategories, loadTastePrior, type TastePrior } from '../lib/profile';
import { colors, radii, spacing, type } from '../theme';
import Composer from './Composer';
import ResultCards from './ResultCards';
import { Chip, GlassScreen } from './ui';

// Chat (P1-09) with the fixed Phase 1 questions (P1-10): craving, budget, distance.
// Company is not asked: it comes from the quiz prior (mostly_solo). One question per message (R1).
// Typed answers are parsed by Muse into the same answers as the chips (P1-21). After a round,
// the chat stays open: Cheaper / Closer / Something else or a typed follow-up runs a new round
// that skips every place already shown (P1-14). Round 4 without a pick is the best so far.

type Step = 'craving' | 'budget' | 'distance' | 'loading' | 'results' | 'error';
type FirstKey = 'craving' | 'budget' | 'distance';
type Problem = 'denied' | 'nofix' | 'network' | 'server' | 'auth' | 'load';
type Bubble = { id: number; role: 'assistant' | 'user'; text: string };
type Radius = RoundRequest['radius_m'];
type Round = { bubbleId: number; picks: Pick[]; sessionId: string | null; round: number | null };
type Answers = { craving: string | null; budget: number; radius: Radius; exclude: string[] };

const QUESTIONS = {
  craving: 'What are you craving?',
  budget: 'Budget this time?',
  distance: 'How far?',
  open: 'What would make it right?',
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

const FOLLOW_UPS: { label: string; change: Partial<Change> }[] = [
  { label: 'Cheaper', change: { budget: 'cheaper' } },
  { label: 'Closer', change: { distance: 'closer' } },
  { label: 'Something else', change: { something_else: true } },
];

const PROBLEM_TEXT: Record<Problem, string> = {
  denied: 'Location is off.',
  nofix: "Couldn't find you.",
  network: "Couldn't reach the server.",
  server: "Couldn't get picks.",
  auth: 'Please sign in again.',
  load: "Couldn't load.",
};

function isRadius(value: number | null): value is Radius {
  return DISTANCES.some((d) => d.radius === value);
}

function isFirst(step: Step): step is FirstKey {
  return step === 'craving' || step === 'budget' || step === 'distance';
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
  const [rounds, setRounds] = useState<Round[]>([]);
  const [user, setUser] = useState<Position | null>(null);
  const [decided, setDecided] = useState(false);
  const [parsing, setParsing] = useState(false);
  // Pre-selected chips for later questions, from a typed answer that covered them (FR4).
  const [preset, setPreset] = useState<{ budget?: number; radius?: Radius }>({});

  // Unsent chat lines: sent with the next round, then cleared (R3).
  const transcript = useRef<TranscriptMessage[]>([]);
  const answers = useRef<Answers>({ craving: null, budget: 2, radius: 1500, exclude: [] });
  const sessionId = useRef<string | null>(null);
  const shownIds = useRef<string[]>([]);
  const pendingChange = useRef<Partial<Change> | undefined>(undefined);
  const nextIsOpen = useRef(false); // the next follow-up answers "What would make it right?"
  const busy = useRef(false); // one answer at a time (a chip tap during a parse is ignored)
  const location = useRef<Promise<LocationResult> | null>(null);
  const nextId = useRef(0);
  const scroll = useRef<ScrollViewInstance>(null);

  function say(role: Bubble['role'], text: string): number {
    nextId.current += 1;
    const id = nextId.current;
    setBubbles((prev) => [...prev, { id, role, text }]);
    return id;
  }

  function ask(key: keyof typeof QUESTIONS) {
    say('assistant', QUESTIONS[key]);
    transcript.current.push({ role: 'assistant', body: QUESTIONS[key], question_key: key });
  }

  function record(
    key: QuestionKey,
    shown: string,
    value: TranscriptMessage['answer'],
    mode: 'chip' | 'text' | 'prefill',
    body: string = shown,
  ) {
    say('user', shown);
    transcript.current.push({ role: 'user', body, question_key: key, answer: value, input_mode: mode });
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

  const names = new Map((categories ?? []).map((c) => [c.id, c.name]));
  const favorites = (prior?.favorites ?? []).filter((id) => names.has(id));
  const budgetPick = preset.budget ?? prior?.budget ?? null;
  const radiusPick = preset.radius ?? null;

  function cravingLabel(id: string | null): string {
    return id === null ? 'Anything' : (names.get(id) ?? id);
  }

  // The 3 questions ------------------------------------------------------------

  function chooseCraving(id: string | null, label: string) {
    if (busy.current) return;
    answers.current.craving = id;
    record('craving', label, { craving: id }, 'chip');
    ask('budget');
    setStep('budget');
  }

  function chooseBudget(level: number, label: string) {
    if (busy.current) return;
    answers.current.budget = level;
    record('budget', label, { budget_level: level }, budgetPick === level ? 'prefill' : 'chip');
    ask('distance');
    setStep('distance');
  }

  function chooseDistance(radius: Radius, label: string) {
    if (busy.current) return;
    answers.current.radius = radius;
    record('distance', label, { radius_m: radius }, radiusPick === radius ? 'prefill' : 'chip');
    fetchRound();
  }

  /** What a typed first answer said about later questions: pre-selects their chips (FR4). */
  function prefill(key: FirstKey, a: Change) {
    for (const c of a.exclude_categories) {
      if (!answers.current.exclude.includes(c)) answers.current.exclude.push(c);
    }
    const later: { budget?: number; radius?: Radius } = { ...preset };
    if (key === 'craving' && typeof a.budget === 'number') later.budget = a.budget;
    if (key !== 'distance' && typeof a.distance === 'number') later.radius = a.distance;
    setPreset(later);
  }

  /** A parsed first answer: echoed as the matching chip. */
  function typedFirst(key: FirstKey, a: Change, text: string) {
    prefill(key, a);
    if (key === 'craving') {
      const id = a.craving === 'anything' ? null : a.craving;
      answers.current.craving = id;
      record('craving', cravingLabel(id), a, 'text', text);
      ask('budget');
      setStep('budget');
    } else if (key === 'budget' && typeof a.budget === 'number') {
      answers.current.budget = a.budget;
      record('budget', BUDGETS[a.budget - 1].label, a, 'text', text);
      ask('distance');
      setStep('distance');
    } else if (key === 'distance' && typeof a.distance === 'number') {
      const radius = a.distance;
      answers.current.radius = radius;
      record('distance', DISTANCES.find((d) => d.radius === radius)?.label ?? 'Walk', a, 'text', text);
      fetchRound();
    }
  }

  // Follow-ups -----------------------------------------------------------------

  function followUp(change: Partial<Change>, shown: string, mode: 'chip' | 'text', body: string = shown) {
    const key: QuestionKey = nextIsOpen.current ? 'open' : 'refine';
    nextIsOpen.current = false;
    record(key, shown, change, mode, body);
    fetchRound(change);
  }

  function chooseFollowUp(change: Partial<Change>, label: string) {
    if (busy.current) return;
    followUp(change, label, 'chip');
  }

  async function sendText(text: string) {
    if (busy.current) return;
    const key: QuestionKey = isFirst(step) ? step : nextIsOpen.current ? 'open' : 'refine';
    busy.current = true;
    setParsing(true);
    let parsed: Change | null = null;
    let partial: Change | null = null; // not sure, but it answered later questions
    try {
      const result = await parseAnswer(key, text);
      parsed = result.status === 'ok' ? result.answer : null;
      partial = result.status === 'not_sure' ? result.answer : null;
    } catch {
      parsed = null; // offline or a server error: same as not sure, the chips still work
    } finally {
      busy.current = false;
      setParsing(false);
    }
    if (!parsed) {
      if (partial && isFirst(step)) prefill(step, partial);
      say('user', text);
      say('assistant', isFirst(step) ? 'Not sure. Pick one?' : 'Not sure. Try a chip?');
      return;
    }
    if (isFirst(step)) typedFirst(step, parsed, text);
    else followUp(parsed, text, 'text');
  }

  // Rounds ---------------------------------------------------------------------

  function roundLine(result: RoundResponse, first: boolean): string | null {
    if (result.best_so_far) return result.picks.length ? 'Best so far.' : null;
    if (!result.picks.length) return 'No spots nearby.';
    return first ? 'Here are 3 spots.' : 'Here are a few more.';
  }

  async function fetchRound(change?: Partial<Change>) {
    pendingChange.current = change;
    busy.current = true;
    setProblem(null);
    setStep('loading');
    const where = await (location.current ?? getPosition());
    if (!where.ok) {
      location.current = null; // the next try asks again
      busy.current = false;
      setProblem(where.reason === 'denied' ? 'denied' : 'nofix');
      setStep('error');
      return;
    }
    try {
      const result = await getRecommendations({
        lat: where.position.lat,
        lon: where.position.lon,
        local_time: localTimeIso(),
        timezone: deviceTimezone(),
        craving: answers.current.craving,
        budget_level: answers.current.budget,
        radius_m: answers.current.radius,
        exclude_categories: answers.current.exclude,
        ...(change ? { refine: change } : {}),
        solo: prior?.mostlySolo ?? null,
        ...(sessionId.current ? { session_id: sessionId.current } : {}),
        exclude_ids: shownIds.current,
        transcript: transcript.current,
      });
      if (!result.logged && __DEV__) console.warn('Round not logged');
      transcript.current = [];
      pendingChange.current = undefined;
      const a = result.answers;
      answers.current = {
        craving: a.craving,
        budget: a.budget_level ?? answers.current.budget,
        radius: isRadius(a.radius_m) ? a.radius_m : answers.current.radius,
        exclude: a.exclude_categories,
      };
      if (result.session_id) sessionId.current = result.session_id;
      shownIds.current = [...shownIds.current, ...result.picks.map((p) => p.id)];
      setUser(where.position);
      setDecided(false);
      const line = roundLine(result, rounds.length === 0);
      const id = line ? say('assistant', line) : null;
      if (id !== null && result.picks.length) {
        const round = result.session_id ? result.round : null;
        setRounds((prev) => [...prev, { bubbleId: id, picks: result.picks, sessionId: result.session_id, round }]);
      }
      if (result.best_so_far) {
        ask('open');
        nextIsOpen.current = true;
      }
      setStep('results');
    } catch (e) {
      const kind = e instanceof ApiError ? e.kind : 'network';
      setProblem(kind === 'conflict' || kind === 'notfound' ? 'server' : kind);
      setStep('error');
    } finally {
      busy.current = false;
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
      fetchRound(pendingChange.current);
    }
  }

  let controls = null;
  const composer = (placeholder: string) => (
    <Composer placeholder={placeholder} onSend={sendText} busy={parsing} />
  );
  if (step === 'craving' && categories) {
    const list = showAll ? categories.map((c) => c.id) : favorites;
    controls = (
      <View style={styles.stack}>
        <View style={styles.chips}>
          {list.map((id) => (
            <Chip key={id} label={cravingLabel(id)} onPress={() => chooseCraving(id, cravingLabel(id))} />
          ))}
          <Chip label="Anything" onPress={() => chooseCraving(null, 'Anything')} />
          {!showAll && <Chip label="More" onPress={() => setShowAll(true)} />}
        </View>
        {composer('Or type it')}
      </View>
    );
  } else if (step === 'budget') {
    controls = (
      <View style={styles.stack}>
        <View style={styles.chips}>
          {BUDGETS.map((b) => (
            <Chip
              key={b.level}
              label={b.label}
              selected={budgetPick === b.level}
              onPress={() => chooseBudget(b.level, b.label)}
            />
          ))}
        </View>
        {composer('Or type it')}
      </View>
    );
  } else if (step === 'distance') {
    controls = (
      <View style={styles.stack}>
        <View style={styles.chips}>
          {DISTANCES.map((d) => (
            <Chip
              key={d.radius}
              label={d.label}
              selected={radiusPick === d.radius}
              onPress={() => chooseDistance(d.radius, d.label)}
            />
          ))}
        </View>
        {composer('Or type it')}
      </View>
    );
  } else if (step === 'results' && !decided) {
    controls = (
      <View style={styles.stack}>
        <View style={styles.chips}>
          {FOLLOW_UPS.map((f) => (
            <Chip key={f.label} label={f.label} onPress={() => chooseFollowUp(f.change, f.label)} />
          ))}
        </View>
        {composer('Or type what to change')}
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

  const latest = rounds.length ? rounds[rounds.length - 1].bubbleId : null;

  return (
    <GlassScreen tabBar>
      <KeyboardAvoidingView behavior="padding" style={styles.fill}>
        <ScrollView
          ref={scroll}
          // Without chips below, the thread scrolls behind the tab bar and ends above it.
          contentContainerStyle={[styles.thread, !controls && { paddingBottom: bottom }]}
          keyboardShouldPersistTaps="handled"
          onContentSizeChange={() => scroll.current?.scrollToEnd({ animated: true })}
        >
          {!categories && step !== 'error' && <ActivityIndicator style={styles.spinner} />}
          {bubbles.map((b) => {
            const r = rounds.find((x) => x.bubbleId === b.id);
            return (
              <Fragment key={b.id}>
                <View style={[styles.bubble, b.role === 'user' ? styles.mine : styles.theirs]}>
                  <Text style={[styles.bubbleText, b.role === 'user' && styles.mineText]}>{b.text}</Text>
                </View>
                {r && (
                  <ResultCards
                    key={`cards-${b.id}`}
                    picks={r.picks}
                    user={user}
                    sessionId={r.sessionId}
                    round={r.round}
                    readOnly={b.id !== latest}
                    onSay={(text) => say('assistant', text)}
                    onPicked={() => remindAfterPick(userId)}
                    onDecided={() => setDecided(true)}
                  />
                )}
              </Fragment>
            );
          })}
          {step === 'loading' && (
            <View style={[styles.bubble, styles.theirs]}>
              <Text style={styles.bubbleText}>Finding spots…</Text>
            </View>
          )}
        </ScrollView>
        {controls && <View style={[styles.controls, { marginBottom: bottom }]}>{controls}</View>}
      </KeyboardAvoidingView>
    </GlassScreen>
  );
}

const styles = StyleSheet.create({
  fill: {
    flex: 1,
  },
  thread: {
    gap: 10,
    paddingBottom: spacing.lg,
  },
  spinner: {
    marginTop: spacing.xxl,
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
  controls: {
    paddingTop: spacing.md,
  },
  stack: {
    gap: spacing.md,
  },
  chips: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
  },
  problem: {
    gap: 10,
  },
  problemText: {
    fontSize: type.small,
    color: colors.error,
  },
});
