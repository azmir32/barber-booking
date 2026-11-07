import { useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';

import { useNow } from '@/hooks/use-now';
import { appCache } from '@/lib/app-cache';
import { useAuth } from '@/lib/auth';
import { cacheKey } from '@/lib/cache';
import type { ClosedDay } from '@/lib/closures';
import type { OwnPhoto } from '@/lib/shop-photos';
import { periodDays, type Summary } from '@/lib/summary';
import { errorMessage, supabase } from '@/lib/supabase';
import { localDateString } from '@/lib/time';
import type { Shop } from '@/lib/types';

export type NewestReview = { rating: number; comment: string; first_name: string };

/** What My shop's Takings, Customers, Reviews, Holidays and Photos cards show; a part not known yet is left out. */
export type ShopCardNumbers = {
  /** The Monday the takings are for, so a new week never opens on last week's. */
  week: string;
  takings?: Summary['totals'];
  customers?: { total: number; due: number };
  reviews?: { count: number; sum: number; newest: NewestReview | null };
  /** The days the shop is closed, from the day asked to 60 days after, with the owner's reason. */
  closures?: ClosedDay[];
  /** The photos of the shop's cuts, in the order customers see them, each with its barber's name. */
  photos?: OwnPhoto[];
};

const cardsKey = (uid: string, shopId: string) => cacheKey(uid, 'shop-cards', shopId);

/**
 * Puts a change to the shop's photos into My shop's kept cards, so they show
 * it at once. The cards still say when the server gave them, for StaleNote
 * and the cache's day, as only the photos changed. Nothing kept, nothing to change.
 */
export function keepPhotos(uid: string, shopId: string, photos: OwnPhoto[]) {
  const key = cardsKey(uid, shopId);
  const kept = appCache.peek<ShopCardNumbers>(key);
  if (kept) appCache.write(key, { ...kept.data, photos }, true, kept.at);
}

/** The photos My shop's kept cards have, for a photo's own screen to start from. */
export function keptPhotos(uid: string, shopId: string): OwnPhoto[] | null {
  return appCache.peek<ShopCardNumbers>(cardsKey(uid, shopId))?.data.photos ?? null;
}

/**
 * My shop's summary cards and its photos: last time's at once, then the
 * server's, asked for on every visit so marking cuts done, a new review, a
 * closed day or a photo changed on its own screen shows on coming back. One
 * small answer for all of them (shop_cards).
 */
export function useShopCards(shop: Shop | null) {
  const uid = useAuth().session?.user.id;
  const now = useNow();
  const shopId = shop?.id;
  const timeZone = shop?.time_zone;
  const [kept] = useState(() => (uid && shopId ? appCache.peek<ShopCardNumbers>(cardsKey(uid, shopId)) : null));
  const [numbers, setNumbers] = useState<ShopCardNumbers | null>(kept?.data ?? null);
  // When the server last answered, and whether that was before this visit.
  const [savedAt, setSavedAt] = useState(kept?.at ?? 0);
  const [fromCache, setFromCache] = useState(Boolean(kept));
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /** Asks the server again; resolves to why that failed, or null. */
  const load = useCallback(async (): Promise<string | null> => {
    if (!shopId || !timeZone) return null;
    setLoading(true);
    const week = periodDays('week', Date.now(), timeZone);
    const { data, error } = await supabase.rpc('shop_cards', { p_from: week.from, p_to: week.to });
    setLoading(false);
    // What was there stays; each card still opens its own screen, which says what went wrong.
    if (error || !data) {
      const message = errorMessage(error);
      setError(message);
      return message;
    }
    const fresh: ShopCardNumbers = { ...(data as Omit<ShopCardNumbers, 'week'>), week: week.from };
    setNumbers(fresh);
    setError(null);
    setSavedAt(Date.now());
    setFromCache(false);
    if (uid) appCache.write(cardsKey(uid, shopId), fresh);
    return null;
  }, [uid, shopId, timeZone]);

  // On focus, so cuts marked done, customers invited, replies sent and days closed show when coming back.
  // Back from a photo's own screen, its change is in the kept cards before the server answers.
  useFocusEffect(
    useCallback(() => {
      const latest = uid && shopId ? appCache.peek<ShopCardNumbers>(cardsKey(uid, shopId)) : null;
      if (latest) setNumbers(latest.data);
      load();
    }, [uid, shopId, load]),
  );

  /** A change to the photos made here (one added), shown at once and kept for next time. */
  const changePhotos = useCallback(
    (next: (list: OwnPhoto[]) => OwnPhoto[]) =>
      setNumbers((current) => {
        if (!current) return current;
        const updated = { ...current, photos: next(current.photos ?? []) };
        if (uid && shopId) keepPhotos(uid, shopId, updated.photos);
        return updated;
      }),
    [uid, shopId],
  );

  const thisWeek = timeZone ? periodDays('week', now, timeZone).from : null;
  const today = timeZone ? localDateString(new Date(now), timeZone) : null;
  return {
    takings: numbers?.week === thisWeek ? numbers?.takings : undefined,
    customers: numbers?.customers,
    reviews: numbers?.reviews,
    // Days kept from an earlier visit that have since gone by are no longer upcoming.
    closures: today == null ? undefined : numbers?.closures?.filter((d) => d.day >= today),
    /** Null until the first answer, with nothing kept from last time. */
    photos: numbers?.photos ?? null,
    changePhotos,
    /** Last visit's numbers, with the server's on their way. */
    refreshing: fromCache && loading,
    /** When the numbers on screen are from, when asking again failed; null otherwise. */
    staleSince: error != null && savedAt ? savedAt : null,
    /** When the server last answered (0 if never); a new answer has the days as they are now. */
    savedAt,
    /** Why asking failed, when it did. */
    error,
    loading,
    reload: load,
  };
}
