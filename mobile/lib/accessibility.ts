import { useEffect, useState } from 'react';
import { AccessibilityInfo } from 'react-native';

type Setting = 'reduceMotionChanged' | 'reduceTransparencyChanged';

function useSetting(event: Setting, read: () => Promise<boolean>, conservative = false): boolean {
  const [on, setOn] = useState(conservative);
  useEffect(() => {
    let live = true;
    let changed = false;
    read()
      .then((value) => live && (!conservative || !changed) && setOn(value))
      .catch(() => undefined);
    const sub = AccessibilityInfo.addEventListener(event, (value) => {
      changed = true;
      setOn(value);
    });
    return () => {
      live = false;
      sub.remove();
    };
  }, [event, read, conservative]);
  return on;
}

/** iOS Reduce Motion. Opt in to staying still until it loads; existing callers keep their default. */
export function useReduceMotion(conservative = false): boolean {
  return useSetting('reduceMotionChanged', AccessibilityInfo.isReduceMotionEnabled, conservative);
}

/** iOS Settings > Accessibility > Display & Text Size > Reduce Transparency. */
export function useReduceTransparency(): boolean {
  return useSetting('reduceTransparencyChanged', AccessibilityInfo.isReduceTransparencyEnabled);
}
