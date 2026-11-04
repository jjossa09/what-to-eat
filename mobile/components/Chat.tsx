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
  companionCall,
  type Change,
  type CompanyAnswer,
  type RefinementKey,
  deviceTimezone,
  type FirstKey,
  getRecommendations,
  localTimeIso,
  type NextQuestion,
  type Pick,
  type QuestionKey,
  type RoundRequest,
  type RoundResponse,
  type TranscriptMessage,
} from '../lib/api';
import { getPosition, type LocationResult, type Position } from '../lib/location';
import { haptic } from '../lib/haptics';
import { changedLine, dispatch, emptySurvey, privateMessage, resolveDate, validInterpretation,
  type Intent, type Patch, type Survey, type SurveyKey } from '../lib/companion';
import { changePreference, draftMeal, nearby, persistPending, type HistoryResult,
  type MealRecord, type Output, type Pending, type Profile } from '../lib/companionActions';
import { withInsightsDeadline } from '../lib/insights';
import { remindAfterPick } from '../lib/notify';
import { OtisController } from '../lib/otis';
import type { Prefill } from '../lib/questionPlan';
import {
  type Category,
  type Companion,
  loadCompanionChoices,
  loadCategories,
  loadTastePrior,
  type TastePrior,
} from '../lib/profile';
import { ReasonsCache, type ReasonsEnvelope, type ReasonsObserver } from '../lib/reasons';
import { colors, otis as otisTheme, radii, spacing, type } from '../theme';
import Composer from './Composer';
import { HistoryCard, MealReferenceCard, NearbyCard, PendingCard } from './CompanionCards';
import Otis from './Otis';
import ResultCards from './ResultCards';
import ScrollWithBar from './ScrollWithBar';
import TypingBubble from './TypingBubble';
import { Chip, GlassScreen } from './ui';

// Companion protocol v2: the server validates patches and owns dynamic question decisions.
// Chip actions are deterministic. Each typed message is redacted and parsed once. Pending
// actions freeze the survey; only explicit confirmation can reach the mutation RPCs.
// Recommendation cards, signed progressive reasons and pick lifecycle stay in ResultCards.

type Step = 'welcome' | 'craving' | 'budget' | 'distance' | 'company' | 'loading' | 'results' | 'error';
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
type Answers = { craving: string | null; budget: number | null; radius: Radius | null; exclude: string[] };

/** Independent start reads; a failed companion read leaves deterministic chips usable. */
function loadStart(userId: string) {
  return Promise.all([loadCategories(), loadTastePrior(userId),
    loadCompanionChoices(userId, true).catch(() => null)]);
}

