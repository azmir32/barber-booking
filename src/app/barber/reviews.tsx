import Ionicons from '@expo/vector-icons/Ionicons';
import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, findNodeHandle, Platform, StyleSheet, View } from 'react-native';

import { BarberFilter, ReviewItem } from '@/components/reviews';
import { REVIEW_COLUMNS, reviewsOf } from '@/components/shop-reviews';
import { Badge, Button, Card, Chip, Empty, ErrorText, Field, Row, Screen, T } from '@/components/ui';
import { APP_NAME } from '@/constants/brand';
import { Spacing } from '@/constants/theme';
import { useNow } from '@/hooks/use-now';
import { useTheme } from '@/hooks/use-theme';
import { reviewFilters, type BarberStars } from '@/lib/barbers';
import { t } from '@/lib/lang';
import { useMyShop } from '@/lib/my-shop';
import {
  REPORT_COLUMNS,
  REPORT_NOTE_MAX_LENGTH,
  REPORT_REASONS,
  reasonLabel,
  reportState,
  reportStatus,
  type ReportReason,
  type ReviewReport,
} from '@/lib/review-reports';
import { averageText, ratingAverage, ratingLabel, REVIEW_MAX_LENGTH, reviewCount, type ShopReview } from '@/lib/reviews';
import { errorMessage, supabase } from '@/lib/supabase';
import { useBigText } from '@/lib/text-size-provider';

/** Reviews per page. One more is asked for, to know whether there are more. */
const PAGE = 20;
/**
 * The owner also sees which cut each review is about, whether the team
 * removed it, and their report of it: one object or null, as there is one
 * report a review at most.
 */
const OWNER_COLUMNS = `${REVIEW_COLUMNS}, bookings(service_name, starts_at), removed, report:review_reports(${REPORT_COLUMNS})`;

/** A barber with reviews, with their own figures: counts and totals, never who rated them. */
type ReviewedBarber = BarberStars & { id: string; name: string };

/**
 * Every review of the shop, newest first, each with a reply the owner can
 * write or change; or one barber's, with each barber's average on the chips.
 */
export default function Reviews() {
  const { shop } = useMyShop();
  const theme = useTheme();
  const now = useNow();
  const [rows, setRows] = useState<ShopReview[]>([]);
  // Whose reviews `rows` are: '' for everyone, else a barber's id; null before the first answer.
  const [rowsFor, setRowsFor] = useState<string | null>(null);
  const [totals, setTotals] = useState<{ count: number; sum: number } | null>(null);
  const [team, setTeam] = useState<ReviewedBarber[]>([]);
  const [barberId, setBarberId] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Only the newest load fills the list; a slower answer to an older one is dropped.
  const latest = useRef(0);
  const shopId = shop?.id;
  const filters = reviewFilters(team);
  const pickedId = filters.some((b) => b.id === barberId) ? barberId : null;

  const fetchPage = useCallback(
    (offset: number) =>
      supabase
        .from('reviews')
        .select(OWNER_COLUMNS)
        .match(reviewsOf(shopId ?? '', pickedId))
        .order('created_at', { ascending: false })
        .order('booking_id')
        .range(offset, offset + PAGE),
    [shopId, pickedId],
  );

  const load = useCallback(async () => {
    if (!shopId) return;
    const request = ++latest.current;
    setLoading(true);
    const [page, counts] = await Promise.all([
      fetchPage(0),
      // The shop's figures, and each barber's who has reviews, in the team's order.
      supabase
        .from('shops')
        .select('rating_count, rating_sum, barbers(id, name, rating_count, rating_sum)')
        .eq('id', shopId)
        .gt('barbers.rating_count', 0)
        .order('sort_order', { referencedTable: 'barbers' })
        .order('created_at', { referencedTable: 'barbers' })
        .single(),
    ]);
    if (request !== latest.current) return;
    setLoading(false);
    if (page.error) return setError(errorMessage(page.error));
    if (counts.error) return setError(errorMessage(counts.error));
    setError(null);
    const list = (page.data ?? []) as unknown as ShopReview[];
    setRows(list.slice(0, PAGE));
    setRowsFor(pickedId ?? '');
    setHasMore(list.length > PAGE);
    setTotals({ count: counts.data.rating_count, sum: counts.data.rating_sum });
    setTeam(counts.data.barbers as ReviewedBarber[]);
  }, [fetchPage, shopId, pickedId]);

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

  // On focus, so reviews left meanwhile show when coming back; and for another barber's.
  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  if (!shop) return null;
  const average = totals ? ratingAverage(totals.sum, totals.count) : null;
  // Another barber's are on the way: the last ones stay, faded, until they come.
  const stale = rowsFor !== (pickedId ?? '');
  // If they couldn't come, the last ones would be the wrong barber's.
  const listed = stale && !loading ? [] : rows;
  const replied = (review: ShopReview) =>
    setRows((prev) => prev.map((r) => (r.booking_id === review.booking_id ? review : r)));

  return (
    <Screen edges={['bottom']} onRefresh={load}>
      {totals && average != null ? (
        <View style={styles.summary} role="img" accessible accessibilityLabel={ratingLabel(average, totals.count)}>
          <Row>
            <T variant="title">{averageText(average)}</T>
            <Ionicons aria-hidden name="star" size={26} color={theme.warning} />
          </Row>
          <T variant="muted">{reviewCount(totals.count)}</T>
        </View>
      ) : null}
      {totals ? (
        <BarberFilter
          barbers={filters}
          selected={pickedId}
          onSelect={setBarberId}
          shopStars={{ rating_count: totals.count, rating_sum: totals.sum }}
        />
      ) : null}
      {listed.length > 0 ? (
        <T variant="small">{t('Reply to say thanks, or to put right what went wrong. Replies show on your shop’s page.')}</T>
      ) : null}

      {error && listed.length === 0 ? (
        <Empty title={t('Couldn’t load your reviews')} body={t('Check your connection and try again.')}>
          <Button title={t('Try again')} variant="secondary" onPress={load} />
        </Empty>
      ) : error ? (
        <ErrorText message={error} />
      ) : null}
      {loading && listed.length === 0 && !error ? <T variant="muted">{t('Loading reviews…')}</T> : null}
      {!loading && !error && !stale && listed.length === 0 ? (
        <Empty
          title={t('No reviews yet')}
          body={t(
            'Customers can rate a cut once you mark it as Done on the Bookings tab, up to 14 days after the cut. Mark cuts Done on the day.',
          )}
        />
      ) : null}

      <View style={[styles.list, stale && loading && { opacity: 0.5 }]} aria-busy={loading}>
        {listed.map((r) => (
          <OwnerReview key={r.booking_id} review={r} now={now} timeZone={shop.time_zone} onSaved={replied} />
        ))}
      </View>
      {hasMore && !error && !stale ? (
        <Button title={t('Show more')} variant="secondary" loading={loadingMore} onPress={loadMore} />
      ) : null}
    </Screen>
  );
}

