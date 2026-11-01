import { Fragment, type ReactNode, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Keyboard,
  KeyboardAvoidingView,
  Linking,
  Pressable,
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
  type ParseResponse,
  type Pick,
  type QuestionKey,
  type RoundRequest,
  type RoundResponse,
  type TranscriptMessage,
} from '../lib/api';
import { getPosition, type LocationResult, type Position } from '../lib/location';
import { remindAfterPick } from '../lib/notify';
import {
  type Category,
  loadCategories,
  loadDisplayName,
  loadTastePrior,
  type TastePrior,
} from '../lib/profile';
import { colors, radii, spacing, type } from '../theme';
import Composer from './Composer';
import ResultCards from './ResultCards';
import ScrollWithBar from './ScrollWithBar';
import TypingBubble from './TypingBubble';
import { Chip, GlassScreen } from './ui';

// Chat (P1-09) with the fixed Phase 1 questions (P1-10): craving, budget, distance.
// Company is not asked: it comes from the quiz prior (mostly_solo). One question per message (R1).
// Typed answers are parsed by Muse into the same answers as the chips (P1-21). After a round,
// the chat stays open: Cheaper / Closer / Something else or a typed follow-up runs a new round
// that skips every place already shown (P1-14). Round 4 without a pick is the best so far.
// P1-19: the composer is always there. After a pick or None of these, typed text is the craving
// of a new search (budget and distance asked again, preselected). Small talk gets one short
// line back from the same parse call; {name} in it is filled in here, never sent to Muse.
// Round 2: the user's bubble shows at once, with "…" until a typed reply comes back ("Finding
// spots…" for rounds). Errors are a line in the thread under the user's bubble. Distance is
// two chips: Close to me (15 km) and I don't mind (35 km).

type Step = 'craving' | 'budget' | 'distance' | 'loading' | 'results' | 'error';
type FirstKey = 'craving' | 'budget' | 'distance';
type Problem = 'denied' | 'nofix' | 'network' | 'server' | 'auth' | 'load';
type Bubble = { id: number; role: 'assistant' | 'user'; text: string; error?: boolean };
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

const CLOSE: Radius = 15000;
const DISTANCES: { radius: Radius; label: string }[] = [
  { radius: CLOSE, label: 'Close to me' },
  { radius: 35000, label: "I don't mind" },
];

type FollowUp = { label: string; change: Partial<Change> };
const CHEAPER: FollowUp = { label: 'Cheaper', change: { budget: 'cheaper' } };
const CLOSER: FollowUp = { label: 'Closer', change: { distance: 'closer' } };
const FARTHER: FollowUp = { label: "I don't mind the distance", change: { distance: 'farther' } };
const SOMETHING_ELSE: FollowUp = { label: 'Something else', change: { something_else: true } };

/** Follow-up chips: an empty round only offers going farther (or something else at 35 km). */
function followUps(radius: Radius, empty: boolean): FollowUp[] {
  const close = radius === CLOSE;
  if (empty) return [close ? FARTHER : SOMETHING_ELSE];
  return [CHEAPER, close ? FARTHER : CLOSER, SOMETHING_ELSE];
}

const NOT_SURE = "Didn't catch that. Tap one below.";

