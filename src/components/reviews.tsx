import Ionicons from '@expo/vector-icons/Ionicons';
import { useState, type ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { Button, ErrorText, Field, Row, T } from '@/components/ui';
import { Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { t } from '@/lib/lang';
import { ratingSummary, reviewAge, REVIEW_MAX_LENGTH, starsLabel, type MyReview, type ShopReview } from '@/lib/reviews';
import { errorMessage, supabase } from '@/lib/supabase';
import { formatDay } from '@/lib/time';

const ONE_TO_FIVE = [1, 2, 3, 4, 5];

/** Five stars filled up to `rating`. One picture to screen readers, read as "4 stars". */
export function Stars({ rating, size = 16, label }: { rating: number; size?: number; label?: string }) {
  const theme = useTheme();
  return (
    <View role="img" accessibilityLabel={label ?? starsLabel(rating)} style={styles.stars}>
      {ONE_TO_FIVE.map((n) => (
        <Ionicons
          key={n}
          name={n <= rating ? 'star' : 'star-outline'}
          size={size}
          color={n <= rating ? theme.warning : theme.inputBorder}
        />
      ))}
    </View>
  );
}

/**
 * "4.8 ★ (23)" once a shop has a few reviews, and nothing before. With
 * onPress it also says "See reviews" and takes the reader to them.
 */
export function RatingSummary({
  average,
  count,
  onPress,
}: {
  average: number | null;
  count: number;
  onPress?: () => void;
}) {
  const theme = useTheme();
  const summary = ratingSummary(average, count);
  if (!summary) return null;
  const [before, after] = summary.text.split('★');
  const text = (
    <T variant="label">
      {before}
      <Text style={{ color: theme.warning }}>★</Text>
      {after}
      {onPress ? <Text style={{ color: theme.tint }}> · {t('See reviews')}</Text> : null}
    </T>
  );
  if (!onPress) {
    return (
      <View role="img" accessibilityLabel={summary.label}>
        {text}
      </View>
    );
  }
  return (
    <Pressable
      role="link"
      accessibilityLabel={`${summary.label}. ${t('See reviews')}`}
      onPress={onPress}
      // The line is 18pt tall; the slop makes it a 44pt target without spacing out the header.
      hitSlop={{ top: 13, bottom: 13 }}
      style={({ pressed }) => [styles.summaryLink, pressed && { opacity: 0.6 }]}>
      {text}
    </Pressable>
  );
}

/** Five stars to tap, as one radio group: each a 48pt target, read as "1 star" to "5 stars". */
export function StarPicker({ value, onChange }: { value: number; onChange: (stars: number) => void }) {
  const theme = useTheme();
  return (
    <Row role="radiogroup" accessibilityLabel={t('Your rating')} style={styles.picker}>
      {ONE_TO_FIVE.map((n) => (
        <Pressable
          key={n}
          role="radio"
          aria-checked={n === value}
          accessibilityState={{ checked: n === value }}
          accessibilityLabel={starsLabel(n)}
          onPress={() => onChange(n)}
          style={({ pressed }) => [styles.starButton, pressed && { opacity: 0.6 }]}>
          <Ionicons
            name={n <= value ? 'star' : 'star-outline'}
            size={34}
            color={n <= value ? theme.warning : theme.inputBorder}
          />
        </Pressable>
      ))}
    </Row>
  );
}

/**
 * The stars, then once one is picked an optional comment and Send. Also
 * changes a rating already given, starting from it.
 */
export function RateForm({
  bookingId,
  initial,
  onSaved,
  onCancel,
}: {
  bookingId: string;
  initial?: Pick<MyReview, 'rating' | 'comment'>;
  onSaved: (review: MyReview) => void;
  /** For a change to a rating already given: leaves it as it was. */
  onCancel?: () => void;
}) {
  const [stars, setStars] = useState(initial?.rating ?? 0);
  const [comment, setComment] = useState(initial?.comment ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function send() {
    setSaving(true);
    setError(null);
    const { data, error } = await supabase.rpc('rate_booking', {
      p_booking_id: bookingId,
      p_rating: stars,
      p_comment: comment,
    });
    setSaving(false);
    if (error) return setError(errorMessage(error));
    onSaved(data as MyReview);
  }

  return (
    <View style={styles.form}>
      <StarPicker
        value={stars}
        onChange={(n) => {
          setStars(n);
          setError(null);
        }}
      />
      {stars > 0 ? (
        <>
          <Field
            label={t('Comment (optional)')}
            hint={t('Shown on the shop’s page with your first name.')}
            value={comment}
            onChangeText={setComment}
            placeholder={t('What did you like? What could be better?')}
            multiline
            maxLength={REVIEW_MAX_LENGTH}
          />
          <ErrorText message={error} />
          <Row style={{ flexWrap: 'nowrap' }}>
            {onCancel ? <Button title={t('Cancel')} variant="secondary" onPress={onCancel} /> : null}
            <Button title={t('Send')} onPress={send} loading={saving} style={{ flex: 1 }} />
          </Row>
        </>
      ) : onCancel ? (
        <Button title={t('Cancel')} variant="ghost" onPress={onCancel} />
      ) : null}
    </View>
  );
}

/** The shop's answer under a review, set off by a line down its side. */
export function ShopReply({ text, title = t('Reply from the shop') }: { text: string; title?: string }) {
  const theme = useTheme();
  return (
    <View style={[styles.reply, { borderColor: theme.inputBorder }]}>
      <T variant="label">{title}</T>
      <T variant="muted">{text}</T>
    </View>
  );
}

/**
 * One review as a shop page shows it: a first name, the stars, how long ago,
 * the barber, what they wrote and the shop's reply. For the shop's owner it
 * also says which cut it was. `children` go underneath, e.g. Reply.
 */
export function ReviewItem({
  review,
  now,
  timeZone,
  replyTitle,
  children,
}: {
  review: ShopReview;
  now: number;
  timeZone: string;
  /** What the shop's reply is called: "Reply from the shop", or "Your reply" for its owner. */
  replyTitle?: string;
  children?: ReactNode;
}) {
  const when = reviewAge(review.created_at, now, timeZone);
  const barber = review.barbers?.name;
  const cut = review.bookings;
  return (
    <View style={styles.review}>
      <Row style={{ justifyContent: 'space-between', flexWrap: 'nowrap' }}>
        <T variant="label" style={{ flexShrink: 1 }}>
          {review.first_name}
        </T>
        <Stars rating={review.rating} />
      </Row>
      <T variant="small">{barber ? `${when} · ${t('with {barber}', { barber })}` : when}</T>
      {cut ? (
        <T variant="small">
          {t('{service} on {day}', { service: cut.service_name, day: formatDay(cut.starts_at, timeZone) })}
        </T>
      ) : null}
      {review.comment ? <T>{review.comment}</T> : null}
      {review.reply ? <ShopReply text={review.reply} title={replyTitle} /> : null}
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  stars: { flexDirection: 'row', gap: 2 },
  summaryLink: { alignSelf: 'flex-start' },
  picker: { gap: Spacing.xs },
  starButton: { width: 48, height: 48, alignItems: 'center', justifyContent: 'center' },
  form: { gap: Spacing.md },
  reply: { borderLeftWidth: 3, paddingLeft: Spacing.md, gap: 2, marginTop: Spacing.xs },
  review: { gap: Spacing.xs },
});
