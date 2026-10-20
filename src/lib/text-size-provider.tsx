import AsyncStorage from '@react-native-async-storage/async-storage';
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { Platform, useWindowDimensions, type TextStyle } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { fitText, parseTextSize, TEXT_SIZE_KEY, textScale, type TextSize } from '@/lib/text-size';

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

/**
 * How a piece of text grows here, the app's choice and the phone's together
 * (see fitText), for sizing what holds it: a chair's quarter hour, the room
 * beside a time. `cap` for a crowded place, as given to T's maxScale.
 */
export function useTextFit(cap?: number) {
  const { fontScale } = useWindowDimensions();
  return fitText(useTextScale(), cap, fontScale);
}

// React Navigation's own sizes: a tab's label under its icon, the bar it sits in, and a screen's title in the header.
const TAB_LABEL = 10;
const TAB_BAR = 49;
const HEADER_TITLE = Platform.select({ ios: 17, android: 20, default: 18 });

/**
 * The tab bar's labels grown with the app's text, and the bar as much
 * taller, up to 1.4 times, past which a barber's four tabs no longer fit
 * their Malay names side by side. Nothing at Normal, so the bar is React
 * Navigation's own.
 */
export function useTabBarText(): { tabBarLabelStyle?: TextStyle; barHeight: { height?: number } } {
  const { scale } = fitText(useTextScale(), 1.4);
  const { bottom } = useSafeAreaInsets();
  if (scale === 1) return { barHeight: {} };
  const label = TAB_LABEL * scale;
  // A height of our own replaces the bar's, which counts the phone's bottom inset too.
  return {
    tabBarLabelStyle: { fontSize: label },
    barHeight: { height: TAB_BAR + Math.ceil((label - TAB_LABEL) * 1.3) + bottom },
  };
}

/** A stack screen's title in the header, grown with the app's text up to 1.25 times, so a long Malay one still fits beside Back. */
export function useHeaderTitleStyle(): TextStyle | undefined {
  const { scale } = fitText(useTextScale(), 1.25);
  return scale === 1 ? undefined : { fontSize: HEADER_TITLE * scale };
}
