import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AppState,
  KeyboardAvoidingView,
  Modal,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import {
  checkFeedback,
  type FeedbackStart,
  MAX_DISH,
  type PendingMeal,
  saveFeedback,
} from '../lib/feedback';
import { cachePending, onForeground, reschedule, stopReminder } from '../lib/notify';
import { haptic } from '../lib/haptics';
import { BUDGETS, type Category, loadCategories } from '../lib/profile';
import { colors, emojiFor, radii, spacing, type } from '../theme';
import PressScale from './PressScale';
import { Chip, Dots, GlassCard, PrimaryButton, TextLink } from './ui';

// Went? -> What did you have? -> stars -> optional price (P1-17, FR11), as a glass pop-up on app
// open and on return to the foreground. "Did you go?" is saved at once. The food, stars, and
// price are held on the device while the user moves forward and Back, then saved in that order
// when they finish (price tap or Skip). If the app closes first, the next open resumes.
// Steps answered from the meal card's Edit are skipped: its dish prefills the food step, and
// with stars already saved the food step is the last one (P2-06).
// It also drives the P1-16 reminder: refreshes its cache on each check, reschedules when the app
// goes to the background, and stops it once "Did you go?" is answered or on "Not now".

type Step = 'went' | 'food' | 'stars' | 'price' | 'thanks';

const THANKS_MS = 1500;
const STAR_ADVANCE_MS = 350; // lets the filled stars show before moving on
const STARS = [1, 2, 3, 4, 5];
const PROGRESS: Partial<Record<Step, number>> = { food: 0, stars: 1, price: 2 };

