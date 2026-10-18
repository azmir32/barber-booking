import { useCallback, useEffect, useRef, useState, type Ref } from 'react';
import { View } from 'react-native';

import { BarberFilter, RatingSummary, ReviewItem } from '@/components/reviews';
import { Button, Card, ErrorText, Section, T } from '@/components/ui';
import { Spacing } from '@/constants/theme';
import { barberAverage, reviewFilters, type BarberStars } from '@/lib/barbers';
import { t } from '@/lib/lang';
import { MIN_REVIEWS_SHOWN, reviewCount, type ShopReview } from '@/lib/reviews';
import { errorMessage, supabase } from '@/lib/supabase';

/** Reviews on the page at first, and how many more each Show more brings. */
const FIRST = 3;
const MORE = 10;

/** The name it shows and no account: the database lets nobody read who wrote a review. */
export const REVIEW_COLUMNS = 'booking_id, rating, comment, first_name, reply, replied_at, created_at, barbers(name)';

/**
 * Whose reviews to ask for: a shop's, or one of its barbers'. One barber's go
 * by their id alone: it says which shop, and the database reads them straight
 * off reviews_barber_created_idx. Given the shop as well, Postgres combines
 * both indexes and sorts all of that barber's reviews first.
 */
export const reviewsOf = (shopId: string, barberId: string | null) =>
  barberId ? { barber_id: barberId } : { shop_id: shopId };

/** What is on screen, and for which choice of barber ('' for everyone). */
type Shown = { key: string; reviews: ShopReview[]; hasMore: boolean };

/**
 * The shop page's Reviews: the newest few, and more on request, from
 * everyone or from one barber's chair. Loaded on its own once the shop is,
 * so booking never waits for it, and only for a shop that has reviews.
 */
export function ShopReviews({
  shop,
  barbers,
  now,
  ref,
}: {
  shop: { id: string; time_zone: string; rating_count: number; rating_sum: number };
  /** The shop's barbers as the page loaded them, with their stars: the chips over the reviews. */
  barbers: (BarberStars & { id: string; name: string })[];
  now: number;
  /** The section, so "See reviews" by the shop's name can find it and scroll there. */
  ref?: Ref<View>;
}) {
  const [barberId, setBarberId] = useState<string | null>(null);
  const [shown, setShown] = useState<Shown | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [retries, setRetries] = useState(0);
  const latest = useRef(0);
  const { id: shopId, rating_count: count } = shop;
  const filters = reviewFilters(barbers);
  // A barber no longer among them is everyone again.
  const pickedId = filters.some((b) => b.id === barberId) ? barberId : null;
  const key = pickedId ?? '';

  // One more than shown is asked for, to know whether there are more.
  const fetchPage = useCallback(
    (offset: number, size: number) =>
      supabase
        .from('reviews')
        .select(REVIEW_COLUMNS)
        .match(reviewsOf(shopId, pickedId))
        .order('created_at', { ascending: false })
        .order('booking_id')
        .range(offset, offset + size),
    [shopId, pickedId],
  );

  // Again when the count changes, e.g. a review left meanwhile, or another barber is picked.
  // Only the newest answer counts.
  useEffect(() => {
    if (count === 0) return;
    const request = ++latest.current;
    fetchPage(0, FIRST).then(({ data, error }) => {
      if (request !== latest.current) return;
      if (error) return setError(errorMessage(error));
      setError(null);
      const page = (data ?? []) as unknown as ShopReview[];
      setShown({ key, reviews: page.slice(0, FIRST), hasMore: page.length > FIRST });
    });
  }, [fetchPage, count, key, retries]);

  const current = shown?.key === key;
  // Another barber's on the way: the last ones stay, faded, so the page doesn't jump.
  const loading = !current && !error;
  const reviews = shown && (current || loading) ? shown.reviews : [];

  function pick(id: string | null) {
    setBarberId(id);
    setError(null);
  }

  function retry() {
    setError(null);
    setRetries((n) => n + 1);
  }

  async function loadMore() {
    if (!shown || !current) return;
    const request = latest.current;
    setLoadingMore(true);
    const { data, error } = await fetchPage(shown.reviews.length, MORE);
    setLoadingMore(false);
    if (request !== latest.current) return;
    if (error) return setError(errorMessage(error));
    setError(null);
    const page = (data ?? []) as unknown as ShopReview[];
    setShown((prev) =>
      prev && prev.key === key
        ? {
            key,
            reviews: [...prev.reviews, ...page.slice(0, MORE).filter((r) => !prev.reviews.some((p) => p.booking_id === r.booking_id))],
            hasMore: page.length > MORE,
          }
        : prev,
    );
  }

  // A new shop has nothing to show yet, and no stars to explain.
  if (count === 0) return null;
  // The stars of whoever's reviews these are.
  const stars = filters.find((b) => b.id === pickedId) ?? { rating_count: count, rating_sum: shop.rating_sum };
  return (
    <View ref={ref}>
      <Section title={t('Reviews')}>
        <BarberFilter barbers={filters} selected={pickedId} onSelect={pick} />
        <RatingSummary average={barberAverage(stars)} count={stars.rating_count} />
        {/* With only one or two the stars are left out, but the reviews are still worth reading. */}
        {stars.rating_count < MIN_REVIEWS_SHOWN ? <T variant="muted">{reviewCount(stars.rating_count)}</T> : null}
        {reviews.length ? (
          <View aria-busy={loading} style={{ gap: Spacing.md, opacity: loading ? 0.5 : 1 }}>
            {reviews.map((r) => (
              <Card key={r.booking_id}>
                <ReviewItem review={r} now={now} timeZone={shop.time_zone} />
              </Card>
            ))}
          </View>
        ) : loading ? (
          <T variant="muted">{t('Loading reviews…')}</T>
        ) : null}
        {current && reviews.length === 0 && !error ? <T variant="muted">{t('No reviews yet')}</T> : null}
        {error ? (
          <View style={{ gap: Spacing.sm }}>
            <ErrorText message={`${t('Couldn’t load reviews.')} ${error}`} />
            <Button title={t('Try again')} variant="secondary" onPress={current && reviews.length ? loadMore : retry} />
          </View>
        ) : current && shown.hasMore ? (
          <Button title={t('Show more reviews')} variant="secondary" loading={loadingMore} onPress={loadMore} />
        ) : null}
      </Section>
    </View>
  );
}
