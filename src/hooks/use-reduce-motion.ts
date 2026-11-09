import { useEffect, useState } from 'react';
import { AccessibilityInfo } from 'react-native';

/** Whether the phone asks for less motion (Reduce Motion on iOS, Remove animations on Android, the browser's setting). */
export function useReduceMotion(): boolean {
  const [reduce, setReduce] = useState(false);
  useEffect(() => {
    let active = true;
    AccessibilityInfo.isReduceMotionEnabled()
      .then((on) => {
        if (active) setReduce(on);
      })
      .catch(() => {});
    const subscription = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduce);
    return () => {
      active = false;
      // react-native-web returns nothing where the browser can't tell.
      subscription?.remove();
    };
  }, []);
  return reduce;
}
