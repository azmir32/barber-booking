import AsyncStorage from '@react-native-async-storage/async-storage';
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { AppState } from 'react-native';

import { isSeenKey, NEWS_LINES, nextSeen, seenKey, type ShopChanges } from '@/lib/news';
import { supabase } from '@/lib/supabase';

type ShopNews = {
  /** The server's latest answer; null until the first one. */
  news: ShopChanges | null;
  /** The newest change this phone has seen; null if it has never looked. */
  seen: string | null;
  refresh: () => Promise<void>;
  /** Got it: everything so far counts as seen on this phone. */
  markSeen: () => void;
};

const ShopNewsContext = createContext<ShopNews | null>(null);

/** How often the badge asks again while the app is open. */
const EVERY_MS = 60_000;

/**
 * What customers changed since this phone last looked, for the barber tabs:
 * one small call when the app opens or comes back, and once a minute.
 */
export function ShopNewsProvider({ shopId, children }: { shopId: string | null; children: ReactNode }) {
  const [seen, setSeen] = useState<string | null>(null);
  // Which shop's mark has been read from the phone; nothing is asked before it is.
  const [readFor, setReadFor] = useState<string | null>(null);
  const [news, setNews] = useState<ShopChanges | null>(null);
  const seenRef = useRef<string | null>(null);
  const request = useRef(0);
  const ready = shopId !== null && readFor === shopId;

  useEffect(() => {
    if (!shopId) return;
    let active = true;
    AsyncStorage.getItem(seenKey(shopId))
      .catch(() => null)
      .then((saved) => {
        if (!active) return;
        seenRef.current = saved || null;
        setSeen(saved || null);
        setNews(null);
        setReadFor(shopId);
      });
    return () => {
      active = false;
    };
  }, [shopId]);

  const refresh = useCallback(async () => {
    if (!ready) return;
    const ask = ++request.current;
    const { data, error } = await supabase.rpc('shop_changes', { p_since: seenRef.current, p_limit: NEWS_LINES });
    // A newer ask or a Got it while this one was out: this answer counts from an older mark.
    // On an error the last answer stays; the next minute tries again.
    if (ask !== request.current || error || !data) return;
    setNews(data as ShopChanges);
  }, [ready]);

  useEffect(() => {
    if (!ready) return;
    refresh();
    const timer = setInterval(() => {
      // A phone with the app in the background asks nothing until it is back.
      if (AppState.currentState === 'active') refresh();
    }, EVERY_MS);
    const listener = AppState.addEventListener('change', (state) => {
      if (state === 'active') refresh();
    });
    return () => {
      clearInterval(timer);
      listener.remove();
    };
  }, [ready, refresh]);

  const markSeen = useCallback(() => {
    if (!shopId) return;
    const next = nextSeen(seenRef.current, news);
    request.current++;
    if (next && next !== seenRef.current) {
      seenRef.current = next;
      setSeen(next);
      AsyncStorage.setItem(seenKey(shopId), next).catch(() => {});
    }
    // Cleared at once; anything newer than the mark shows on the next ask.
    setNews((n) => n && { since: next ?? n.since, count: 0, latest: null, changes: [] });
  }, [news, shopId]);

  return (
    <ShopNewsContext.Provider value={{ news: ready ? news : null, seen, refresh, markSeen }}>
      {children}
    </ShopNewsContext.Provider>
  );
}

/**
 * Forgets what this phone has seen at every shop. For the demo's Start again:
 * the sample shops keep their ids, so an old mark would hide the fresh sample changes.
 */
export async function forgetSeen() {
  try {
    const keys = await AsyncStorage.getAllKeys();
    await AsyncStorage.multiRemove(keys.filter(isSeenKey));
  } catch {
    // Nothing kept on this phone.
  }
}

export function useShopNews(): ShopNews {
  const ctx = useContext(ShopNewsContext);
  if (!ctx) throw new Error('useShopNews must be used inside ShopNewsProvider');
  return ctx;
}
