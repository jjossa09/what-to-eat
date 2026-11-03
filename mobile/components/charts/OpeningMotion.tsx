import { createContext, type ReactNode, useContext, useEffect, useMemo, useState } from 'react';
import { AccessibilityInfo, Animated, Easing } from 'react-native';

import { createOpeningMotion, type InsightCards, openingRows } from '../../lib/insights';
import type { InsightSlot } from '../../lib/api';

function createMotion() {
  return createOpeningMotion({
    value: (initial) => new Animated.Value(initial),
    set: (value, final) => value.setValue(final),
    animate: (value, config) => {
      const animation = Animated.timing(value, {
        toValue: 1, duration: config.duration, delay: config.delay,
        easing: Easing.out(Easing.cubic), useNativeDriver: config.useNativeDriver,
        isInteraction: false,
      });
      animation.start();
      return () => animation.stop();
    },
  });
}

const Context = createContext<{
  motion: ReturnType<typeof createMotion>; reduceMotion: boolean | null;
} | null>(null);

/** Mount once per opening, outside loading/refresh branches. No scroll-triggered work. */
export function OpeningMotion({ cards, selectedSlot, children }: {
  cards?: InsightCards; selectedSlot?: InsightSlot; children: ReactNode;
}) {
  const [motion] = useState(createMotion);
  const [reduceMotion, setReduceMotion] = useState<boolean | null>(null);
  useEffect(() => {
    let live = true;
    let changed = false;
    const subscription = AccessibilityInfo.addEventListener('reduceMotionChanged', (on) => {
      changed = true;
      if (live) setReduceMotion(on);
    });
    AccessibilityInfo.isReduceMotionEnabled()
      .then((on) => { if (live && !changed) setReduceMotion(on); })
      .catch(() => { if (live && !changed) setReduceMotion(true); });
    return () => { live = false; subscription.remove(); };
  }, []);
  useEffect(() => {
    if (reduceMotion === true) motion.finish();
    if (cards && reduceMotion !== null) motion.begin(openingRows(cards, selectedSlot), reduceMotion);
  }, [cards, motion, reduceMotion, selectedSlot]);
  useEffect(() => () => motion.finish(), [motion]);
  const context = useMemo(() => ({ motion, reduceMotion }), [motion, reduceMotion]);
  return <Context.Provider value={context}>{children}</Context.Provider>;
}

/** Reusable charts render final values when used without an opening provider, e.g. chat. */
export function useOpeningProgress(id: string): Animated.Value {
  const context = useContext(Context);
  const [final] = useState(() => new Animated.Value(1));
  return context ? context.motion.value(id) : final;
}

export function useTimelineSwitch() {
  const context = useContext(Context);
  return (pointCount: number) => {
    if (context && context.reduceMotion !== null) {
      context.motion.switchTimeline(pointCount, context.reduceMotion);
    }
  };
}
