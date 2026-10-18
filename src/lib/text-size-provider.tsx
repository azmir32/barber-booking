import AsyncStorage from '@react-native-async-storage/async-storage';
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';

import { parseTextSize, TEXT_SIZE_KEY, textScale, type TextSize } from '@/lib/text-size';

type TextSizeState = { size: TextSize; scale: number; setSize: (size: TextSize) => void };

// Outside the provider (the set-up warning in the root layout) text is Normal.
const TextSizeContext = createContext<TextSizeState>({ size: 'normal', scale: 1, setSize: () => {} });

/**
 * Loads the text size kept on this phone before showing anything, so the
 * app never opens small and then jumps. Changing it re-renders the text
 * where it is, without starting the screen over.
 */
export function TextSizeProvider({ children }: { children: ReactNode }) {
  const [size, setSizeState] = useState<TextSize>('normal');
  const [ready, setReady] = useState(false);

  useEffect(() => {
    AsyncStorage.getItem(TEXT_SIZE_KEY)
      .then((saved) => setSizeState(parseTextSize(saved)))
      .catch(() => {})
      .finally(() => setReady(true));
  }, []);

  if (!ready) return null;

  const setSize = (next: TextSize) => {
    setSizeState(next);
    AsyncStorage.setItem(TEXT_SIZE_KEY, next).catch(() => {});
  };

  return <TextSizeContext.Provider value={{ size, scale: textScale(size), setSize }}>{children}</TextSizeContext.Provider>;
}

export function useTextSize(): TextSizeState {
  return useContext(TextSizeContext);
}

/** How much the app's own text sizes grow by: 1 at Normal. The phone's setting comes on top, on iOS and Android. */
export function useTextScale(): number {
  return useContext(TextSizeContext).scale;
}