export default function FeedbackPrompt({ userId }: { userId: string }) {
  const [meal, setMeal] = useState<PendingMeal | null>(null);
  const [step, setStep] = useState<Step>('went');
  const [first, setFirst] = useState<Step>('went'); // no Back to or before this step
  // "I didn't go" on the food step: after an auto-detected visit or a resumed meal.
  const [canUndoWent, setCanUndoWent] = useState(false);
  const [categories, setCategories] = useState<Category[]>([]);
  const [category, setCategory] = useState<string | null>(null);
  const [dish, setDish] = useState('');
  const [stars, setStars] = useState(0);
  const [saving, setSaving] = useState(false);
  const [retry, setRetry] = useState<(() => void) | null>(null);
  const open = useRef(false);
  const saved = useRef({ food: false, stars: false }); // what already reached the database
  const life = useRef({ mounted: true, generation: 0, busy: false });
  const advance = useRef<(() => void) | null>(null);
  const starPick = useRef(0);
  const [foreground, setForeground] = useState(AppState.currentState === 'active');
  const clearAdvance = useCallback(() => { advance.current?.(); advance.current = null; }, []);
  useEffect(() => {
    const current = life.current;
    current.mounted = true;
    return () => { current.mounted = false; current.generation++; clearAdvance(); };
  }, [clearAdvance]);

  useEffect(() => {
    loadCategories()
      .then(setCategories)
      .catch(() => undefined); // the food step then has no chips; Next stays off
  }, []);

  const close = useCallback(() => {
    clearAdvance();
    life.current.generation++;
    life.current.busy = false;
    open.current = false;
    setMeal(null);
    setSaving(false);
    setRetry(null);
  }, [clearAdvance]);

  // Shows the pop-up for what checkFeedback found. A likely visit is recorded first.
  const present = useCallback((start: FeedbackStart) => {
    if (start.kind === 'none' || open.current) return;
    const generation = ++life.current.generation;
    open.current = true;
    const show = (at: Step, undo: boolean) => {
      if (!life.current.mounted || generation !== life.current.generation) return;
      life.current.busy = false;
      setSaving(false);
      saved.current = { food: start.kind === 'resumeStars', stars: !start.meal.askStars };
      const placeCategory = start.meal.categoryId;
      setCategory(placeCategory && placeCategory !== 'other' ? placeCategory : null);
      setDish(start.meal.dish ?? '');
      setStars(0);
      starPick.current = 0;
      setRetry(null);
      setCanUndoWent(undo && start.meal.askStars); // the database refuses it once rated
      setFirst(at);
      setStep(at);
      setMeal(start.meal);
    };
    if (start.kind === 'likely') {
      saveFeedback(start.meal.id, { went: true })
        .then(() => {
          stopReminder(start.meal.id);
          show('food', true);
        })
        .catch(() => show('went', false)); // could not record the visit: ask instead
    } else if (start.kind === 'resumeFood') {
      show('food', true);
    } else if (start.kind === 'resumeStars') {
      show('stars', false);
    } else {
      show('went', false);
    }
  }, []);

  const check = useCallback(() => {
    if (open.current) return;
    const generation = life.current.generation;
    checkFeedback(userId)
      .then(({ start, unanswered }) => {
        if (!life.current.mounted || generation !== life.current.generation) return;
        cachePending(unanswered);
        present(start);
      })
      .catch(() => undefined); // a failed check never interrupts the app; the next open retries
  }, [userId, present]);

  // On open, and each time the app comes back to the foreground. Going to the background is the
  // reminder's "activity" (FR10): it is rescheduled from the cache, with no network call.
  useEffect(() => {
    const current = life.current;
    check();
    const sub = AppState.addEventListener('change', (state) => {
      setForeground(state === 'active');
      if (state !== 'active') clearAdvance();
      if (state === 'active') {
        onForeground();
        check();
      } else if (state === 'background') {
        reschedule();
      }
    });
    return () => { sub.remove(); current.generation++; clearAdvance(); };
  }, [check, clearAdvance]);

  useEffect(() => {
    if (step !== 'thanks' || !meal) return;
    const timer = setTimeout(close, THANKS_MS);
    return () => clearTimeout(timer);
  }, [step, meal, close]);

  // "Did you go?" and "I didn't go": saved right away.
  async function saveWent(went: boolean) {
    if (!meal || life.current.busy) return;
    const generation = life.current.generation;
    life.current.busy = true;
    clearAdvance();
    setSaving(true);
    setRetry(null);
    try {
      await saveFeedback(meal.id, { went });
      if (!life.current.mounted || generation !== life.current.generation) return;
      stopReminder(meal.id);
      haptic('success');
      if (went) {
        setFirst('food');
        setStep('food');
      } else {
        setStep('thanks');
      }
    } catch {
      if (life.current.mounted && generation === life.current.generation) setRetry(() => () => saveWent(went));
    } finally {
      if (life.current.mounted && generation === life.current.generation) {
        life.current.busy = false;
        setSaving(false);
      }
    }
  }

  // Finish: food, stars, then the price if one was tapped. A retry continues where it stopped.
  // chosen: the star just tapped, when finishing straight from the stars step. Stars already
  // saved (meal card Edit): finishes from the food step with no star.
  const finish = useCallback(async function finish(priceTap: number | null, chosen: number = stars) {
    if (!meal || life.current.busy || !category || (!saved.current.stars && chosen === 0)) return;
    const generation = life.current.generation;
    const current = () => life.current.mounted && generation === life.current.generation;
    life.current.busy = true;
    clearAdvance();
    setSaving(true);
    setRetry(null);
    try {
      if (!saved.current.food) {
        const clean = dish.trim();
        await saveFeedback(meal.id, { category, dish: clean ? clean : null });
        if (!current()) return;
        saved.current.food = true;
      }
      if (!saved.current.stars) {
        await saveFeedback(meal.id, { stars: chosen });
        if (!current()) return;
        saved.current.stars = true;
      }
      if (priceTap !== null) await saveFeedback(meal.id, { priceTap });
      if (!current()) return;
      setStep('thanks');
      haptic('success');
    } catch {
      if (current()) setRetry(() => () => finish(priceTap, chosen));
    } finally {
      if (current()) { life.current.busy = false; setSaving(false); }
    }
  }, [meal, category, dish, stars, clearAdvance]);

  // One cancellable delay for either path. A final star gets only the save confirmation;
  // a buffered star gets selection feedback, with no haptic on passive advancement.
  useEffect(() => {
    if (!foreground || step !== 'stars' || stars === 0 || !meal) return;
    let live = true;
    const generation = life.current.generation;
    const timer = setTimeout(() => {
      if (!live || !life.current.mounted || generation !== life.current.generation
        || life.current.busy || starPick.current !== stars) return;
      if (meal.askPrice) setStep('price');
      else void finish(null, stars);
    }, STAR_ADVANCE_MS);
    const stop = () => { live = false; clearTimeout(timer); };
    advance.current = stop;
    return () => { stop(); if (advance.current === stop) advance.current = null; };
  }, [foreground, step, stars, meal, finish]);

  // Back only to steps not yet saved: food and stars are held until finish.
  const canGoBack =
    !saving &&
    (step === 'price' ? !saved.current.stars : step === 'stars' && first === 'food' && !saved.current.food);

  function back() {
    if (life.current.busy) return;
    clearAdvance();
    haptic('light');
    setRetry(null);
    if (step === 'price') {
      setStars(0); // tap again to choose; the old choice would advance at once
      starPick.current = 0;
      setStep('stars');
    } else if (step === 'stars') {
      setStep('food');
    }
  }

  if (!meal) return null;

  const progress = PROGRESS[step];
  const emoji = step === 'thanks' ? '🙌' : emojiFor(step === 'went' ? meal.categoryId : category);

  let title = '';
  let body = null;
  if (step === 'went') {
    title = `Did you go to ${meal.placeName}?`;
    body = (
      <>
        <View style={styles.row}>
          <Chip label="Yes" feedback={false} disabled={saving} onPress={() => saveWent(true)} />
          <Chip label="No" feedback={false} disabled={saving} onPress={() => saveWent(false)} />
        </View>
        <View style={styles.center}>
          <TextLink
            label="Not now"
            onPress={() => {
              stopReminder(meal.id); // the pop-up still asks on later opens
              close();
            }}
          />
        </View>
      </>
    );
  } else if (step === 'food') {
    // The place's category first, then the rest.
    const ordered = [
      ...categories.filter((c) => c.id === meal.categoryId),
      ...categories.filter((c) => c.id !== meal.categoryId),
    ];
    title = 'What did you have?';
    body = (
      <>
        <ScrollView style={styles.chipScroll} contentContainerStyle={styles.row} nestedScrollEnabled>
          {ordered.map((c) => (
            <Chip
              key={c.id}
              label={`${emojiFor(c.id)} ${c.name}`}
              selected={c.id === category}
              feedback="selection"
              disabled={saving}
              onPress={() => setCategory(c.id)}
            />
          ))}
        </ScrollView>
        <TextInput
          style={styles.input}
          placeholder="e.g. wings"
          placeholderTextColor={colors.textSecondary}
          value={dish}
          onChangeText={setDish}
          maxLength={MAX_DISH}
          returnKeyType="done"
        />
        <PrimaryButton
          label={meal.askStars ? 'Next' : 'Done'}
          feedback={meal.askStars ? 'light' : false}
          disabled={!category || saving}
          onPress={() => {
            if (!meal.askStars) {
              finish(null);
              return;
            }
            setStep('stars');
          }}
        />
        {canUndoWent && (
          <View style={styles.center}>
            <TextLink feedback={false} label="I didn't go" onPress={() => saveWent(false)} />
          </View>
        )}
      </>
    );
  } else if (step === 'stars') {
    title = 'How was it?';
    body = (
      <View style={styles.row}>
        {STARS.map((n) => (
          <PressScale
            key={n}
            disabled={saving}
            onPress={() => {
              if (life.current.busy || starPick.current === n) return;
              clearAdvance();
              starPick.current = n;
              setStars(n);
              if (meal.askPrice) haptic('selection');
            }}
            accessibilityRole="button"
            accessibilityLabel={`${n} star${n > 1 ? 's' : ''}`}
            accessibilityState={{ selected: n <= stars }}
            hitSlop={6}
          >
            <Text style={[styles.star, n <= stars ? styles.starOn : styles.starOff]}>
              {n <= stars ? '★' : '☆'}
            </Text>
          </PressScale>
        ))}
      </View>
    );
  } else if (step === 'price') {
    title = 'About how much?';
    body = (
      <>
        <View style={styles.row}>
          {BUDGETS.map((b) => (
            <Chip key={b.level} label={b.label} feedback={false} disabled={saving} onPress={() => finish(b.level)} />
          ))}
        </View>
        <View style={styles.center}>
          <TextLink label="Skip" feedback={false} onPress={() => finish(null)} />
        </View>
      </>
    );
  } else {
    title = 'Thanks!';
  }

  return (
    <Modal transparent animationType="fade" visible onRequestClose={close}>
      <KeyboardAvoidingView behavior="padding" style={styles.scrim}>
        <GlassCard>
          <View style={styles.header}>
            {canGoBack ? <TextLink feedback={false} label="Back" onPress={back} /> : <View />}
            {progress !== undefined && <Dots step={progress} total={3} />}
          </View>
          <View style={styles.badge}>
            <Text style={styles.badgeEmoji}>{emoji}</Text>
          </View>
          <Text style={styles.title}>{title}</Text>
          {body}
          {retry && (
            <View style={styles.row}>
              <Text style={styles.error}>Couldn&apos;t save. Try again.</Text>
              <Chip label="Try again" feedback={false} disabled={saving} onPress={retry} />
            </View>
          )}
        </GlassCard>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const BADGE = 64;

const styles = StyleSheet.create({
  scrim: {
    flex: 1,
    justifyContent: 'center',
    padding: spacing.xxl,
    backgroundColor: colors.scrim,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    minHeight: spacing.xxl,
  },
  badge: {
    alignSelf: 'center',
    width: BADGE,
    height: BADGE,
    borderRadius: BADGE / 2,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.accentSoft,
  },
  badgeEmoji: {
    fontSize: 32,
  },
  title: {
    fontSize: type.heading,
    fontWeight: '700',
    color: colors.text,
    textAlign: 'center',
  },
  row: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
  },
  center: {
    alignItems: 'center',
  },
  chipScroll: {
    maxHeight: 180,
  },
  input: {
    backgroundColor: colors.glassStrong,
    borderRadius: radii.pill,
    borderWidth: 1,
    borderColor: colors.hairline,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.lg,
    fontSize: type.body,
    color: colors.text,
  },
  star: {
    fontSize: 40,
  },
  starOn: {
    color: colors.accent,
  },
  starOff: {
    color: colors.starEmpty,
  },
  error: {
    fontSize: type.small,
    color: colors.error,
  },
});
