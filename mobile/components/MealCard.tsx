import { BlurView } from 'expo-blur';
import { useEffect, useState } from 'react';
import {
  Animated,
  Keyboard,
  Modal,
  PanResponder,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from 'react-native';

import { useReduceMotion, useReduceTransparency } from '../lib/accessibility';
import { MAX_DISH } from '../lib/feedback';
import { canEdit, editMeal, type Meal, type MealEdit, mealWhen, slotLabel } from '../lib/meals';
import { BUDGETS } from '../lib/profile';
import { colors, emojiFor, mealCard, radii, spacing, type } from '../theme';
import GlassFrame from './GlassFrame';
import PressScale from './PressScale';
import { Chip, PrimaryButton, SecondaryButton } from './ui';

// Meal detail card (P1-24): a centered square GlassFrame that zooms out of the tapped row and
// shrinks back into it on close (tap outside or swipe down). Reduce Motion: a fade. Edit (live
// meals with went = true) changes what you had, stars, price, and solo / with people through
// edit_meal(); only changed fields are sent, and each one is logged as an edited event.
// Behind it, a light blur of the screen (no dim). Edit mode: Cancel and Save pinned to the
// bottom, equal width, inside the content's inset.

export type Rect = { x: number; y: number; width: number; height: number };

type Props = {
  meal: Meal;
  /** The tapped row, in window coordinates: the card opens from and closes into it. */
  from: Rect;
  categoryName: (id: string | null) => string | null;
  onClose: () => void;
  /** Reloads the meals after a save, so the row and this card show the change. */
  onSaved: () => Promise<void>;
};

const STARS = [1, 2, 3, 4, 5];

function priceText(meal: Meal): string {
  if (meal.priceLevel === null) return 'No price yet';
  const level = '$'.repeat(meal.priceLevel);
  return meal.priceAmount === null ? level : `${level} · $${meal.priceAmount.toFixed(2)}`;
}

function whoText(meal: Meal): string {
  if (meal.companions.length) return `With ${meal.companions.join(', ')}`;
  if (meal.solo === true) return 'Solo';
  if (meal.solo === false) return 'With people';
  return 'Not set';
}

export default function MealCard({ meal, from, categoryName, onClose, onSaved }: Props) {
  const window = useWindowDimensions();
  const reduceMotion = useReduceMotion();
  const reduceTransparency = useReduceTransparency();
  const size = Math.min(mealCard.maxSize, window.width - 2 * spacing.xl);
  const left = (window.width - size) / 2;
  const top = (window.height - size) / 2;

  const [editing, setEditing] = useState(false);
  const [dish, setDish] = useState('');
  const [stars, setStars] = useState<number | null>(null);
  const [price, setPrice] = useState<number | null>(null);
  const [solo, setSolo] = useState<boolean | null>(null);
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);

  // p: 0 = in the row, 1 = open. drag: the swipe down. lift: clears the keyboard while editing.
  const [anim] = useState(() => ({
    p: new Animated.Value(0),
    drag: new Animated.Value(0),
    lift: new Animated.Value(0),
  }));
  const [closing, setClosing] = useState(false);

  // Open: zoom out of the row (a fade with Reduce Motion).
  useEffect(() => {
    const run = reduceMotion
      ? Animated.timing(anim.p, { toValue: 1, duration: mealCard.fadeMs, useNativeDriver: true })
      : Animated.spring(anim.p, { toValue: 1, ...mealCard.openSpring, useNativeDriver: true });
    run.start();
    return () => run.stop();
  }, [anim, reduceMotion]);

  function dismiss() {
    if (closing) return;
    setClosing(true);
    Keyboard.dismiss();
    const duration = reduceMotion ? mealCard.fadeMs : mealCard.closeMs;
    Animated.parallel([
      Animated.timing(anim.p, { toValue: 0, duration, useNativeDriver: true }),
      Animated.timing(anim.drag, { toValue: 0, duration, useNativeDriver: true }),
      Animated.timing(anim.lift, { toValue: 0, duration, useNativeDriver: true }),
    ]).start(() => onClose());
  }

  // Swipe down to close (not while editing, so the form can scroll). Rebuilt each render, which
  // is safe: a drag only sets an Animated value and never re-renders mid-gesture.
  const springBack = () =>
    Animated.spring(anim.drag, { toValue: 0, ...mealCard.openSpring, useNativeDriver: true }).start();
  const pan = PanResponder.create({
    onMoveShouldSetPanResponder: (_, g) => !editing && g.dy > 8 && Math.abs(g.dy) > Math.abs(g.dx),
    onPanResponderMove: (_, g) => anim.drag.setValue(Math.max(0, g.dy)),
    onPanResponderRelease: (_, g) => {
      if (g.dy > mealCard.swipeCloseDy || g.vy > mealCard.swipeCloseVy) dismiss();
      else springBack();
    },
    onPanResponderTerminate: springBack,
  });

  // While editing, the keyboard lifts the card just enough to keep its bottom in view.
  useEffect(() => {
    const bottom = top + size;
    const show = Keyboard.addListener('keyboardWillShow', (e) => {
      const room = e.endCoordinates.screenY - spacing.md - bottom;
      Animated.timing(anim.lift, {
        toValue: Math.min(0, Math.max(room, -top + spacing.xl)),
        duration: e.duration || 250,
        useNativeDriver: true,
      }).start();
    });
    const hide = Keyboard.addListener('keyboardWillHide', (e) => {
      Animated.timing(anim.lift, { toValue: 0, duration: e.duration || 250, useNativeDriver: true }).start();
    });
    return () => {
      show.remove();
      hide.remove();
    };
  }, [anim, top, size]);

  // From the row's rect to the centered square.
  const dx = from.x + from.width / 2 - (left + size / 2);
  const dy = from.y + from.height / 2 - (top + size / 2);
  const zoom = !reduceMotion;
  const transform = [
    { translateX: zoom ? anim.p.interpolate({ inputRange: [0, 1], outputRange: [dx, 0] }) : 0 },
    {
      translateY: Animated.add(
        zoom ? anim.p.interpolate({ inputRange: [0, 1], outputRange: [dy, 0] }) : new Animated.Value(0),
        Animated.add(anim.drag, anim.lift),
      ),
    },
    { scaleX: zoom ? anim.p.interpolate({ inputRange: [0, 1], outputRange: [from.width / size, 1] }) : 1 },
    { scaleY: zoom ? anim.p.interpolate({ inputRange: [0, 1], outputRange: [from.height / size, 1] }) : 1 },
  ];
  // The content shows once the card is mostly open, so text is never seen squashed.
  const contentOpacity = zoom
    ? anim.p.interpolate({ inputRange: [0, 0.6, 1], outputRange: [0, 0, 1], extrapolate: 'clamp' })
    : 1;
  const scrimOpacity = anim.p.interpolate({ inputRange: [0, 1], outputRange: [0, 1], extrapolate: 'clamp' });

  function startEdit() {
    setDish(meal.dish ?? '');
    setStars(meal.stars);
    setPrice(meal.priceTap);
    setSolo(meal.solo);
    setFailed(false);
    setEditing(true);
  }

  async function save() {
    if (saving) return;
    const edit: MealEdit = {};
    const clean = dish.trim();
    if (clean !== (meal.dish ?? '') || (!meal.ateAnswered && clean)) edit.dish = clean;
    if (stars !== null && stars !== meal.stars) edit.stars = stars;
    if (price !== null && price !== meal.priceTap) edit.priceTap = price;
    if (solo !== null && solo !== meal.solo) edit.solo = solo;
    if (Object.keys(edit).length === 0) {
      setEditing(false);
      return;
    }
    Keyboard.dismiss();
    setSaving(true);
    setFailed(false);
    try {
      await editMeal(meal.id, edit);
      await onSaved();
      setEditing(false);
    } catch {
      setFailed(true);
    } finally {
      setSaving(false);
    }
  }

  const had = meal.dish ?? (meal.ateAnswered ? categoryName(meal.category) : null) ?? 'Not answered yet';
  const slot = slotLabel(meal.mealSlot);

  return (
    <Modal transparent visible animationType="none" onRequestClose={dismiss}>
      <Animated.View style={[StyleSheet.absoluteFill, { opacity: scrimOpacity }]}>
        {reduceTransparency ? (
          <View style={[StyleSheet.absoluteFill, styles.veil]} />
        ) : (
          <BlurView intensity={mealCard.backdropBlur} tint={mealCard.backdropTint} style={StyleSheet.absoluteFill} />
        )}
        <Pressable style={StyleSheet.absoluteFill} onPress={dismiss} accessibilityLabel="Close" />
      </Animated.View>
      <Animated.View
        style={[styles.card, { left, top, width: size, height: size, transform }]}
        {...pan.panHandlers}
      >
        <GlassFrame shape="rounded" radius={radii.card} style={{ width: size, height: size }}>
          <Animated.View style={[styles.body, { opacity: contentOpacity }]}>
            <View style={styles.header}>
              <Text style={styles.emoji}>{emojiFor(meal.category)}</Text>
              <Text style={styles.place} numberOfLines={2}>
                {meal.placeName}
              </Text>
              {canEdit(meal) && !editing && (
                <PressScale onPress={startEdit} accessibilityRole="button" hitSlop={12} style={styles.editButton}>
                  <Text style={styles.editText}>Edit</Text>
                </PressScale>
              )}
            </View>

            {editing ? (
              <>
                <ScrollView style={styles.fill} contentContainerStyle={styles.form} keyboardShouldPersistTaps="handled">
                  <TextInput
                    style={styles.input}
                    value={dish}
                    onChangeText={setDish}
                    placeholder="What did you have?"
                    placeholderTextColor={colors.textSecondary}
                    maxLength={MAX_DISH}
                    returnKeyType="done"
                    editable={!saving}
                  />
                  <View style={styles.starRow}>
                    {STARS.map((n) => (
                      <PressScale
                        key={n}
                        onPress={() => setStars(n)}
                        accessibilityRole="button"
                        accessibilityLabel={`${n} star${n > 1 ? 's' : ''}`}
                        accessibilityState={{ selected: stars !== null && n <= stars }}
                        hitSlop={4}
                      >
                        <Text style={[styles.starBig, stars !== null && n <= stars ? styles.starOn : styles.starOff]}>
                          {stars !== null && n <= stars ? '★' : '☆'}
                        </Text>
                      </PressScale>
                    ))}
                  </View>
                  <View style={styles.chips}>
                    {BUDGETS.map((b) => (
                      <Chip key={b.level} label={b.label} selected={price === b.level} onPress={() => setPrice(b.level)} />
                    ))}
                  </View>
                  <View style={styles.chips}>
                    <Chip label="Solo" selected={solo === true} onPress={() => setSolo(true)} />
                    <Chip label="With people" selected={solo === false} onPress={() => setSolo(false)} />
                  </View>
                  {failed && <Text style={styles.error}>Couldn&apos;t save.</Text>}
                </ScrollView>
                {/* Pinned to the card's bottom, inside the body's padding (same inset all round). */}
                <View style={styles.actions}>
                  <View style={styles.action}>
                    <SecondaryButton label="Cancel" onPress={() => setEditing(false)} disabled={saving} />
                  </View>
                  <View style={styles.action}>
                    <PrimaryButton label="Save" onPress={save} busy={saving} />
                  </View>
                </View>
              </>
            ) : (
              <View style={styles.details}>
                <Line label="When" value={mealWhen(meal)} />
                {slot && <Line label="Time" value={slot} />}
                <Line label="Had" value={had} />
                <Line label="Who" value={whoText(meal)} />
                <View style={styles.line}>
                  <Text style={styles.label}>Stars</Text>
                  {meal.stars === null ? (
                    <Text style={styles.valueMuted}>Not rated yet</Text>
                  ) : (
                    <Text style={styles.value} accessibilityLabel={`${meal.stars} of 5 stars`}>
                      {STARS.map((n) => (
                        <Text key={n} style={n <= (meal.stars ?? 0) ? styles.starOn : styles.starOff}>
                          ★
                        </Text>
                      ))}
                    </Text>
                  )}
                </View>
                <Line label="Price" value={priceText(meal)} muted={meal.priceLevel === null} />
              </View>
            )}
          </Animated.View>
        </GlassFrame>
      </Animated.View>
    </Modal>
  );
}