// Refinement lines (P2-05): fixed, separate from the round-1 wording. No Muse call.
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
function followUps(radius: Radius | null, empty: boolean): FollowUp[] {
  const close = radius !== 35000;
  if (empty) return [close ? FARTHER : SOMETHING_ELSE];
  return [CHEAPER, close ? FARTHER : CLOSER, SOMETHING_ELSE];
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
  const [keyboard, setKeyboard] = useState(false);
  const [otisUnavailable, setOtisUnavailable] = useState(false);
  // Pre-selected chips: from the plan (confident predictions, P2-05) or a typed answer that
  // covered a later question (FR4).
  const [preset, setPreset] = useState<Prefill>({});
  const [companions, setCompanions] = useState<Companion[]>([]);
  const privacyReady = useRef(false);
  const [companyPick, setCompanyPick] = useState<CompanyAnswer>(null);
  const companyAnswer = useRef<CompanyAnswer>(null);
  // After a round: the information-gain question (ML10), or null for the fixed chips. Asked
  // only once refining (after None of these).
  const [nextQuestion, setNextQuestion] = useState<NextQuestion | null>(null);
  // The refinement chips show: after None of these, an empty round, or the cap round.
  const [refining, setRefining] = useState(false);

  // Unsent chat lines: sent with the next round, then cleared (R3).
  const transcript = useRef<TranscriptMessage[]>([]);
  const answers = useRef<Answers>({ craving: null, budget: null, radius: null, exclude: [] });
  const sessionId = useRef<string | null>(null);
  const shownIds = useRef<string[]>([]);
  const pendingChange = useRef<Partial<Change> | undefined>(undefined);
  const pendingEnhancement = useRef(false);
  const firstOfSearch = useRef(true); // the next round is this search's first ("3 spots")
  const nextIsOpen = useRef(false); // the next follow-up answers "What would make it right?"
  const noneOfThese = useRef(false); // sent with the next round: its rejected reason
  const busy = useRef(false); // one answer at a time (a chip tap during a parse is ignored)
  const location = useRef<Promise<LocationResult> | null>(null);
  const nextId = useRef(0);
  const scroll = useRef<ScrollViewInstance>(null);
  const survey = useRef<Survey>(emptySurvey());
  const conversation = useRef<string | null>(null);
  const actionTurn = useRef(0);
  const [pending, setPending] = useState<Pending | null>(null);
  const [actionBusy, setActionBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [duplicate, setDuplicate] = useState(false);
  const [outputs, setOutputs] = useState<{ id: number; output: Output }[]>([]);
  const [choices, setChoices] = useState<MealRecord[]>([]);
  const [reference, setReference] = useState<Extract<Intent, { type: 'rate_meal' }> | null>(null);
  const ratingStars = useRef<number | null>(null);
  const secondAction = useRef<Intent | undefined>(undefined);
  const [offered, setOffered] = useState<Intent | null>(null);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const focusedOnce = useRef(false);
  useFocusEffect(useCallback(() => {
    if (!focusedOnce.current) { focusedOnce.current = true; return; }
    let live = true;
    privacyReady.current = false;
    void loadCompanionChoices(userId, true).then((people) => {
      if (live) { setCompanions(people); privacyReady.current = true; }
    }).catch(() => undefined);
    void withInsightsDeadline(() => loadTastePrior(userId), 5000)
      .then((value) => { if (live) setPrior(value); }).catch(() => undefined);
    return () => { live = false; };
  }, [userId]));

  type SurveyPlan = { state: Survey; next_key: SurveyKey | null; ready: boolean; conversation_id: string };

  function syncSurvey(state: Survey) {
    survey.current = state;
    answers.current = {
      craving: typeof state.craving.value === 'string' ? state.craving.value : null,
      budget: typeof state.budget.value === 'number' ? state.budget.value : null,
      radius: isRadius(typeof state.distance.value === 'number' ? state.distance.value : null)
        ? state.distance.value as Radius : null,
      exclude: state.exclusions,
    };
    companyAnswer.current = state.company.value === 'solo' ? 'solo'
      : Array.isArray(state.company.value) ? state.company.value : null;
    setCompanyPick(companyAnswer.current);
    setPreset({ ...(answers.current.craving ? { craving: answers.current.craving } : {}),
      ...(answers.current.budget ? { budget: answers.current.budget } : {}),
      ...(answers.current.radius ? { radius: answers.current.radius } : {}) });
  }

  async function ensureConversation() {
    if (!conversation.current) {
      const context = await companionCall<{ conversation_id: string }>('/conversation/context');
      conversation.current = context.conversation_id;
    }
    return conversation.current;
  }

  async function planSurvey(patch?: Patch, source: 'chip' | 'typed' = 'typed', recommend = false) {
    const result = await companionCall<SurveyPlan>('/conversation/plan', {
      local_time: localTimeIso(), state: survey.current, patch: patch ?? null, source,
      companion_ids: companions.map((p) => p.id), conversation_id: conversation.current,
      recommend_now: recommend,
    });
    if (!mounted.current) throw new Error('Conversation closed');
    conversation.current = result.conversation_id;
    syncSurvey(result.state);
    return result;
  }

  async function continueSurvey(result?: SurveyPlan, enhance = false) {
    if (!result && step === 'results') return;
    if (!result && isFirst(step) && !survey.current.recommend_now
      && !['confirmed', 'uncertain'].includes(survey.current[step].status)) return;
    const plan = result ?? await planSurvey();
    if (plan.ready) { await fetchRound(undefined, enhance); return; }
    const key = plan.next_key!;
    // This records only actual survey questions, never action or clarification messages.
    survey.current = { ...plan.state, asked: [...plan.state.asked, key] };
    ask(key); setStep(key);
  }

  async function answerField(key: SurveyKey, value: string | number | string[] | null, label: string) {
    if (busy.current || pending || choices.length || reference) return;
    busy.current = true; setParsing(true);
    const operation = otis.begin();
    try {
      record(key, label, { [key]: value }, 'chip');
      const plan = await planSurvey({ [key]: { status: 'confirmed', value } }, 'chip');
      await continueSurvey(plan);
    } catch { say('assistant', "Couldn't update that. Try again."); }
    finally { busy.current = false; setParsing(false); otis.finish(operation); }
  }

  async function cancelPending(acknowledge = true) {
    if ((pending || choices.length || reference) && conversation.current) {
      await companionCall('/conversation/actions/cancel', {
        action_id: pending?.savedId ?? null, conversation_id: conversation.current });
    }
    setPending(null); setChoices([]); setReference(null); setActionError(null); setDuplicate(false);
    secondAction.current = undefined;
    if (acknowledge) say('assistant', 'Cancelled that action.');
  }

  function selectFeedback(meal: MealRecord) {
    setChoices([]);
    setPending({ key: `turn:${actionTurn.current}`, kind: 'rate_meal',
      placeName: `${meal.eaten_on} · ${meal.meal_slot ?? 'Time not set'}`,
      arguments: { meal_id: meal.id, revision: meal.revision, changes: { stars: ratingStars.current } } });
    if (meal.stars !== null) say('assistant', 'This will update your existing rating.');
  }

  async function findNamed(name_: string) {
    const here = await withInsightsDeadline(() => getPosition(), 5000);
    if (!here.ok) throw new Error('Location unavailable');
    location.current = Promise.resolve(here);
    return nearby(name_, here.position, answers.current.radius);
  }

  async function handleAction(intent: Intent) {
    actionTurn.current++;
    setActionError(null); setDuplicate(false);
    if (intent.type === 'log_meal') {
      setPending({ key: `turn:${actionTurn.current}`, kind: 'log_meal',
        arguments: draftMeal(intent, companions),
        ...(intent.date?.kind === 'weekday' ? { dateHint: `Which ${intent.date.value}? Enter the date.` } : {}) });
      if (intent.place_name) {
        const data = await findNamed(intent.place_name);
        setOutputs((out) => [...out, { id: ++nextId.current, output: { kind: 'nearby', data } }]);
      }
    } else if (intent.type === 'rate_meal') {
      const eaten = resolveDate(intent.date);
      if ((intent.date && !eaten) || (intent.reference === 'date' && !eaten)
        || (intent.reference === 'food' && !intent.category)) {
        setReference(intent); return;
      }
      setReference(null);
      const query = new URLSearchParams({ reference: intent.reference });
      if (intent.category) query.set('category', intent.category);
      if (eaten) query.set('eaten_on', eaten);
      if (intent.slot) query.set('slot', intent.slot);
      const found = await companionCall<{ meals: MealRecord[]; ambiguous: boolean; more: boolean; complete: boolean }>(
        `/conversation/meals?${query.toString()}`);
      ratingStars.current = intent.stars;
      if (!found.meals.length) say('assistant', 'No matching meal found.');
      else if (found.ambiguous) {
        say('assistant', found.more ? 'Which meal? Use a date to narrow more matches.' : 'Which meal did you mean?');
        setChoices(found.meals);
      } else selectFeedback(found.meals[0]);
    } else if (intent.type === 'preference_change') {
      const profile = await companionCall<Profile>('/conversation/profile');
      setPending({ key: `turn:${actionTurn.current}`, kind: 'preference_change', arguments: changePreference(profile, intent) });
    } else if (intent.type === 'find_place') {
      const data = await findNamed(intent.name);
      setOutputs((out) => [...out, { id: ++nextId.current, output: { kind: 'nearby', data } }]);
    } else if (intent.type === 'history_query') {
      const data = await companionCall<HistoryResult>('/conversation/history', { range: intent.range,
        chart_id: intent.chart_id, slot: intent.slot, timezone: deviceTimezone() });
      setOutputs((out) => [...out, { id: ++nextId.current, output: { kind: 'history', data } }]);
    }
  }

  async function confirmPending(another = false) {
    if (!pending || busy.current) return;
    busy.current = true; setActionBusy(true); setActionError(null);
    const current = pending.kind === 'log_meal' && another
      ? { ...pending, arguments: { ...pending.arguments, allow_duplicate: true } } as Pending : pending;
    try {
      const context = await ensureConversation();
      const request = await persistPending(current, context);
      if (!mounted.current) return;
      setPending({ ...current, savedId: request.prepared.id });
      const result = await request.save();
      if (!mounted.current) return;
      if (result.status === 'duplicate') { setDuplicate(true); return; }
      setPending(null); setDuplicate(false);
      if (current.kind === 'preference_change') {
        void withInsightsDeadline(() => loadTastePrior(userId), 5000)
          .then(setPrior).catch(() => undefined);
      }
      haptic('success'); say('assistant', current.kind === 'log_meal' ? 'Meal saved.'
        : current.kind === 'rate_meal' ? 'Rating saved.' : 'Taste profile updated.');
      if (secondAction.current) {
        setOffered(secondAction.current); secondAction.current = undefined;
        say('assistant', 'Would you like to handle the other action now?');
      } else await continueSurvey();
    } catch (e) {
      if (mounted.current) setActionError(e instanceof ApiError && e.kind === 'conflict'
        ? 'This record changed; cancel and reopen it.' : "Couldn't save. Check the fields and retry.");
    } finally { busy.current = false; setActionBusy(false); }
  }

  async function parseText(text: string) {
    if (busy.current) return;
    busy.current = true; setParsing(true); setOffered(null);
    // A new message takes ownership immediately, including while parsing fails or waits.
    // An older pick may finish legitimately, but must not decide this newer conversation.
    reasonsCache.invalidate();
    const operation = otis.begin();
    let interpreted = false;
    setUnsent(null);
    try {
      if (!privacyReady.current) {
        const people = await loadCompanionChoices(userId, true);
        if (!mounted.current) return;
        setCompanions(people); privacyReady.current = true;
        say('assistant', 'Ready. Please send that again.');
        return;
      }
      const response: unknown = await companionCall('/conversation/parse', {
        ...privateMessage(text, companions), asked: isFirst(step) ? step : null });
      if (!mounted.current) return;
      if (!validInterpretation(response, new Set((categories ?? []).map((c) => c.id))) || !response.understood) {
        say('assistant', "Didn't catch that. Could you rephrase?"); return;
      }
      interpreted = true;
      const selected = dispatch(response.intents);
      const p = response.patch;
      const supported = !!(p.craving || p.budget || p.distance || p.company || p.exclude?.length
        || p.allow?.length || p.budget_step || p.distance_step || p.something_else || selected.recommend);
      const hasPatch = supported || !!p.unmatched?.length;
      const confirmsPending = !!(pending || choices.length || reference) && selected.confirmation?.type === 'confirm';
      if (pending || choices.length || reference) {
        if (!confirmsPending) await cancelPending();
      } else if (selected.confirmation) say('assistant', 'There is no action waiting for confirmation.');
      if (step === 'results' && decided && hasPatch && !selected.effect && !selected.reads.length) startNewSearch();
      let plan: SurveyPlan | undefined;
      if (hasPatch) {
        const before = survey.current;
        plan = await planSurvey(response.patch, 'typed', selected.recommend);
        const acknowledgement = changedLine(before, plan.state, names);
        if (acknowledgement) say('assistant', acknowledgement);
        if (p.unmatched?.length) say('assistant', "I can't verify that from place data.");
      }
      if (confirmsPending) {
        say('assistant', 'Check the card, then tap Confirm.'); return;
      }
      if (!hasPatch && !selected.effect && !selected.reads.length) {
        if (selected.confirmation?.type === 'cancel') await continueSurvey();
        else if (!selected.confirmation) say('assistant', 'Could you give me a little more detail?');
        return;
      }
      if (selected.effect) {
        secondAction.current = response.intents.filter((i) => ['log_meal', 'rate_meal', 'preference_change'].includes(i.type))[1];
        if (secondAction.current) say('assistant', "Let's handle one action at a time.");
        await handleAction(selected.effect);
      }
      for (const read of selected.reads) await handleAction(read);
      if (selected.effect || selected.reads.length) return;
      if (!supported && step === 'results') return;
      if (step === 'results' && !decided) {
        const p = response.patch;
        const change: Partial<Change> = {
          ...(p.craving?.status === 'confirmed' ? { craving: p.craving.value === null ? 'anything' : String(p.craving.value) } : {}),
          ...(p.budget?.status === 'confirmed' ? { budget: Number(p.budget.value) as 1 | 2 | 3 | 4 } : {}),
          ...(p.distance?.status === 'confirmed' ? { distance: Number(p.distance.value) as Radius } : {}),
          ...(p.budget_step ? { budget: p.budget_step } : {}), ...(p.distance_step ? { distance: p.distance_step } : {}),
          exclude_categories: p.exclude ?? [], something_else: p.something_else ?? false,
        };
        // Relative changes are already applied by /conversation/plan. Send the resulting
        // state once; never step the budget twice on /recommendations.
        record(nextIsOpen.current ? 'open' : 'refine', 'Updated answers', change, 'text', '[structured typed answer]');
        nextIsOpen.current = false;
        await fetchRound(undefined, true);
      } else await continueSurvey(plan, true);
    } catch (e) {
      // Only retry the language request before any validated patch was applied.
      // Replaying a partially completed relative correction could otherwise step it twice.
      if (!interpreted) setUnsent({ text, problem: e instanceof ApiError && e.kind === 'auth' ? 'auth' : 'network' });
      say('assistant', e instanceof ApiError && e.kind === 'auth' ? 'Please sign in again.' : "Couldn't finish that. Please try again.");
    } finally { busy.current = false; setParsing(false); otis.finish(operation); }
  }

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

  useEffect(() => {
    let live = true;
    location.current = getPosition();
    loadStart(userId).then(([rows, quiz, people]) => {
      if (!live) return;
      setCategories(rows); setPrior(quiz); setCompanions(people ?? []); privacyReady.current = people !== null;
      setBubbles([{ id: ++nextId.current, role: 'assistant', text: 'Hey! What are we eating today?' }]);
      setStep('welcome');
    }).catch(() => { if (live) { setProblem('load'); setStep('error'); } });
    return () => { live = false; };
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
  const budgetPick = preset.budget ?? null;
  const radiusPick = preset.radius ?? null;

  function cravingLabel(id: string | null): string {
    return id === null ? 'Anything' : (names.get(id) ?? id);
  }

  // Necessary survey questions -------------------------------------------------

  function chooseCompany(value: Exclude<CompanyAnswer, null>, text?: string) {
    if (busy.current || pending) return;
    const company = value === 'solo' ? 'solo' : value.map((id) => `companion_${companions.findIndex((c) => c.id === id) + 1}`);
    void answerField('company', company, text ?? (value === 'solo' ? 'Solo' : 'With company'));
  }
  function chooseCraving(id: string | null, label: string) { void answerField('craving', id, label); }
  function chooseBudget(level: number, label: string) { void answerField('budget', level, label); }
  function chooseDistance(radius: Radius, label: string) { void answerField('distance', radius, label); }

  // Follow-ups -----------------------------------------------------------------

  /** None of these before the cap: the session stays open; the refinement question follows. */
  function rejectRound(): boolean {
    if (busy.current) return false;
    reasonsCache.invalidate();
    otis.cancel();
    noneOfThese.current = true;
    record('refine', 'None of these', { none_of_these: true }, 'chip');
    askLine('I see, any clue what you may want?', 'refine');
    setRefining(true);
    return true;
  }

  function chooseFollowUp(change: Partial<Change>, label: string, asked?: RefinementKey) {
    if (busy.current) return;
    haptic('light');
    setUnsent(null);
    busy.current = true;
    const patch: Patch = { exclude: change.exclude_categories ?? [], something_else: change.something_else ?? false };
    if (change.craving !== undefined) patch.craving = { status: 'confirmed', value: change.craving === 'anything' ? null : change.craving ?? null };
    if (typeof change.budget === 'number') patch.budget = { status: 'confirmed', value: change.budget };
    else if (change.budget) patch.budget_step = change.budget;
    if (typeof change.distance === 'number') patch.distance = { status: 'confirmed', value: change.distance };
    else if (change.distance) patch.distance_step = change.distance;
    record(asked ?? 'refine', label, change, 'chip');
    void planSurvey(patch, 'chip').then(() => fetchRound()).catch(() => {
      say('assistant', "Couldn't update the search.");
    }).finally(() => { busy.current = false; });
  }

  function startNewSearch() {
    reasonsCache.invalidate(); otis.cancel();
    sessionId.current = null; shownIds.current = []; transcript.current = [];
    pendingChange.current = undefined; nextIsOpen.current = false; firstOfSearch.current = true;
    setNextQuestion(null); setRefining(false); noneOfThese.current = false;
    survey.current = emptySurvey(); conversation.current = null; companyAnswer.current = null;
    answers.current = { craving: null, budget: null, radius: null, exclude: [] };
    setCompanyPick(null); setPreset({}); setShowAll(false); setDecided(false); setStep('welcome');
    setPending(null); setChoices([]); setReference(null); secondAction.current = undefined;
    setActionError(null); setDuplicate(false); setOffered(null);
    say('assistant', 'Hey! What are we eating today?');
  }

  function sendText(text: string) {
    if (busy.current) return;
    say('user', text);
    void parseText(text);
  }

  // Rounds ---------------------------------------------------------------------

  function roundLine(result: RoundResponse, first: boolean): string | null {
    if (result.best_so_far) return result.picks.length ? 'Best so far.' : null;
    if (!result.picks.length) return 'No spots nearby.';
    return first ? 'Here are 3 spots.' : 'Here are a few more.';
  }

  async function fetchRound(change?: Partial<Change>, enhance = false) {
    reasonsCache.invalidate();
    const operation = otis.begin();
    pendingChange.current = change;
    pendingEnhancement.current = enhance;
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
              asked_order: survey.current.asked,
            }),
        exclude_ids: shownIds.current,
        transcript: transcript.current,
        survey: survey.current,
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
      setLastRound({ radius: answers.current.radius ?? CLOSE, empty: !result.best_so_far && result.picks.length === 0 });
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
            // Deterministic chips keep template reasons and trigger zero Muse calls.
            // Typed recommendation rounds retain #82's optional signed enhancement.
            envelope: enhance ? result.reasons_envelope : null, generation, lifecycle },
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
        .then(([rows, quiz, people]) => {
          setCategories(rows);
          setPrior(quiz);
          setCompanions(people ?? []); privacyReady.current = people !== null;
          setStep('welcome');
          say('assistant', 'Hey! What are we eating today?');
        })
        .catch(() => fail('load'));
    } else {
      fetchRound(pendingChange.current, pendingEnhancement.current);
    }
  }

  // Chips for the current step (none while loading or after a decision), then the composer,
  // which is always there (P1-19).
  let chips: ReactNode = null;
  if ((step === 'craving' || step === 'welcome') && categories) {
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
  if (pending || choices.length || reference) chips = null;

  const composerOff = step === 'loading' || step === 'error' || !categories;

  const latest = rounds.length ? rounds[rounds.length - 1].bubbleId : null;
  const decisionGeneration = reasonsCache.current();
  const conversationId = nextId.current;

  return (
    <GlassScreen tabBar>
      <KeyboardAvoidingView behavior="padding" style={styles.fill}>
        <ScrollWithBar
          scrollRef={scroll}
          contentContainerStyle={[styles.thread, {
            paddingTop: otisUnavailable ? 0
              : (keyboard ? otisTheme.compactSize : otisTheme.size) + 2 * spacing.sm + spacing.xs,
          }]}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="interactive"
          onContentSizeChange={() => scroll.current?.scrollToEnd({ animated: true })}
        >
          {!categories && step !== 'error' && <ActivityIndicator style={styles.spinner} />}
          {[...bubbles.map((bubble) => ({ id: bubble.id, bubble })), ...outputs]
            .sort((a, b) => a.id - b.id).map((entry) => {
            if ('output' in entry) {
              const { id, output } = entry;
              return output.kind === 'history'
                ? <HistoryCard key={id} data={output.data} categories={categories ?? []} people={companions} />
                : <NearbyCard key={id} data={output.data} onSelect={pending?.kind === 'log_meal' ? (place) => {
                  if (busy.current) return;
                  const meal = pending.arguments as import('../lib/companionActions').MealDraft;
                  setPending({ ...pending, placeName: place.name, arguments: { ...meal, place_id: place.id } });
                } : undefined} />;
            }
            const b = entry.bubble;
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
          {!!choices.length && <View style={styles.chips}>{choices.map((meal) => <Chip key={meal.id}
            label={`${meal.eaten_on} · ${meal.meal_slot ?? 'Time not set'} · ${meal.dish
              ?? (meal.source === 'backfill' || meal.ate_at ? names.get(meal.category_id ?? '') : null) ?? 'Meal'}`}
            onPress={() => { if (!busy.current) selectFeedback(meal); }} />)}<Chip label="Cancel" onPress={() => {
              if (busy.current) return;
              void cancelPending().then(() => continueSurvey()).catch(() => setActionError("Couldn't cancel. Retry."));
            }} /></View>}
          {reference && <MealReferenceCard reference={reference} categories={categories ?? []}
            onFind={(intent) => {
              if (busy.current) return;
              busy.current = true;
              void handleAction(intent).catch(() => say('assistant', "Couldn't find that meal."))
                .finally(() => { busy.current = false; });
            }} onCancel={() => { if (busy.current) return;
              void cancelPending().then(() => continueSurvey()).catch(() => setActionError("Couldn't cancel. Retry.")); }} />}
          {pending && <PendingCard key={pending.key} pending={pending} categories={categories ?? []} people={companions}
            busy={actionBusy} error={actionError} duplicate={duplicate} onConfirm={confirmPending}
            onChange={(value) => { setPending(value); setDuplicate(false); setActionError(null); }}
            onCancel={() => { if (busy.current) return;
              void cancelPending().then(() => continueSurvey()).catch(() => setActionError("Couldn't cancel. Retry.")); }}
            onWhere={(text) => {
              if (busy.current) return;
              busy.current = true; setActionBusy(true);
              void findNamed(text).then((data) => setOutputs((out) => [...out,
                { id: ++nextId.current, output: { kind: 'nearby', data } }]))
                .catch(() => setActionError("Couldn't find places. Retry."))
                .finally(() => { busy.current = false; setActionBusy(false); });
            }} />}
          {actionError && !pending && <Text style={styles.errorText}>{actionError}</Text>}
          {offered && <Chip label="Handle the other action" onPress={() => {
            if (busy.current) return;
            busy.current = true; setOffered(null);
            void handleAction(offered).catch(() => say('assistant', "Couldn't open that action."))
              .finally(() => { busy.current = false; });
          }} />}
          {parsing && otisStatus.active && <TypingBubble />}
          {otisStatus.state === 'thinking' && !parsing && (
            <View style={[styles.bubble, styles.theirs]}>
              <Text accessibilityLiveRegion="polite" style={styles.bubbleText}>
                {step === 'loading' ? 'Finding spots…' : 'Finishing reasons…'}
              </Text>
            </View>
          )}
        </ScrollWithBar>
        {/* Draw glass after the conversation so it samples messages scrolling beneath it. */}
        <Otis state={otisStatus.state} active={otisStatus.active} keyboard={keyboard}
          onUnavailable={() => setOtisUnavailable(true)} />
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