/** Fills Muse's {name} placeholder with the user's name, or drops it cleanly when unset. */
function withName(line: string, name: string | null): string {
  if (name) return line.split('{name}').join(name);
  const out = line.replace(/,?\s*\{name\}/g, '').replace(/^[\s,!.]+/, '').trim();
  return out.charAt(0).toUpperCase() + out.slice(1);
}

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
  // The last round's radius and whether it came back empty: decides the follow-up chips.
  const [lastRound, setLastRound] = useState<{ radius: Radius; empty: boolean }>({ radius: CLOSE, empty: false });
  // A typed message that couldn't reach the server: "Try again" resends it (bubble stays).
  const [unsent, setUnsent] = useState<{ text: string; problem: Problem } | null>(null);
  const [name, setName] = useState<string | null>(null);
  const [keyboard, setKeyboard] = useState(false);
  // Pre-selected chips for later questions, from a typed answer that covered them (FR4).
  const [preset, setPreset] = useState<{ budget?: number; radius?: Radius }>({});

  // Unsent chat lines: sent with the next round, then cleared (R3).
  const transcript = useRef<TranscriptMessage[]>([]);
  const answers = useRef<Answers>({ craving: null, budget: 2, radius: CLOSE, exclude: [] });
  const sessionId = useRef<string | null>(null);
  const shownIds = useRef<string[]>([]);
  const pendingChange = useRef<Partial<Change> | undefined>(undefined);
  const firstOfSearch = useRef(true); // the next round is this search's first ("3 spots")
  const nextIsOpen = useRef(false); // the next follow-up answers "What would make it right?"
  const busy = useRef(false); // one answer at a time (a chip tap during a parse is ignored)
  const location = useRef<Promise<LocationResult> | null>(null);
  const nextId = useRef(0);
  const scroll = useRef<ScrollViewInstance>(null);

  function say(role: Bubble['role'], text: string, error = false): number {
    nextId.current += 1;
    const id = nextId.current;
    setBubbles((prev) => [...prev, { id, role, text, error }]);
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
    // Typed text is already on screen (sent at once); only chips add their bubble here.
    if (mode !== 'text') say('user', shown);
    setUnsent(null);
    transcript.current.push({ role: 'user', body, question_key: key, answer: value, input_mode: mode });
  }

  // Start: the prior and categories for the chips, and location in the background so it is
  // usually ready by the third answer.
  useEffect(() => {
    let live = true;
    location.current = getPosition();
    Promise.all([loadCategories(), loadTastePrior(userId), loadDisplayName(userId).catch(() => null)])
      .then(([rows, quiz, shownName]) => {
        if (!live) return;
        setCategories(rows);
        setPrior(quiz);
        setName(shownName);
        if (quiz.budget) answers.current.budget = quiz.budget;
        nextId.current += 1;
        setBubbles([{ id: nextId.current, role: 'assistant', text: QUESTIONS.craving }]);
        transcript.current = [{ role: 'assistant', body: QUESTIONS.craving, question_key: 'craving' }];
      })
      .catch(() => {
        if (!live) return;
        nextId.current += 1;
        setBubbles([{ id: nextId.current, role: 'assistant', text: PROBLEM_TEXT.load, error: true }]);
        setProblem('load');
        setStep('error');
      });
    return () => {
      live = false;
    };
  }, [userId]);

  // With the keyboard up, the composer sits right on it, not a dock's height above it.
  useEffect(() => {
    const show = Keyboard.addListener('keyboardWillShow', () => setKeyboard(true));
    const hide = Keyboard.addListener('keyboardWillHide', () => setKeyboard(false));
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);

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
    setPreset((prev) => {
      const later = { ...prev };
      if (key === 'craving' && typeof a.budget === 'number') later.budget = a.budget;
      if (key !== 'distance' && typeof a.distance === 'number') later.radius = a.distance;
      return later;
    });
  }

  /** A parsed first answer: the typed bubble stays; the answer is logged like its chip. */
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
      record('distance', DISTANCES.find((d) => d.radius === radius)?.label ?? 'Close to me', a, 'text', text);
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
    setUnsent(null);
    followUp(change, label, 'chip');
  }

  /** After a pick or None of these: a new session that starts at the craving. */
  function startNewSearch() {
    sessionId.current = null;
    shownIds.current = [];
    transcript.current = [];
    pendingChange.current = undefined;
    nextIsOpen.current = false;
    firstOfSearch.current = true;
    answers.current = { ...answers.current, craving: null, exclude: [] };
    // Budget and distance are asked again, preselected from the last search.
    setPreset({ budget: answers.current.budget, radius: answers.current.radius });
    setShowAll(false);
    setDecided(false);
    setStep('craving');
  }

  /** Typed text: the bubble shows now, "…" until the parse comes back. */
  function sendText(text: string) {
    if (busy.current) return;
    say('user', text);
    parseText(text);
  }

  async function parseText(text: string) {
    if (busy.current) return;
    setUnsent(null);
    const fresh = step === 'results' && decided; // the text is a new search's craving
    const first: FirstKey | null = fresh ? 'craving' : isFirst(step) ? step : null;
    const key: QuestionKey = first ?? (nextIsOpen.current ? 'open' : 'refine');
    busy.current = true;
    setParsing(true);
    let result: ParseResponse | null = null;
    let failed: Problem | null = null;
    try {
      result = await parseAnswer(key, text);
    } catch (e) {
      const kind = e instanceof ApiError ? e.kind : 'network';
      failed = kind === 'auth' ? 'auth' : 'network';
    } finally {
      busy.current = false;
      setParsing(false);
    }
    if (failed) {
      // The bubble stays; the error line goes under it, and Try again resends the text.
      say('assistant', PROBLEM_TEXT[failed], true);
      setUnsent({ text, problem: failed });
      return;
    }
    // Small talk: one line back, the question and its chips stay. Not an answer, not logged.
    if (result?.status === 'chat' && result.reply) {
      say('assistant', withName(result.reply, name));
      return;
    }
    const parsed: Change | null = result?.status === 'ok' ? result.answer : null;
    if (fresh) startNewSearch();
    if (!parsed) {
      // Not sure, but it may have answered later questions (FR4 prefill).
      const partial = result?.status === 'not_sure' ? result.answer : null;
      if (partial && first) prefill(first, partial);
      say('assistant', NOT_SURE);
      return;
    }
    if (first) typedFirst(first, parsed, text);
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
      fail(where.reason === 'denied' ? 'denied' : 'nofix');
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
      setLastRound({ radius: answers.current.radius, empty: !result.best_so_far && result.picks.length === 0 });
      const line = roundLine(result, firstOfSearch.current);
      firstOfSearch.current = false;
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
      fail(kind === 'conflict' || kind === 'notfound' ? 'server' : kind);
    } finally {
      busy.current = false;
    }
  }

  /** A failed step: the error line in the thread, the fix as chips below. */
  function fail(kind: Problem) {
    say('assistant', PROBLEM_TEXT[kind], true);
    setProblem(kind);
    setStep('error');
  }

  function retry() {
    if (problem === 'auth') {
      onSignOut();
    } else if (problem === 'load') {
      setProblem(null);
      setStep('craving');
      Promise.all([loadCategories(), loadTastePrior(userId), loadDisplayName(userId).catch(() => null)])
        .then(([rows, quiz, shownName]) => {
          setCategories(rows);
          setPrior(quiz);
          setName(shownName);
          if (quiz.budget) answers.current.budget = quiz.budget;
          ask('craving');
        })
        .catch(() => fail('load'));
    } else {
      fetchRound(pendingChange.current);
    }
  }

  // Chips for the current step (none while loading or after a decision), then the composer,
  // which is always there (P1-19).
  let chips: ReactNode = null;
  if (step === 'craving' && categories) {
    const list = showAll ? categories.map((c) => c.id) : favorites;
    chips = (
      <>
        {list.map((id) => (
          <Chip key={id} label={cravingLabel(id)} onPress={() => chooseCraving(id, cravingLabel(id))} />
        ))}
        <Chip label="Anything" onPress={() => chooseCraving(null, 'Anything')} />
        {!showAll && <Chip label="More" onPress={() => setShowAll(true)} />}
      </>
    );
  } else if (step === 'budget') {
    chips = BUDGETS.map((b) => (
      <Chip
        key={b.level}
        label={b.label}
        selected={budgetPick === b.level}
        onPress={() => chooseBudget(b.level, b.label)}
      />
    ));
  } else if (step === 'distance') {
    chips = DISTANCES.map((d) => (
      <Chip
        key={d.radius}
        label={d.label}
        selected={radiusPick === d.radius}
        onPress={() => chooseDistance(d.radius, d.label)}
      />
    ));
  } else if (step === 'results' && !decided) {
    chips = followUps(lastRound.radius, lastRound.empty).map((f) => (
      <Chip key={f.label} label={f.label} onPress={() => chooseFollowUp(f.change, f.label)} />
    ));
  } else if (step === 'error' && problem) {
    chips = (
      <>
        {problem === 'denied' && <Chip label="Open Settings" onPress={() => Linking.openSettings()} />}
        <Chip label={problem === 'auth' ? 'Sign in' : 'Try again'} onPress={retry} />
      </>
    );
  }

  // A typed message that failed to send: its fix comes first, the step's chips still work.
  const resend = unsent && (
    <Chip
      key="resend"
      label={unsent.problem === 'auth' ? 'Sign in' : 'Try again'}
      onPress={unsent.problem === 'auth' ? onSignOut : () => parseText(unsent.text)}
    />
  );

  const placeholder =
    step === 'results' ? (decided ? 'Craving something else?' : 'Or type what to change') : 'Or type it';
  const composerOff = step === 'loading' || step === 'error' || !categories;

  const latest = rounds.length ? rounds[rounds.length - 1].bubbleId : null;

  return (
    <GlassScreen tabBar>
      <KeyboardAvoidingView behavior="padding" style={styles.fill}>
        <ScrollWithBar
          scrollRef={scroll}
          // Full screen width, so the scroll bar sits at the screen's right edge.
          style={styles.edgeToEdge}
          contentContainerStyle={styles.thread}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="interactive"
          onContentSizeChange={() => scroll.current?.scrollToEnd({ animated: true })}
        >
          {!categories && step !== 'error' && <ActivityIndicator style={styles.spinner} />}
          {bubbles.map((b) => {
            const r = rounds.find((x) => x.bubbleId === b.id);
            return (
              <Fragment key={b.id}>
                <View style={[styles.bubble, b.role === 'user' ? styles.mine : styles.theirs]}>
                  <Text
                    style={[styles.bubbleText, b.role === 'user' && styles.mineText, b.error && styles.errorText]}
                  >
                    {b.text}
                  </Text>
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
          {parsing && <TypingBubble />}
          {step === 'loading' && (
            <View style={[styles.bubble, styles.theirs]}>
              <Text style={styles.bubbleText}>Finding spots…</Text>
            </View>
          )}
        </ScrollWithBar>
        {/* A tap outside the input or chips closes the keyboard. */}
        <Pressable
          accessible={false}
          onPress={Keyboard.dismiss}
          style={[styles.controls, { marginBottom: keyboard ? spacing.sm : bottom }]}
        >
          {(resend || chips) && (
            <View style={styles.chips}>
              {resend}
              {chips}
            </View>
          )}
          <Composer placeholder={placeholder} onSend={sendText} busy={parsing} disabled={composerOff} />
        </Pressable>
      </KeyboardAvoidingView>
    </GlassScreen>
  );
}

const styles = StyleSheet.create({
  fill: {
    flex: 1,
  },
  edgeToEdge: {
    marginHorizontal: -spacing.xl, // undoes GlassScreen's side padding
  },
  thread: {
    gap: 10,
    paddingHorizontal: spacing.xl,
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
    gap: spacing.md,
  },
  chips: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
  },
  errorText: {
    color: colors.error,
  },
});
