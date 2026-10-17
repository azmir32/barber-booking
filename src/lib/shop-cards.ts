import { useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';

import { useNow } from '@/hooks/use-now';
import { appCache } from '@/lib/app-cache';
import { useAuth } from '@/lib/auth';
import { cacheKey } from '@/lib/cache';
import type { ClosedDay } from '@/lib/closures';
import { periodDays, type Summary } from '@/lib/summary';
import { errorMessage, supabase } from '@/lib/supabase';
import { localDateString } from '@/lib/time';
import type { Shop } from '@/lib/types';

export type NewestReview = { rating: number; comment: string; first_name: string };

/** The numbers on My shop's Takings, Customers, Reviews and Holidays cards; a part not known yet is left out. */
export type ShopCardNumbers = {
  /** The Monday the takings are for, so a new week never opens on last week's. */
  week: string;
  takings?: Summary['totals'];
  customers?: { total: number; due: number };
  reviews?: { count: number; sum: number; newest: NewestReview | null };
  /** The days the shop is closed, from the day asked to 60 days after, with the owner's reason. */
  closures?: ClosedDay[];
};

/**
 * My shop's summary cards: last time's numbers at once, then the server's,
 * asked for on every visit so marking cuts done, a new review or a closed day
 * shows on coming back. One small answer for all of them (shop_cards).
 */
export function useShopCards(shop: Shop | null) {
  const uid = useAuth().session?.user.id;
  const now = useNow();
  const shopId = shop?.id;
  const timeZone = shop?.time_zone;
  const [kept] = useState(() => (uid && shopId ? appCache.peek<ShopCardNumbers>(cacheKey(uid, 'shop-cards', shopId)) : null));
  const [numbers, setNumbers] = useState<ShopCardNumbers | null>(kept?.data ?? null);
  // When the server last answered, and whether that was before this visit.
  const [savedAt, setSavedAt] = useState(kept?.at ?? 0);
  const [fromCache, setFromCache] = useState(Boolean(kept));
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!shopId || !timeZone) return;
    setLoading(true);
    const week = periodDays('week', Date.now(), timeZone);
    const { data, error } = await supabase.rpc('shop_cards', { p_from: week.from, p_to: week.to });
    setLoading(false);
    // What was there stays; each card still opens its own screen, which says what went wrong.
    if (error || !data) return setError(errorMessage(error));
    const fresh: ShopCardNumbers = { ...(data as Omit<ShopCardNumbers, 'week'>), week: week.from };
    setNumbers(fresh);
    setError(null);
    setSavedAt(Date.now());
    setFromCache(false);
    if (uid) appCache.write(cacheKey(uid, 'shop-cards', shopId), fresh);
  }, [uid, shopId, timeZone]);

  // On focus, so cuts marked done, customers invited, replies sent and days closed show when coming back.
  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  const thisWeek = timeZone ? periodDays('week', now, timeZone).from : null;
  const today = timeZone ? localDateString(new Date(now), timeZone) : null;
  return {
    takings: numbers?.week === thisWeek ? numbers?.takings : undefined,
    customers: numbers?.customers,
    reviews: numbers?.reviews,
    // Days kept from an earlier visit that have since gone by are no longer upcoming.
    closures: today == null ? undefined : numbers?.closures?.filter((d) => d.day >= today),
    /** Last visit's numbers, with the server's on their way. */
    refreshing: fromCache && loading,
    /** When the numbers on screen are from, when asking again failed; null otherwise. */
    staleSince: error != null && savedAt ? savedAt : null,
    /** Why asking failed, when it did. */
    error,
    loading,
    reload: load,
  };
}
