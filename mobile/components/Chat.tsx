import { useFocusEffect, useNavigation } from '@react-navigation/native';
import { Fragment, type ReactNode, useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import {
  ActivityIndicator,
  AppState,
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
  type CompanyAnswer,
  type RefinementKey,
  deviceTimezone,
  type FirstKey,
  getQuestionPlan,
  getRecommendations,
  localTimeIso,
  type NextQuestion,
  parseAnswer,
  type ParseResponse,
  type Pick,
  type PlanResponse,
  type QuestionKey,
  type RoundRequest,
  type RoundResponse,
  type TranscriptMessage,
} from '../lib/api';
import { getPosition, type LocationResult, type Position } from '../lib/location';
import { haptic } from '../lib/haptics';
import { remindAfterPick } from '../lib/notify';
import { OtisController } from '../lib/otis';
import {
  budgetPick as pickBudget, companySelection, matchCompany, planPrefill,
  type Prefill, skippedAnswers, traceOf,
} from '../lib/questionPlan';
import {
  type Category,
  type Companion,
  loadCompanionChoices,
  loadCategories,
  loadDisplayName,
  loadTastePrior,
  type TastePrior,
} from '../lib/profile';
import { ReasonsCache, type ReasonsEnvelope, type ReasonsObserver } from '../lib/reasons';
import { colors, otis as otisTheme, radii, spacing, type } from '../theme';
import Composer from './Composer';
import Otis from './Otis';
import ResultCards from './ResultCards';
import ScrollWithBar from './ScrollWithBar';
import TypingBubble from './TypingBubble';
import { Chip, GlassScreen } from './ui';

// Chat (P1-09) with the 3 questions (P1-10): craving, budget, distance. P2-05: their order and
// pre-selected chips come from the confidence gate (POST /questions/plan): weak predictions
// first, confident ones last with their chip pre-selected (editable). The quiz budget is
// pre-selected even when budget is weak (it is the user's own answer). If the plan call fails,
// the order is craving, budget, distance as before. After a round only the picks and None of
// these show. None of these keeps the session open and asks the refinement question:
// next_question (highest information gain, ML10) with its chips, or "What would make it
// better?" with the fixed chips when it is null. Typed text after a round runs the next round
// right away. The cap round (best so far) keeps its open question; None of these there ends
// the session as none.
// Company is asked only when included by the gate; typed names are matched locally.
// Typed answers are parsed by Muse into the same answers as the chips (P1-21). After a round,
// the chat stays open: Cheaper / Closer / Something else or a typed follow-up runs a new round
// that skips every place already shown (P1-14). Round 4 without a pick is the best so far.
// P1-19: the composer is always there. After a pick or None of these, typed text is the craving
// of a new search (budget and distance asked again, preselected). Small talk gets one short
// line back from the same parse call; {name} in it is filled in here, never sent to Muse.
// Round 2: the user's bubble shows at once, with "…" until a typed reply comes back ("Finding
// spots…" for rounds). Errors are a line in the thread under the user's bubble. Distance is
// two chips: Close to me (15 km) and I don't mind (35 km).

type Step = 'craving' | 'budget' | 'distance' | 'company' | 'loading' | 'results' | 'error';
type Problem = 'denied' | 'nofix' | 'network' | 'server' | 'auth' | 'load';
type Bubble = { id: number; role: 'assistant' | 'user'; text: string; error?: boolean };
type Radius = RoundRequest['radius_m'];
type Round = {
  bubbleId: number;
  picks: Pick[];
  sessionId: string | null;
  round: number | null;
  envelope?: ReasonsEnvelope | null;
  generation: number;
  lifecycle: ReasonsObserver;
  final: boolean; // the cap round: None of these ends the session
};
type Answers = { craving: string | null; budget: number; radius: Radius; exclude: string[] };

// The order when there is no plan (plan call failed): the Phase 1 order.
const DEFAULT_ORDER: FirstKey[] = ['craving', 'budget', 'distance'];

/** The plan's order if it is exactly the 3 questions, else the default order (a fallback). */
function planOrder(plan: PlanResponse | null): { keys: FirstKey[]; source: 'plan' | 'fallback' } {
  const keys = plan?.questions.map((q) => q.key) ?? [];
  const pool = [...DEFAULT_ORDER, 'company'];
  const valid = keys.length === 3 && new Set(keys).size === 3 && keys.every((k) => pool.includes(k))
    && (!keys.includes('company') || !!plan?.skipped)
    && (!plan?.skipped || (pool.includes(plan.skipped.key) && !keys.includes(plan.skipped.key)));
  return valid ? { keys, source: 'plan' } : { keys: DEFAULT_ORDER, source: 'fallback' };
}

/** The prior, categories, name, and the gate's plan, together. A failed plan is null (the
 * default order), never a load error. */
function loadStart(userId: string) {
  const quiz = loadTastePrior(userId);
  const people = loadCompanionChoices(userId);
  return Promise.all([
    loadCategories(),
    quiz,
    loadDisplayName(userId).catch(() => null),
    getQuestionPlan(localTimeIso()).catch(() => null),
    people,
  ]);
}

// Refinement lines (P2-05): fixed, separate from the round-1 wording. No Muse call.
const REFINE_QUESTIONS: Record<RefinementKey, string> = {
  craving: 'What sounds better?',
  budget: 'What price works better?',
  distance: 'How far would you go?',
};
const REFINE_OPEN = 'What would make it better?'; // no gate question: the fixed chips

const QUESTIONS = {
  craving: 'What are you craving?',
  budget: 'Budget this time?',
  distance: 'How far?',
  company: 'Who are you eating with?',
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
  return step === 'craving' || step === 'budget' || step === 'distance' || step === 'company';
}

type ChatProps = {
  userId: string;
  onSignOut: () => void;
  /** Space kept clear for the floating tab bar. */
  bottom: number;
};

export default function Chat({ userId, onSignOut, bottom }: ChatProps) {
  const [reasonsCache] = useState(() => new ReasonsCache());
  const [otis] = useState(() => new OtisController(otisTheme.happyMs));
  const otisStatus = useSyncExternalStore(otis.subscribe, otis.getSnapshot);
  const navigation = useNavigation();
  useFocusEffect(useCallback(() => {
    otis.setActive(AppState.currentState === 'active');
    return () => otis.setActive(false);
  }, [otis]));
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      otis.setActive(state === 'active' && navigation.isFocused());
    });
    return () => sub.remove();
  }, [navigation, otis]);
  useEffect(() => () => { reasonsCache.clear(); otis.cancel(); }, [reasonsCache, otis, userId]);
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
  // Pre-selected chips: from the plan (confident predictions, P2-05) or a typed answer that
  // covered a later question (FR4).
  const [preset, setPreset] = useState<Prefill>({});
  const [companions, setCompanions] = useState<Companion[]>([]);
  const [companyPick, setCompanyPick] = useState<CompanyAnswer>(null);
  const companyAnswer = useRef<CompanyAnswer>(null);
  const companyTrace = useRef<{ received: CompanyAnswer; shown: CompanyAnswer }>({
    received: null, shown: null,
  });
  const companyInPool = useRef(false);
  // After a round: the information-gain question (ML10), or null for the fixed chips. Asked
  // only once refining (after None of these).
  const [nextQuestion, setNextQuestion] = useState<NextQuestion | null>(null);
  // The refinement chips show: after None of these, an empty round, or the cap round.
  const [refining, setRefining] = useState(false);

  // Unsent chat lines: sent with the next round, then cleared (R3).
  const transcript = useRef<TranscriptMessage[]>([]);
  const answers = useRef<Answers>({ craving: null, budget: 2, radius: CLOSE, exclude: [] });
  const order = useRef<FirstKey[]>(DEFAULT_ORDER); // the 3 questions in asking order
  // Sent with round 1 (P2-05): where this search's question order came from.
  const planSource = useRef<'plan' | 'fallback' | 'new_search'>('fallback');
  const sessionId = useRef<string | null>(null);
  const shownIds = useRef<string[]>([]);
  const pendingChange = useRef<Partial<Change> | undefined>(undefined);
  const firstOfSearch = useRef(true); // the next round is this search's first ("3 spots")
  const nextIsOpen = useRef(false); // the next follow-up answers "What would make it right?"
  const noneOfThese = useRef(false); // sent with the next round: its rejected reason
  // Trace (P2-05), sent with round 1: the plan's pre-fills as received, and the chip that was
  // highlighted when each question was answered (read from that render).
  const prefillReceived = useRef<Prefill>({});
  const prefillShown = useRef<Prefill>({});
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
    askLine(QUESTIONS[key], key);
  }

  function askLine(text: string, key: QuestionKey) {
    say('assistant', text);
    transcript.current.push({ role: 'assistant', body: text, question_key: key });
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

  /** Applies the plan (or the default order) and returns the first question. */
  function applyPlan(rows: Category[], quiz: TastePrior, plan: PlanResponse | null, people: Companion[]): FirstKey {
    const candidate = planOrder(plan);
    const ids = new Set(people.map((p) => p.id));
    // Never show a company question without usable chips.
    const chosen = candidate.keys.includes('company') && !people.length
      ? { keys: DEFAULT_ORDER, source: 'fallback' as const } : candidate;
    const usable = chosen.source === 'plan' ? plan : null;
    companyInPool.current = !!usable && (usable.questions.some((q) => q.key === 'company')
      || usable.skipped?.key === 'company');
    const received = companySelection(usable?.questions.find((q) => q.key === 'company')?.prefill, ids);
    companyTrace.current = { received, shown: null };
    companyAnswer.current = null;
    setCompanyPick(received);
    order.current = chosen.keys;
    planSource.current = chosen.source;
    const pre = planPrefill(usable?.questions, new Set(rows.map((c) => c.id)));
    prefillReceived.current = pre;
    prefillShown.current = {};
    setPreset(pre); // a weak budget falls back to the quiz budget (budgetPick below)
    if (quiz.budget) answers.current.budget = quiz.budget;
    const inferred = skippedAnswers(usable?.skipped, new Set(rows.map((c) => c.id)), ids);
    companyAnswer.current = inferred.company ?? null;
    if (inferred.craving) answers.current.craving = inferred.craving;
    if (inferred.budget) answers.current.budget = inferred.budget;
    if (inferred.radius) answers.current.radius = inferred.radius;
    return order.current[0];
  }

  // Start: the prior, categories, and plan for the chips, and location in the background so it
  // is usually ready by the third answer.
  useEffect(() => {
    let live = true;
    location.current = getPosition();
    loadStart(userId)
      .then(([rows, quiz, shownName, plan, people]) => {
        if (!live) return;
        setCategories(rows);
        setPrior(quiz);
        setName(shownName);
        setCompanions(people);
        const first = applyPlan(rows, quiz, plan, people);
        nextId.current += 1;
        setBubbles([{ id: nextId.current, role: 'assistant', text: QUESTIONS[first] }]);
        transcript.current = [{ role: 'assistant', body: QUESTIONS[first], question_key: first }];
        setStep(first);
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
  const cravingPick = preset.craving ?? null;
  const budgetPick = pickBudget(preset, prior?.budget);
  const radiusPick = preset.radius ?? null;

  function cravingLabel(id: string | null): string {
    return id === null ? 'Anything' : (names.get(id) ?? id);
  }

  // The 3 questions ------------------------------------------------------------

  /** The questions after key in this search's order. */
  function laterThan(key: FirstKey): FirstKey[] {
    return order.current.slice(order.current.indexOf(key) + 1);
  }

  /** After answering key: the next question in the order, or the round after the last one. */
  function advance(key: FirstKey) {
    const next = laterThan(key)[0];
    if (next) {
      ask(next);
      setStep(next);
    } else {
      fetchRound();
    }
  }

  /** Trace: the chip this render highlighted for key (the one on screen at the answer). */
  function noteShown(key: FirstKey) {
    const shown = { ...prefillShown.current };
    if (key === 'craving') shown.craving = cravingPick ?? undefined;
    if (key === 'budget') shown.budget = budgetPick ?? undefined;
    if (key === 'distance') shown.radius = radiusPick ?? undefined;
    prefillShown.current = shown;
  }

  function chooseCompany(value: Exclude<CompanyAnswer, null>, text?: string) {
    if (busy.current) return;
    if (text === undefined) {
      if (value !== 'solo') haptic('light'); // Continue confirms the selected companions.
      else if (companyPick !== 'solo') haptic('selection');
    }
    companyTrace.current.shown = companyPick;
    companyAnswer.current = value;
    const label = value === 'solo' ? 'Solo' : value.length > 2 ? `${value.length} companions`
      : companions.filter((c) => value.includes(c.id)).map((c) => c.name).join(', ');
    const same = JSON.stringify(value) === JSON.stringify(companyTrace.current.received);
    record('company', label, { solo: value === 'solo', companion_ids: value === 'solo' ? [] : value },
      text !== undefined ? 'text' : same ? 'prefill' : 'chip', text ?? label);
    advance('company');
  }

  function chooseCraving(id: string | null, label: string) {
    if (busy.current) return;
    if (id === null || cravingPick !== id) haptic('selection');
    noteShown('craving');
    answers.current.craving = id;
    record('craving', label, { craving: id }, id !== null && cravingPick === id ? 'prefill' : 'chip');
    advance('craving');
  }

  function chooseBudget(level: number, label: string) {
    if (busy.current) return;
    if (budgetPick !== level) haptic('selection');
    noteShown('budget');
    answers.current.budget = level;
    record('budget', label, { budget_level: level }, budgetPick === level ? 'prefill' : 'chip');
    advance('budget');
  }

  function chooseDistance(radius: Radius, label: string) {
    if (busy.current) return;
    if (radiusPick !== radius) haptic('selection');
    noteShown('distance');
    answers.current.radius = radius;
    record('distance', label, { radius_m: radius }, radiusPick === radius ? 'prefill' : 'chip');
    advance('distance');
  }

  /** What a typed first answer said about later questions: pre-selects their chips (FR4). */
  function prefill(key: FirstKey, a: Change) {
    for (const c of a.exclude_categories) {
      if (!answers.current.exclude.includes(c)) answers.current.exclude.push(c);
    }
    const later = laterThan(key);
    setPreset((prev) => {
      const next = { ...prev };
      if (later.includes('craving') && a.craving && a.craving !== 'anything' && names.has(a.craving)) {
        next.craving = a.craving;
      }
      if (later.includes('budget') && typeof a.budget === 'number') next.budget = a.budget;
      if (later.includes('distance') && typeof a.distance === 'number') next.radius = a.distance;
      return next;
    });
  }

  /** A parsed first answer: the typed bubble stays; the answer is logged like its chip. */
  function typedFirst(key: FirstKey, a: Change, text: string) {
    noteShown(key);
    prefill(key, a);
    if (key === 'craving') {
      const id = a.craving === 'anything' ? null : a.craving;
      answers.current.craving = id;
      record('craving', cravingLabel(id), a, 'text', text);
      advance('craving');
    } else if (key === 'budget' && typeof a.budget === 'number') {
      answers.current.budget = a.budget;
      record('budget', BUDGETS[a.budget - 1].label, a, 'text', text);
      advance('budget');
    } else if (key === 'distance' && typeof a.distance === 'number') {
      const radius = a.distance;
      answers.current.radius = radius;
      record('distance', DISTANCES.find((d) => d.radius === radius)?.label ?? 'Close to me', a, 'text', text);
      advance('distance');
    }
  }

  // Follow-ups -----------------------------------------------------------------

  /** None of these before the cap: the session stays open; the refinement question follows. */
  function rejectRound(): boolean {
    if (busy.current) return false;
    reasonsCache.invalidate();
    otis.cancel();
    noneOfThese.current = true;
    record('refine', 'None of these', { none_of_these: true }, 'chip');
    if (nextQuestion) askLine(REFINE_QUESTIONS[nextQuestion.key], nextQuestion.key);
    else askLine(REFINE_OPEN, 'refine');
    setRefining(true);
    return true;
  }

  /** A follow-up answer. asked: the information-gain question it answers (a chip), logged
   * under that question's key; otherwise 'refine' (or 'open' after the best so far). */
  function followUp(
    change: Partial<Change>,
    shown: string,
    mode: 'chip' | 'text',
    body: string = shown,
    asked?: RefinementKey,
  ) {
    const key: QuestionKey = asked ?? (nextIsOpen.current ? 'open' : 'refine');
    nextIsOpen.current = false;
    record(key, shown, change, mode, body);
    fetchRound(change);
  }

  function chooseFollowUp(change: Partial<Change>, label: string, asked?: RefinementKey) {
    if (busy.current) return;
    haptic('light');
    setUnsent(null);
    followUp(change, label, 'chip', label, asked);
  }

  /** After a pick or None of these: a new session that starts at the craving. */
  function startNewSearch(plan: PlanResponse | null) {
    reasonsCache.invalidate();
    otis.cancel();
    sessionId.current = null;
    shownIds.current = [];
    transcript.current = [];
    pendingChange.current = undefined;
    nextIsOpen.current = false;
    firstOfSearch.current = true;
    setNextQuestion(null);
    setRefining(false);
    noneOfThese.current = false;
    prefillReceived.current = {}; // reset before loading this search's plan
    prefillShown.current = {};
    answers.current = { ...answers.current, craving: null, exclude: [] };
    companyAnswer.current = null;
    setCompanyPick(null);
    const usable = planOrder(plan).source === 'plan' ? plan : null;
    applyPlan(categories ?? [], prior ?? { favorites: [], budget: null, mostlySolo: null }, usable, companions);
    planSource.current = 'new_search';
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
    if (first === 'company') {
      const matched = matchCompany(text, companions);
      if (matched === null) say('assistant', NOT_SURE);
      else chooseCompany(matched, text);
      return;
    }
    const key = first ?? (nextIsOpen.current ? 'open' : 'refine');
    busy.current = true;
    setParsing(true);
    const operation = otis.begin();
    if (!first || fresh) reasonsCache.invalidate();
    let result: ParseResponse | null = null;
    let freshPlan: PlanResponse | null = null;
    let failed: Problem | null = null;
    try {
      [result, freshPlan] = await Promise.all([
        parseAnswer(key, text),
        fresh ? getQuestionPlan(localTimeIso(), true).catch(() => null) : Promise.resolve(null),
      ]);
    } catch (e) {
      const kind = e instanceof ApiError ? e.kind : 'network';
      failed = kind === 'auth' ? 'auth' : 'network';
    } finally {
      busy.current = false;
      setParsing(false);
    }
    if (failed) {
      otis.finish(operation);
      // The bubble stays; the error line goes under it, and Try again resends the text.
      say('assistant', PROBLEM_TEXT[failed], true);
      setUnsent({ text, problem: failed });
      return;
    }
    // Small talk: one line back, the question and its chips stay. Not an answer, not logged.
    if (result?.status === 'chat' && result.reply) {
      otis.finish(operation);
      say('assistant', withName(result.reply, name));
      return;
    }
    const parsed: Change | null = result?.status === 'ok' ? result.answer : null;
    if (fresh) {
      startNewSearch(freshPlan);
      // This typed answer has no displayed craving chip; do not trace the previous search's.
      if (parsed && parsed.craving !== null) {
        prefill('craving', parsed);
        answers.current.craving = parsed.craving === 'anything' ? null : parsed.craving;
        record('craving', text, parsed, 'text', text);
        advance('craving');
      } else {
        say('assistant', "Didn't catch that.");
        ask('craving');
        setStep('craving');
      }
      return;
    }
    if (!parsed) {
      otis.finish(operation);
      // Not sure, but it may have answered later questions (FR4 prefill).
      const partial = result?.status === 'not_sure' ? result.answer : null;
      if (partial && first) prefill(first, partial);
      say('assistant', NOT_SURE);
      return;
    }
    if (first) typedFirst(first, parsed, text);
    else followUp(parsed, text, 'text');
    // A third answer may already have begun the next operation; this token then does nothing.
    otis.finish(operation);
  }

  // Rounds ---------------------------------------------------------------------

  function roundLine(result: RoundResponse, first: boolean): string | null {
    if (result.best_so_far) return result.picks.length ? 'Best so far.' : null;
    if (!result.picks.length) return 'No spots nearby.';
    return first ? 'Here are 3 spots.' : 'Here are a few more.';
  }

  async function fetchRound(change?: Partial<Change>) {
    reasonsCache.invalidate();
    const operation = otis.begin();
    pendingChange.current = change;
    busy.current = true;
    setProblem(null);
    setStep('loading');
    const where = await (location.current ?? getPosition());
    if (!where.ok) {
      location.current = null; // the next try asks again
      busy.current = false;
      fail(where.reason === 'denied' ? 'denied' : 'nofix', operation);
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
        ...(noneOfThese.current ? { none_of_these: true } : {}),
        solo: companyAnswer.current === 'solo' ? true : Array.isArray(companyAnswer.current) ? false : null,
        companion_ids: Array.isArray(companyAnswer.current) ? companyAnswer.current : [],
        // Round 1 logs the order this chat actually asked, next to the server's plan.
        ...(sessionId.current
          ? { session_id: sessionId.current }
          : {
              asked_order: order.current,
              plan_source: planSource.current,
              prefilled: { received: traceOf(prefillReceived.current), shown: traceOf(prefillShown.current) },
              ...(companyInPool.current ? { company_prefilled: companyTrace.current } : {}),
            }),
        exclude_ids: shownIds.current,
        transcript: transcript.current,
      });
      if (!result.logged && __DEV__) console.warn('Round not logged');
      transcript.current = [];
      pendingChange.current = undefined;
      noneOfThese.current = false;
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
        const generation = reasonsCache.current();
        const lifecycle = otis.observeReasons(operation, { userId, sessionId: result.session_id, round, generation },
          result.picks.map((p) => p.id));
        setRounds((prev) => [
          ...prev,
          { bubbleId: id, picks: result.picks, sessionId: result.session_id, round, final: result.best_so_far,
            envelope: result.reasons_envelope, generation, lifecycle },
        ]);
      } else otis.finish(operation);
      if (result.best_so_far) {
        ask('open');
        nextIsOpen.current = true;
      }
      // The information-gain question (P2-05, ML10): asked as one line, its options as chips.
      // Only with at least one usable chip; otherwise the fixed chips show.
      // Held until None of these, and only with at least one usable chip.
      const candidate = result.best_so_far || !result.picks.length ? null : (result.next_question ?? null);
      setNextQuestion(candidate && questionChips(candidate).length ? candidate : null);
      // An empty round or the cap round shows its chips at once (no cards to reject).
      setRefining(result.best_so_far || !result.picks.length);
      setStep('results');
    } catch (e) {
      const kind = e instanceof ApiError ? e.kind : 'network';
      fail(kind === 'conflict' || kind === 'notfound' ? 'server' : kind, operation);
    } finally {
      busy.current = false;
    }
  }

  /** A failed step: the error line in the thread, the fix as chips below. */
  function fail(kind: Problem, operation?: number) {
    if (operation === undefined) otis.cancel();
    else otis.finish(operation);
    say('assistant', PROBLEM_TEXT[kind], true);
    setProblem(kind);
    setStep('error');
  }

  function retry() {
    if (problem === 'auth') {
      onSignOut();
    } else if (problem === 'load') {
      setProblem(null);
      loadStart(userId)
        .then(([rows, quiz, shownName, plan, people]) => {
          setCategories(rows);
          setPrior(quiz);
          setName(shownName);
          setCompanions(people);
          const first = applyPlan(rows, quiz, plan, people);
          ask(first);
          setStep(first);
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
    const shown = showAll ? categories.map((c) => c.id) : favorites;
    // A pre-selected craving outside the favorites still gets its chip, first.
    const list = cravingPick && !shown.includes(cravingPick) ? [cravingPick, ...shown] : shown;
    chips = (
      <>
        {list.map((id) => (
          <Chip
            key={id}
            label={cravingLabel(id)}
            selected={cravingPick === id}
            feedback={false}
            onPress={() => chooseCraving(id, cravingLabel(id))}
          />
        ))}
        <Chip label="Anything" feedback={false} onPress={() => chooseCraving(null, 'Anything')} />
        {!showAll && <Chip label="More" onPress={() => setShowAll(true)} />}
      </>
    );
  } else if (step === 'company') {
    const selected = Array.isArray(companyPick) ? companyPick : [];
    chips = (
      <>
        {companions.map((c) => (
          <Chip
            key={c.id}
            label={c.name}
            selected={selected.includes(c.id)}
            feedback={false}
            onPress={() => {
              if (busy.current) return;
              haptic('selection');
              setCompanyPick(selected.includes(c.id)
                ? selected.filter((id) => id !== c.id) : [...selected, c.id].sort());
            }}
          />
        ))}
        <Chip label="Solo" feedback={false} selected={companyPick === 'solo'} onPress={() => chooseCompany('solo')} />
        {selected.length > 0 && <Chip label="Continue" feedback={false} onPress={() => chooseCompany(selected)} />}
      </>
    );
  } else if (step === 'budget') {
    chips = BUDGETS.map((b) => (
      <Chip
        key={b.level}
        label={b.label}
        selected={budgetPick === b.level}
        feedback={false}
        onPress={() => chooseBudget(b.level, b.label)}
      />
    ));
  } else if (step === 'distance') {
    chips = DISTANCES.map((d) => (
      <Chip
        key={d.radius}
        label={d.label}
        selected={radiusPick === d.radius}
        feedback={false}
        onPress={() => chooseDistance(d.radius, d.label)}
      />
    ));
  } else if (step === 'results' && !decided && refining && nextQuestion) {
    chips = questionChips(nextQuestion).map((f) => (
      <Chip key={f.label} label={f.label} feedback={false} onPress={() => chooseFollowUp(f.change, f.label, nextQuestion.key)} />
    ));
  } else if (step === 'results' && !decided && refining) {
    chips = followUps(lastRound.radius, lastRound.empty).map((f) => (
      <Chip key={f.label} label={f.label} feedback={false} onPress={() => chooseFollowUp(f.change, f.label)} />
    ));
  } else if (step === 'error' && problem) {
    chips = (
      <>
        {problem === 'denied' && <Chip label="Open Settings" onPress={() => Linking.openSettings()} />}
        <Chip label={problem === 'auth' ? 'Sign in' : 'Try again'} onPress={retry} />
      </>
    );
  }

  /** The information-gain question's options as chips, each the same Change a typed answer
   * would give. Unknown options are dropped. */
  function questionChips(q: NextQuestion): FollowUp[] {
    const out: FollowUp[] = [];
    for (const option of q.options) {
      if (q.key === 'craving' && typeof option === 'string' && names.has(option)) {
        out.push({ label: cravingLabel(option), change: { craving: option } });
      } else if (q.key === 'budget' && typeof option === 'number') {
        const b = BUDGETS.find((x) => x.level === option);
        if (b) out.push({ label: b.label, change: { budget: b.level } });
      } else if (q.key === 'distance' && typeof option === 'number') {
        const d = DISTANCES.find((x) => x.radius === option);
        if (d) out.push({ label: d.label, change: { distance: d.radius } });
      }
    }
    return out;
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
  const decisionGeneration = reasonsCache.current();
  const conversationId = nextId.current;

  return (
    <GlassScreen tabBar>
      <KeyboardAvoidingView behavior="padding" style={styles.fill}>
        <Otis state={otisStatus.state} active={otisStatus.active} keyboard={keyboard} />
        <ScrollWithBar
          scrollRef={scroll}
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
                    envelope={r.envelope}
                    reasonsCache={reasonsCache}
                    generation={r.generation}
                    lifecycle={r.lifecycle}
                    active={otisStatus.active}
                    userId={userId}
                    onDecisionStart={() => {
                      // Reject events from before a parse, new round or search reset,
                      // including the interval before the old cards rerender read-only.
                      if (busy.current || b.id !== latest || sessionId.current !== r.sessionId
                        || nextId.current !== conversationId || !reasonsCache.isCurrent(decisionGeneration)) return false;
                      reasonsCache.invalidate();
                      otis.cancel();
                      const generation = reasonsCache.current();
                      return () => reasonsCache.isCurrent(generation);
                    }}
                    user={user}
                    sessionId={r.sessionId}
                    round={r.round}
                    readOnly={b.id !== latest}
                    onSay={(text) => say('assistant', text)}
                    onPicked={() => remindAfterPick(userId)}
                    onDecided={() => setDecided(true)}
                    final={r.final}
                    onNoneOfThese={rejectRound}
                  />
                )}
              </Fragment>
            );
          })}
          {parsing && otisStatus.active && <TypingBubble />}
          {otisStatus.state === 'thinking' && !parsing && (
            <View style={[styles.bubble, styles.theirs]}>
              <Text accessibilityLiveRegion="polite" style={styles.bubbleText}>
                {step === 'loading' ? 'Finding spots…' : 'Finishing reasons…'}
              </Text>
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
