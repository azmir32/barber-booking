import Ionicons from '@expo/vector-icons/Ionicons';
import { useFocusEffect } from 'expo-router';
import { useCallback, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { ReviewItem } from '@/components/reviews';
import { REVIEW_COLUMNS } from '@/components/shop-reviews';
import { Button, Card, Empty, ErrorText, Field, Row, Screen, T } from '@/components/ui';
import { Spacing } from '@/constants/theme';
import { useNow } from '@/hooks/use-now';
import { useTheme } from '@/hooks/use-theme';
import { t } from '@/lib/lang';
import { useMyShop } from '@/lib/my-shop';
import { averageText, ratingAverage, ratingLabel, REVIEW_MAX_LENGTH, reviewCount, type ShopReview } from '@/lib/reviews';
import { errorMessage, supabase } from '@/lib/supabase';

/** Reviews per page. One more is asked for, to know whether there are more. */
const PAGE = 20;
/** The owner also sees which cut each review is about. */
const OWNER_COLUMNS = `${REVIEW_COLUMNS}, bookings(service_name, starts_at)`;

/** Every review of the shop, newest first, each with a reply the owner can write or change. */
export default function Reviews() {
  const { shop } = useMyShop();
  const theme = useTheme();
  const now = useNow();
  const [rows, setRows] = useState<ShopReview[]>([]);
  const [totals, setTotals] = useState<{ count: number; sum: number } | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Only the newest load fills the list; a slower answer to an older one is dropped.
  const latest = useRef(0);
  const shopId = shop?.id;

  const fetchPage = useCallback(
    (offset: number) =>
      supabase
        .from('reviews')
        .select(OWNER_COLUMNS)
        .eq('shop_id', shopId ?? '')
        .order('created_at', { ascending: false })
        .order('booking_id')
        .range(offset, offset + PAGE),
    [shopId],
  );

  const load = useCallback(async () => {
    if (!shopId) return;
    const request = ++latest.current;
    setLoading(true);
    const [page, counts] = await Promise.all([
      fetchPage(0),
      supabase.from('shops').select('rating_count, rating_sum').eq('id', shopId).single(),
    ]);
    if (request !== latest.current) return;
    setLoading(false);
    if (page.error) return setError(errorMessage(page.error));
    if (counts.error) return setError(errorMessage(counts.error));
    setError(null);
    const list = (page.data ?? []) as unknown as ShopReview[];
    setRows(list.slice(0, PAGE));
    setHasMore(list.length > PAGE);
    setTotals({ count: counts.data.rating_count, sum: counts.data.rating_sum });
  }, [fetchPage, shopId]);

  async function loadMore() {
    const request = latest.current;
    setLoadingMore(true);
    const { data, error } = await fetchPage(rows.length);
    setLoadingMore(false);
    if (request !== latest.current) return;
    if (error) return setError(errorMessage(error));
    const list = (data ?? []) as unknown as ShopReview[];
    setRows((prev) => [...prev, ...list.slice(0, PAGE).filter((r) => !prev.some((p) => p.booking_id === r.booking_id))]);
    setHasMore(list.length > PAGE);
  }

  // On focus, so reviews left meanwhile show when coming back.
  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  if (!shop) return null;
  const average = totals ? ratingAverage(totals.sum, totals.count) : null;
  const replied = (review: ShopReview) =>
    setRows((prev) => prev.map((r) => (r.booking_id === review.booking_id ? review : r)));

  return (
    <Screen edges={['bottom']} onRefresh={load}>
      {totals && average != null ? (
        <View style={styles.summary} role="img" accessibilityLabel={ratingLabel(average, totals.count)}>
          <Row>
            <T variant="title">{averageText(average)}</T>
            <Ionicons name="star" size={26} color={theme.warning} />
          </Row>
          <T variant="muted">{reviewCount(totals.count)}</T>
        </View>
      ) : null}
      {rows.length > 0 ? (
        <T variant="small">{t('Reply to say thanks, or to put right what went wrong. Replies show on your shop’s page.')}</T>
      ) : null}

      {error && rows.length === 0 ? (
        <Empty title={t('Couldn’t load your reviews')} body={t('Check your connection and try again.')}>
          <Button title={t('Try again')} variant="secondary" onPress={load} />
        </Empty>
      ) : error ? (
        <ErrorText message={error} />
      ) : null}
      {loading && rows.length === 0 && !error ? <T variant="muted">{t('Loading reviews…')}</T> : null}
      {!loading && !error && rows.length === 0 ? (
        <Empty
          title={t('No reviews yet')}
          body={t(
            'Customers can rate a cut once you mark it as Done on the Bookings tab, up to 14 days after the cut. Mark cuts Done on the day.',
          )}
        />
      ) : null}

      <View style={styles.list}>
        {rows.map((r) => (
          <OwnerReview key={r.booking_id} review={r} now={now} timeZone={shop.time_zone} onSaved={replied} />
        ))}
      </View>
      {hasMore && !error ? (
        <Button title={t('Show more')} variant="secondary" loading={loadingMore} onPress={loadMore} />
      ) : null}
    </Screen>
  );
}

/** One review, with Reply (or Edit reply) opening a box for the answer right under it. */
function OwnerReview({
  review,
  now,
  timeZone,
  onSaved,
}: {
  review: ShopReview;
  now: number;
  timeZone: string;
  onSaved: (review: ShopReview) => void;
}) {
  const theme = useTheme();
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(review.reply ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const name = review.first_name;

  // An empty reply takes it away.
  async function save(reply: string) {
    setSaving(true);
    setError(null);
    const { data, error } = await supabase.rpc('reply_to_review', { p_booking_id: review.booking_id, p_reply: reply });
    setSaving(false);
    if (error) return setError(errorMessage(error));
    onSaved({ ...review, reply: data.reply, replied_at: data.replied_at });
    setText(data.reply ?? '');
    setEditing(false);
    setDone(data.reply ? t('Reply saved.') : t('Reply removed.'));
  }

  function close() {
    setEditing(false);
    setText(review.reply ?? '');
    setError(null);
  }

  return (
    <Card>
      <ReviewItem review={review} now={now} timeZone={timeZone} replyTitle={t('Your reply')}>
        {editing ? (
          <View style={styles.editor}>
            <Field
              label={review.reply ? t('Edit your reply') : t('Your reply')}
              hint={t('Shown under the review on your shop’s page.')}
              value={text}
              onChangeText={setText}
              placeholder={t('e.g. Thanks for coming, see you next time!')}
              multiline
              autoFocus
              maxLength={REVIEW_MAX_LENGTH}
            />
            <ErrorText message={error} />
            <Row style={{ flexWrap: 'nowrap' }}>
              <Button title={t('Cancel')} variant="secondary" onPress={close} />
              <Button
                title={t('Save reply')}
                onPress={() => save(text)}
                loading={saving}
                disabled={!text.trim() && !review.reply}
                style={{ flex: 1 }}
              />
            </Row>
            {review.reply ? (
              <Button title={t('Remove reply')} variant="ghost" tone="danger" onPress={() => save('')} />
            ) : null}
          </View>
        ) : (
          <View style={styles.actions}>
            {done ? (
              <T variant="small" role="status" accessibilityLiveRegion="polite" style={{ color: theme.success, flex: 1 }}>
                {done}
              </T>
            ) : (
              <View style={{ flex: 1 }} />
            )}
            <Button
              title={review.reply ? t('Edit reply') : t('Reply')}
              variant={review.reply ? 'ghost' : 'secondary'}
              accessibilityLabel={
                review.reply ? t('Edit your reply to {name}', { name }) : t('Reply to {name}', { name })
              }
              onPress={() => {
                setDone(null);
                setText(review.reply ?? '');
                setEditing(true);
              }}
            />
          </View>
        )}
      </ReviewItem>
    </Card>
  );
}

const styles = StyleSheet.create({
  summary: { gap: 2 },
  list: { gap: Spacing.sm },
  editor: { gap: Spacing.sm, marginTop: Spacing.xs },
  actions: { flexDirection: 'row', alignItems: 'center', gap: Spacing.sm },
});
