import { useCallback, useEffect, useRef, useState, type Ref } from 'react';
import { View } from 'react-native';

import { RatingSummary, ReviewItem } from '@/components/reviews';
import { Button, Card, ErrorText, Section, T } from '@/components/ui';
import { Spacing } from '@/constants/theme';
import { t } from '@/lib/lang';
import { MIN_REVIEWS_SHOWN, ratingAverage, reviewCount, type ShopReview } from '@/lib/reviews';
import { errorMessage, supabase } from '@/lib/supabase';

/** Reviews on the page at first, and how many more each Show more brings. */
const FIRST = 3;
const MORE = 10;

/** The name it shows and no account: the database lets nobody read who wrote a review. */
export const REVIEW_COLUMNS = 'booking_id, rating, comment, first_name, reply, replied_at, created_at, barbers(name)';

/**
 * The shop page's Reviews: the newest few, and more on request. Loaded on
 * its own once the shop is, so booking never waits for it, and only for a
 * shop that has reviews.
 */
export function ShopReviews({
  shop,
  now,
  ref,
}: {
  shop: { id: string; time_zone: string; rating_count: number; rating_sum: number };
  now: number;
  /** The section, so "See reviews" by the shop's name can find it and scroll there. */
  ref?: Ref<View>;
}) {
  const [reviews, setReviews] = useState<ShopReview[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const latest = useRef(0);
  const { id: shopId, rating_count: count } = shop;

  // One more than shown is asked for, to know whether there are more.
  const fetchPage = useCallback(
    (offset: number, size: number) =>
      supabase
        .from('reviews')
        .select(REVIEW_COLUMNS)
        .eq('shop_id', shopId)
        .order('created_at', { ascending: false })
        .order('booking_id')
        .range(offset, offset + size),
    [shopId],
  );

  const showFirst = useCallback(({ data, error }: Awaited<ReturnType<typeof fetchPage>>) => {
    setLoading(false);
    if (error) return setError(errorMessage(error));
    setError(null);
    const page = (data ?? []) as unknown as ShopReview[];
    setReviews(page.slice(0, FIRST));
    setHasMore(page.length > FIRST);
  }, []);

  // Again when the count changes, e.g. a review left meanwhile. Only the newest answer counts.
  useEffect(() => {
    if (count === 0) return;
    const request = ++latest.current;
    fetchPage(0, FIRST).then((result) => {
      if (request === latest.current) showFirst(result);
    });
  }, [fetchPage, count, showFirst]);

  async function load() {
    const request = ++latest.current;
    setLoading(true);
    const result = await fetchPage(0, FIRST);
    if (request === latest.current) showFirst(result);
  }

  async function loadMore() {
    const request = latest.current;
    setLoadingMore(true);
    const { data, error } = await fetchPage(reviews.length, MORE);
    setLoadingMore(false);
    if (request !== latest.current) return;
    if (error) return setError(errorMessage(error));
    setError(null);
    const page = (data ?? []) as unknown as ShopReview[];
    setReviews((prev) => [...prev, ...page.slice(0, MORE).filter((r) => !prev.some((p) => p.booking_id === r.booking_id))]);
    setHasMore(page.length > MORE);
  }

  // A new shop has nothing to show yet, and no stars to explain.
  if (count === 0) return null;
  return (
    <View ref={ref}>
      <Section title={t('Reviews')}>
        <RatingSummary average={ratingAverage(shop.rating_sum, count)} count={count} />
        {/* With only one or two the stars are left out, but the reviews are still worth reading. */}
        {count < MIN_REVIEWS_SHOWN ? <T variant="muted">{reviewCount(count)}</T> : null}
        {reviews.map((r) => (
          <Card key={r.booking_id}>
            <ReviewItem review={r} now={now} timeZone={shop.time_zone} />
          </Card>
        ))}
        {loading && reviews.length === 0 && !error ? <T variant="muted">{t('Loading reviews…')}</T> : null}
        {error ? (
          <View style={{ gap: Spacing.sm }}>
            <ErrorText message={`${t('Couldn’t load reviews.')} ${error}`} />
            <Button title={t('Try again')} variant="secondary" onPress={reviews.length ? loadMore : load} />
          </View>
        ) : hasMore ? (
          <Button title={t('Show more reviews')} variant="secondary" loading={loadingMore} onPress={loadMore} />
        ) : null}
      </Section>
    </View>
  );
}