/**
 * One review, with Reply (or Edit reply) opening a box for the answer right
 * under it, and Report a short form for the team. A reported one says where
 * the report is; one the team removed takes no reply.
 */
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
  const big = useBigText();
  const [editing, setEditing] = useState(false);
  const [reporting, setReporting] = useState(false);
  const [text, setText] = useState(review.reply ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  // Said with the report's status when sending found it already reported, e.g. from another phone.
  const [notice, setNotice] = useState<string | null>(null);
  const name = review.first_name;
  const report = review.report ?? null;
  const removed = review.removed === true || report?.outcome === 'removed';

  // Back from the report form, focus goes to what it changed (or Reply), never to the top of the list.
  const status = useRef<View>(null);
  const replyButton = useRef<View>(null);
  const focusNext = useRef<'status' | 'reply' | null>(null);
  useEffect(() => {
    const to = focusNext.current;
    if (!to) return;
    focusNext.current = null;
    // Once the form has gone and what replaces it is laid out.
    setTimeout(() => focusOn(to === 'status' && status.current ? status.current : replyButton.current), 100);
  });

  function reported(next: ReviewReport, already: string | null) {
    onSaved({ ...review, report: next, removed: next.outcome === 'removed' });
    setNotice(already);
    setReporting(false);
    focusNext.current = 'status';
  }

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

  const statusText = report ? reportStatus(report, APP_NAME) : null;
  return (
    <Card>
      <ReviewItem review={review} now={now} timeZone={timeZone} replyTitle={t('Your reply')}>
        {report && statusText && !reporting ? (
          <View
            ref={status}
            accessible
            tabIndex={-1}
            accessibilityLabel={[notice, statusText.badge, statusText.line].filter(Boolean).join('. ')}
            style={[styles.status, { borderColor: theme.border }]}>
            {notice ? <T variant="small">{notice}</T> : null}
            {/* Side by side, or the line under the badge once text is big, so it isn't a narrow column. */}
            <Row style={big ? styles.statusStacked : styles.statusRow}>
              <Badge label={statusText.badge} tone={STATE_TONE[reportState(report)]} />
              <T variant="small" style={big ? undefined : styles.statusLine}>
                {statusText.line}
              </T>
            </Row>
            {report.note ? <T variant="small">{t('Your note: “{note}”', { note: report.note })}</T> : null}
          </View>
        ) : null}
        {reporting ? (
          <ReportForm
            review={review}
            onSent={reported}
            onCancel={() => {
              setReporting(false);
              focusNext.current = 'reply';
            }}
          />
        ) : editing ? (
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
              <T variant="small" role="status" accessibilityLiveRegion="polite" style={[styles.done, { color: theme.success }]}>
                {done}
              </T>
            ) : null}
            {report ? null : (
              <Button
                title={t('Report')}
                variant="ghost"
                icon="flag-outline"
                accessibilityLabel={t('Report {name}’s review', { name })}
                onPress={() => {
                  setDone(null);
                  setReporting(true);
                }}
              />
            )}
            {removed ? null : (
              <Button
                ref={replyButton}
                title={review.reply ? t('Edit reply') : t('Reply')}
                variant={review.reply ? 'ghost' : 'secondary'}
                accessibilityLabel={
                  review.reply ? t('Edit your reply to {name}', { name }) : t('Reply to {name}', { name })
                }
                onPress={() => {
                  setDone(null);
                  setNotice(null);
                  setText(review.reply ?? '');
                  setEditing(true);
                }}
              />
            )}
          </View>
        )}
      </ReviewItem>
    </Card>
  );
}

