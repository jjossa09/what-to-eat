import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Notifications from 'expo-notifications';

import { FEEDBACK_CONFIG, pendingPick, type PendingMeal } from './feedback';

// Feedback reminder (P1-16, FR10). Local notifications only, at most one at a time under one
// identifier. "Activity" = the app going to the background: each time, the reminder is
// rescheduled from the cached pending pick, with no network call. Coming back to the foreground
// drops a reminder that has not fired yet. Tapping it opens the app, and the P1-17 pop-up
// (checked on open and on return to the foreground) takes over.

const ID = 'meal-feedback';
const PENDING_KEY = 'reminder.pending'; // the unanswered pick, cached whenever the app has it
const SCHEDULED_KEY = 'reminder.scheduled'; // what is scheduled; a passed fireAt = delivered
const DONE_KEY = 'reminder.done'; // the meal id never to remind about again
const HOUR_MS = 3_600_000;

type Cached = { mealId: string; placeName: string; pickedAt: string };
type Scheduled = { mealId: string; fireAt: string };

// While the app is open: no banner, no list entry, no sound, no badge.
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: false,
    shouldShowList: false,
    shouldPlaySound: false,
    shouldSetBadge: false,
  }),
});

/**
 * When to remind, or null for no reminder: notifyAfterH after now (the last activity), but never
 * before the pop-up would ask (askAfterH after the pick) and never past its window (askUntilH).
 */
export function reminderAt(pickedAt: Date, now: Date, config = FEEDBACK_CONFIG): Date | null {
  const pick = pickedAt.getTime();
  const fireAt = Math.max(now.getTime() + config.notifyAfterH * HOUR_MS, pick + config.askAfterH * HOUR_MS);
  return fireAt <= pick + config.askUntilH * HOUR_MS ? new Date(fireAt) : null;
}

async function read<T>(key: string): Promise<T | null> {
  try {
    const raw = await AsyncStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

async function write(key: string, value: unknown): Promise<void> {
  try {
    if (value === null) await AsyncStorage.removeItem(key);
    else await AsyncStorage.setItem(key, JSON.stringify(value));
  } catch {
    // a lost cache only means a missed reminder; the pop-up on open is the fallback
  }
}

async function cancelScheduled(): Promise<void> {
  await Notifications.cancelScheduledNotificationAsync(ID).catch(() => undefined);
  await write(SCHEDULED_KEY, null);
}

/** Caches the unanswered pick, or clears the cache (and any reminder) when there is none. */
export async function cachePending(meal: PendingMeal | null): Promise<void> {
  if (!meal) {
    await cancelScheduled();
    await write(PENDING_KEY, null);
    return;
  }
  if ((await read<string>(DONE_KEY)) === meal.id) return;
  const cached: Cached = { mealId: meal.id, placeName: meal.placeName, pickedAt: meal.pickedAt.toISOString() };
  await write(PENDING_KEY, cached);
}

/** Activity: (re)schedules the reminder from the cache only. Never rejects. */
export async function reschedule(now: Date = new Date()): Promise<void> {
  try {
    const pending = await read<Cached>(PENDING_KEY);
    if (!pending) return;
    const scheduled = await read<Scheduled>(SCHEDULED_KEY);
    if (scheduled?.mealId === pending.mealId && new Date(scheduled.fireAt) <= now) {
      // Already delivered: at most one per meal. Left in Notification Center.
      await write(DONE_KEY, pending.mealId);
      await write(PENDING_KEY, null);
      await write(SCHEDULED_KEY, null);
      return;
    }
    const permission = await Notifications.getPermissionsAsync();
    const fireAt = permission.granted ? reminderAt(new Date(pending.pickedAt), now) : null;
    if (!fireAt) {
      await cancelScheduled();
      return;
    }
    // Same identifier: replaces the previous request, so there is never a gap.
    await Notifications.scheduleNotificationAsync({
      identifier: ID,
      content: { title: `How was ${pending.placeName}?` },
      trigger: { type: Notifications.SchedulableTriggerInputTypes.DATE, date: fireAt },
    });
    const next: Scheduled = { mealId: pending.mealId, fireAt: fireAt.toISOString() };
    await write(SCHEDULED_KEY, next);
  } catch {
    // never interrupts the app
  }
}

/** Back in the foreground: a reminder that has not fired yet is dropped; leaving reschedules it. */
export async function onForeground(now: Date = new Date()): Promise<void> {
  const scheduled = await read<Scheduled>(SCHEDULED_KEY);
  if (scheduled && new Date(scheduled.fireAt) > now) await cancelScheduled();
}

/**
 * Right after a pick: asks for permission the first time only (denied = do nothing), caches the
 * new pick (one Supabase read, in the foreground), and schedules. Never rejects.
 */
export async function remindAfterPick(userId: string): Promise<void> {
  try {
    const permission = await Notifications.getPermissionsAsync();
    if (!permission.granted && permission.status === 'undetermined') {
      await Notifications.requestPermissionsAsync();
    }
    await cachePending(await pendingPick(userId));
    await reschedule();
  } catch {
    // never interrupts the app
  }
}

/** "Did you go?" answered, or "Not now": no more reminders for this meal. Never rejects. */
export async function stopReminder(mealId: string): Promise<void> {
  await cancelScheduled();
  await Notifications.dismissNotificationAsync(ID).catch(() => undefined);
  await write(PENDING_KEY, null);
  await write(DONE_KEY, mealId);
}

/** Sign-out: nothing scheduled, nothing cached. Never rejects. */
export async function clearReminder(): Promise<void> {
  await cancelScheduled();
  await Notifications.dismissNotificationAsync(ID).catch(() => undefined);
  await write(PENDING_KEY, null);
  await write(DONE_KEY, null);
}
