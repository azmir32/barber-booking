import AsyncStorage from '@react-native-async-storage/async-storage';
import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';

import { appCache } from '@/lib/app-cache';
import { useAuth } from '@/lib/auth';
import { cacheKey } from '@/lib/cache';
import {
  parseMemory,
  readyCardShows,
  readyKey,
  readyProgress,
  readySteps,
  type ReadyMemory,
  type ShopSetup,
} from '@/lib/ready';
import { supabase } from '@/lib/supabase';
import type { Shop } from '@/lib/types';

/** Each flag only ever turns on, so two copies of a shop's memory join without losing any. */
const joined = (a: ReadyMemory, b: ReadyMemory): ReadyMemory => ({
  started: Boolean(a.started || b.started),
  shared: Boolean(a.shared || b.shared),
  closed: Boolean(a.closed || b.closed),
});

/**
 * What My shop's "Get your shop ready" card and its Go live button need: what
 * this phone remembers about the card, and what the shop has (shop_setup),
 * last visit's at once and then the server's. Asked for on each visit, but
 * only while the shop isn't live or the card can still show, so a shop that
 * is up and running sends nothing more.
 */
export function useShopReady(shop: Shop | null) {
  const uid = useAuth().session?.user.id;
  const shopId = shop?.id;
  const key = uid && shopId ? cacheKey(uid, 'shop-setup', shopId) : null;
  // Null until read from the phone, so the card never flashes up for a shop that hid it.
  const [memory, setMemory] = useState<{ shopId: string; value: ReadyMemory } | null>(null);
  const [kept] = useState(() => (key ? appCache.peek<ShopSetup>(key) : null));
  const [setup, setSetup] = useState<ShopSetup | null>(kept?.data ?? null);
  const [savedAt, setSavedAt] = useState(kept?.at ?? 0);
  const [fresh, setFresh] = useState(false);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);

  // Read on each visit, so a card that said the shop is ready is gone on coming back.
  // Seen here before the shop first went live: it stays through going live, for the last step.
  const neverLive = shop != null && shop.published_at == null;
  useFocusEffect(
    useCallback(() => {
      if (!shopId) return;
      let active = true;
      AsyncStorage.getItem(readyKey(shopId))
        .catch(() => null)
        .then((json) => {
          if (!active) return;
          let value = parseMemory(json);
          if (neverLive && !value.started && !value.closed) {
            value = { ...value, started: true };
            AsyncStorage.setItem(readyKey(shopId), JSON.stringify(value)).catch(() => {});
          }
          setMemory((m) => ({ shopId, value: m && m.shopId === shopId ? joined(m.value, value) : value }));
        });
      return () => {
        active = false;
      };
    }, [shopId, neverLive]),
  );

  const mem = memory && memory.shopId === shopId ? memory.value : null;
  const showsCard = Boolean(shop && mem && readyCardShows(shop, mem));
  // Go live and Turn bookings back on check the shop has something to book first.
  const needed = Boolean(shop && (!shop.is_published || showsCard));

  const remember = useCallback(
    (patch: ReadyMemory) => {
      if (!shopId) return;
      setMemory((m) => {
        const value = joined(m && m.shopId === shopId ? m.value : {}, patch);
        AsyncStorage.setItem(readyKey(shopId), JSON.stringify(value)).catch(() => {});
        return { shopId, value };
      });
    },
    [shopId],
  );

  /** The server's answer, or null when it can't be had; kept for next time. */
  const load = useCallback(async (): Promise<ShopSetup | null> => {
    if (!shopId) return null;
    setLoading(true);
    const { data, error } = await supabase.rpc('shop_setup');
    setLoading(false);
    if (error || !data) {
      setFailed(true);
      return null;
    }
    const answer = data as ShopSetup;
    setSetup(answer);
    setFresh(true);
    setFailed(false);
    setSavedAt(Date.now());
    if (key) appCache.write(key, answer);
    return answer;
  }, [shopId, key]);

  // On focus, so a service added or hours saved show as done on coming back.
  useFocusEffect(
    useCallback(() => {
      if (needed) load();
    }, [needed, load]),
  );

  // Every step done, by the server's answer: the card says so on this visit,
  // and the phone already forgets it, so it is gone the next time.
  const saidReady = Boolean(showsCard && fresh && shop && setup && mem && readyProgress(readySteps(shop, setup, mem)).ready);
  useEffect(() => {
    if (saidReady && shopId && mem) {
      AsyncStorage.setItem(readyKey(shopId), JSON.stringify({ ...mem, closed: true })).catch(() => {});
    }
  }, [saidReady, shopId, mem]);

  return {
    setup,
    memory: mem,
    showsCard,
    /** Every step is done, and the card is saying so. */
    saidReady,
    /** Last visit's answer, with the server's on its way. */
    refreshing: needed && !fresh && setup != null && loading,
    loading,
    /** Nothing to show and the server couldn't be asked. */
    failed: failed && setup == null,
    /** When the answer on screen is from, once asking again failed; null otherwise. */
    staleSince: needed && failed && setup != null && savedAt ? savedAt : null,
    reload: load,
    /** The booking link went out: shared, copied or the poster opened. */
    markShared: () => {
      if (showsCard && !mem?.shared) remember({ shared: true });
    },
    /** Hidden early, or closed after it said the shop is ready. */
    hide: () => remember({ closed: true }),
  };
}
