import { useEffect, useState } from 'react';
import { AccessibilityInfo } from 'react-native';

type Setting = 'reduceMotionChanged' | 'reduceTransparencyChanged';

function useSetting(event: Setting, read: () => Promise<boolean>): boolean {
  const [on, setOn] = useState(false);
  useEffect(() => {
    let live = true;
    read()
      .then((value) => live && setOn(value))
      .catch(() => undefined);
    const sub = AccessibilityInfo.addEventListener(event, setOn);
    return () => {
      live = false;
      sub.remove();
    };
  }, [event, read]);
  return on;
}

/** iOS Settings > Accessibility > Motion > Reduce Motion. */
export function useReduceMotion(): boolean {
  return useSetting('reduceMotionChanged', AccessibilityInfo.isReduceMotionEnabled);
}

/** iOS Settings > Accessibility > Display & Text Size > Reduce Transparency. */
export function useReduceTransparency(): boolean {
  return useSetting('reduceTransparencyChanged', AccessibilityInfo.isReduceTransparencyEnabled);
}
