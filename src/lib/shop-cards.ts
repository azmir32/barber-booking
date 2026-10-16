import { useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';

import { useNow } from '@/hooks/use-now';
import { appCache } from '@/lib/app-cache';
import { useAuth } from '@/lib/auth';
import { cacheKey } from '@/lib/cache';
import type { ShopCustomer } from '@/lib/customers';
import { periodDays, type Summary } from '@/lib/summary';
import { supabase } from '@/lib/supabase';
import type { Shop } from '@/lib/types';

export type NewestReview = { rating: number; comment: string; first_name: string };

/** The numbers on My shop's Takings, Customers and Reviews cards; a part not known yet is left out. */
export type ShopCardNumbers = {
  /** The Monday the takings are for, so a new week never opens on last week's. */
  week: string;
  takings?: Summary['totals'];
  customers?: { total: number; due: number };
  reviews?: { count: number; sum: number; newest: NewestReview | null };
};

/**
 * My shop's summary cards: last time's numbers at once, then the server's,
 * asked for on every visit so marking cuts done or a new review shows on
 * coming back. One small answer each.
 */
export function useShopCards(shop: Shop | null) {
  const uid = useAuth().session?.user.id;
  const now = useNow();
  const shopId = shop?.id;
  const timeZone = shop?.time_zone;
  const [kept] = useState(() => (uid && shopId ? appCache.peek<ShopCardNumbers>(cacheKey(uid, 'shop-cards', shopId)) : null));
  const [numbers, setNumbers] = useState<ShopCardNumbers | null>(kept?.data ?? null);
  // When the server last gave all three, and whether that was before this visit.
  const [savedAt, setSavedAt] = useState(kept?.at ?? 0);
  const [fromCache, setFromCache] = useState(Boolean(kept));
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async () => {
    if (!shopId || !timeZone) return;
    setLoading(true);
    const week = periodDays('week', Date.now(), timeZone);
    const [takings, customers, reviews] = await Promise.all([
      supabase.rpc('shop_summary', { p_from: week.from, p_to: week.to }),
      // A single row carries the counts for everyone, so this stays a small answer.
      supabase.rpc('shop_customers', { p_search: null, p_limit: 1, p_offset: 0 }),
      // The shop row keeps the count and total, and the newest comment comes with it.
      supabase
        .from('shops')
        .select('rating_count, rating_sum, reviews(rating, comment, first_name)')
        .eq('id', shopId)
        .not('reviews.comment', 'is', null)
        .order('created_at', { referencedTable: 'reviews', ascending: false })
        .limit(1, { referencedTable: 'reviews' })
        .maybeSingle(),
    ]);
    setLoading(false);
    const [first] = (customers.data ?? []) as ShopCustomer[];
    const fresh: Omit<ShopCardNumbers, 'week'> = {
      takings: !takings.error && takings.data ? (takings.data as Summary).totals : undefined,
      customers: customers.error ? undefined : { total: first?.total_count ?? 0, due: first?.due_count ?? 0 },
      reviews:
        !reviews.error && reviews.data
          ? {
              count: reviews.data.rating_count,
              sum: reviews.data.rating_sum,
              newest: ((reviews.data.reviews ?? []) as NewestReview[])[0] ?? null,
            }
          : undefined,
    };
    // A part that failed keeps what was there; each card still opens its own screen, which says what went wrong.
    setNumbers((before) => ({
      week: week.from,
      takings: fresh.takings ?? (before?.week === week.from ? before.takings : undefined),
      customers: fresh.customers ?? before?.customers,
      reviews: fresh.reviews ?? before?.reviews,
    }));
    const all = Boolean(fresh.takings && fresh.customers && fresh.reviews);
    setFailed(!all);
    if (!all) return;
    setSavedAt(Date.now());
    setFromCache(false);
    if (uid) appCache.write(cacheKey(uid, 'shop-cards', shopId), { week: week.from, ...fresh });
  }, [uid, shopId, timeZone]);

  // On focus, so cuts marked done, customers invited and replies sent show when coming back.
  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  const thisWeek = timeZone ? periodDays('week', now, timeZone).from : null;
  return {
    takings: numbers?.week === thisWeek ? numbers?.takings : undefined,
    customers: numbers?.customers,
    reviews: numbers?.reviews,
    /** Last visit's numbers, with the server's on their way. */
    refreshing: fromCache && loading,
    /** When the numbers on screen are from, when asking again failed; null otherwise. */
    staleSince: failed && savedAt ? savedAt : null,
    loading,
    reload: load,
  };
}