function Line({ label, value, muted = false }: { label: string; value: string; muted?: boolean }) {
  return (
    <View style={styles.line}>
      <Text style={styles.label}>{label}</Text>
      <Text style={muted ? styles.valueMuted : styles.value} numberOfLines={1}>
        {value}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  veil: {
    backgroundColor: colors.glass, // Reduce Transparency: a light veil, no dim
  },
  fill: {
    flex: 1,
  },
  card: {
    position: 'absolute',
  },
  body: {
    flex: 1,
    padding: spacing.xl,
    gap: spacing.lg,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
  },
  emoji: {
    fontSize: mealCard.emojiSize,
  },
  place: {
    flex: 1,
    fontSize: type.heading,
    fontWeight: '700',
    color: colors.text,
  },
  editButton: {
    alignSelf: 'flex-start',
    paddingVertical: spacing.xs,
    paddingHorizontal: spacing.sm,
  },
  editText: {
    fontSize: type.body,
    fontWeight: '700',
    color: colors.accentDark,
  },
  details: {
    gap: spacing.md,
  },
  line: {
    flexDirection: 'row',
    gap: spacing.md,
  },
  label: {
    width: 56,
    fontSize: type.small,
    color: colors.textSecondary,
  },
  value: {
    flex: 1,
    fontSize: type.small,
    fontWeight: '600',
    color: colors.text,
  },
  valueMuted: {
    flex: 1,
    fontSize: type.small,
    color: colors.textSecondary,
  },
  starOn: {
    color: colors.star,
  },
  starOff: {
    color: colors.starEmpty,
  },
  form: {
    gap: spacing.md,
    paddingBottom: spacing.sm,
  },
  input: {
    backgroundColor: colors.glassStrong,
    borderRadius: radii.pill,
    borderWidth: 1,
    borderColor: colors.hairline,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.lg,
    fontSize: type.body,
    color: colors.text,
  },
  starRow: {
    flexDirection: 'row',
    gap: spacing.sm,
  },
  starBig: {
    fontSize: 28,
  },
  chips: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
  },
  error: {
    fontSize: type.small,
    color: colors.error,
  },
  actions: {
    flexDirection: 'row',
    gap: spacing.md,
  },
  action: {
    flex: 1,
  },
});