const STATE_TONE = { open: 'warning', kept: 'neutral', removed: 'danger' } as const;

/**
 * Report this review: why, and a note if they like, for the team. Opens with
 * focus on its heading. A review already reported (from another phone, say)
 * shows that report as it really is, kept or removed or still open.
 */
function ReportForm({
  review,
  onSent,
  onCancel,
}: {
  review: ShopReview;
  onSent: (report: ReviewReport, already: string | null) => void;
  onCancel: () => void;
}) {
  const heading = useRef<View>(null);
  const [reason, setReason] = useState<ReportReason | null>(null);
  const [note, setNote] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // After the button that opened it has gone, as it does on the web.
    const timer = setTimeout(() => focusOn(heading.current), 100);
    return () => clearTimeout(timer);
  }, []);

  async function send() {
    if (!reason) return;
    setSending(true);
    setError(null);
    const { data, error } = await supabase.rpc('report_review', {
      p_booking_id: review.booking_id,
      p_reason: reason,
      p_note: note,
    });
    if (error?.code === '23505') {
      // Reported already: what the team made of it, rather than guessing.
      const real = await supabase.from('review_reports').select(REPORT_COLUMNS).eq('booking_id', review.booking_id).maybeSingle();
      setSending(false);
      if (real.data) return onSent(real.data as ReviewReport, errorMessage(error));
      return setError(errorMessage(real.error ?? error));
    }
    setSending(false);
    if (error || !data) return setError(errorMessage(error));
    onSent(data as ReviewReport, null);
  }

  return (
    <View style={styles.editor}>
      <View ref={heading} accessible role="heading" aria-level={3} tabIndex={-1}>
        <T variant="label">{t('Report this review')}</T>
      </View>
      <T variant="small">
        {t('The {app} team reads every report. The review stays on your page until they decide.', { app: APP_NAME })}
      </T>
      {/* Said by the group itself to screen readers. */}
      <T variant="label" aria-hidden>
        {t('Why is it unfair?')}
      </T>
      <Row role="radiogroup" accessibilityLabel={t('Why is it unfair?')}>
        {REPORT_REASONS.map((r) => (
          <Chip key={r} label={reasonLabel(r)} selected={reason === r} onPress={() => setReason(r)} />
        ))}
      </Row>
      <Field
        label={t('Note (optional)')}
        hint={t('Anything that helps the team decide. Customers never see it.')}
        value={note}
        onChangeText={setNote}
        multiline
        maxLength={REPORT_NOTE_MAX_LENGTH}
      />
      <ErrorText message={error} />
      <Row style={{ flexWrap: 'nowrap' }}>
        <Button title={t('Cancel')} variant="secondary" onPress={onCancel} />
        <Button title={t('Send report')} onPress={send} loading={sending} disabled={!reason} style={{ flex: 1 }} />
      </Row>
    </View>
  );
}

/** Moves a screen reader, or the keyboard on the web, to `node`. */
function focusOn(node: View | null) {
  if (!node) return;
  if (Platform.OS === 'web') (node as unknown as HTMLElement).focus?.();
  else {
    const tag = findNodeHandle(node);
    if (tag) AccessibilityInfo.setAccessibilityFocus(tag);
  }
}

const styles = StyleSheet.create({
  summary: { gap: 2 },
  list: { gap: Spacing.sm },
  editor: { gap: Spacing.sm, marginTop: Spacing.xs },
  actions: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'flex-end', gap: Spacing.sm },
  // The reply's line takes the room left beside the buttons, or a line of its own.
  done: { flexGrow: 1, flexShrink: 1, flexBasis: 120 },
  status: { gap: Spacing.xs, borderTopWidth: StyleSheet.hairlineWidth, paddingTop: Spacing.sm, marginTop: Spacing.xs },
  statusRow: { flexWrap: 'nowrap', alignItems: 'flex-start' },
  statusStacked: { flexDirection: 'column', alignItems: 'flex-start', gap: Spacing.xs },
  statusLine: { flex: 1 },
});
