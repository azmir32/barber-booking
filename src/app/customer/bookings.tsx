import { router, useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Linking, StyleSheet, View } from 'react-native';

import { BookingStatusBadge } from '@/components/booking-status';
import { RateForm, ShopReply, Stars } from '@/components/reviews';
import { Bone, Button, Card, Empty, ErrorText, Row, Screen, ScreenTitle, Section, Skeleton, StaleNote, T } from '@/components/ui';
import { APP_NAME, bookingLink } from '@/constants/brand';
import { MaxContentWidth, Radius, Spacing } from '@/constants/theme';
import { useNow } from '@/hooks/use-now';
import { useTheme } from '@/hooks/use-theme';
import { addToCalendar } from '@/lib/add-to-calendar';
import { appCache } from '@/lib/app-cache';
import { useAuth } from '@/lib/auth';
import { cacheKey } from '@/lib/cache';
import { bookingEvent } from '@/lib/calendar';
import { confirmAction } from '@/lib/confirm';
import { t } from '@/lib/lang';
import { directionsUrl } from '@/lib/maps';
import { whatsappUrl } from '@/lib/phone';
import { canRate, rateUntil, starsLabel, type MyReview } from '@/lib/reviews';
import { errorMessage, supabase } from '@/lib/supabase';
import { formatDay, formatPrice, formatTime, noBreak } from '@/lib/time';
import type { Booking } from '@/lib/types';

/** One of the customer's bookings, from my_bookings(): its shop and barber come even when the shop is paused. */
type MyBooking = Booking & {
  shops: {
    name: string;
    slug: string;
    address: string | null;
    area: string;
    /** Where the shop is, when its owner has set it: Directions go straight there. */
    latitude: number | null;
    longitude: number | null;
    phone: string | null;
    time_zone: string;
    /** False while the shop is paused or its trial has ended: no online changes, but the booking stands. */
    is_live: boolean;
  } | null;
  barbers: { name: string } | null;
  /** The customer's rating of this cut and the shop's reply; null until they rate it. */
  review: MyReview | null;
};

/** The bar after a cancel: it worked, and a tap tells the shop. */
type Notice = { message: string; whatsapp?: string };

/** How long the bar stays up: time to decide whether to message the shop. */
const NOTICE_MS = 10_000;

export default function MyBookingsScreen() {
  const uid = useAuth().session?.user.id;
  // One per account, so nobody's bookings ever show while someone else's load.
  return <MyBookings key={uid ?? 'guest'} />;
}

function MyBookings() {
  const { session, profile } = useAuth();
  const theme = useTheme();
  const now = useNow();
  // Last visit's list shows at once, while the server is asked again.
  const [kept] = useState(() => (session ? appCache.peek<MyBooking[]>(cacheKey(session.user.id, 'my-bookings')) : null));
  const [bookings, setBookings] = useState<MyBooking[]>(kept?.data ?? []);
  // Set once there is a list, so a load that failed never reads as "No bookings yet".
  const [loaded, setLoaded] = useState(Boolean(kept));
  // When the server gave the list on screen, and whether that was before this visit.
  const [savedAt, setSavedAt] = useState(kept?.at ?? 0);
  const [fromCache, setFromCache] = useState(Boolean(kept));
  const [loading, setLoading] = useState(true);
  // Why the last refresh failed; the list on screen stays.
  const [refreshError, setRefreshError] = useState<string | null>(null);
  // Why an action failed.
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const noticeTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(noticeTimer.current), []);
  // Rated for the first time since the list loaded: kept where they were rated, with the thanks,
  // instead of jumping down to Earlier.
  const [justRated, setJustRated] = useState<Set<string>>(new Set());
  const [savedId, setSavedId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!session) return setLoading(false);
    setLoading(true);
    const { data, error } = await supabase.rpc('my_bookings');
    setLoading(false);
    // A refresh that fails keeps the bookings already on screen.
    if (error) return setRefreshError(errorMessage(error));
    const list = (data ?? []) as MyBooking[];
    setRefreshError(null);
    setError(null);
    setBookings(list);
    setJustRated(new Set());
    setSavedId(null);
    setEditingId(null);
    setLoaded(true);
    setSavedAt(Date.now());
    setFromCache(false);
    appCache.write(cacheKey(session.user.id, 'my-bookings'), list);
  }, [session]);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  if (!session) {
    return (
      <Screen>
        <Empty title={t('Your bookings live here')} body={t('Sign in to see and manage your appointments.')}>
          <Row style={{ justifyContent: 'center' }}>
            <Button
              title={t('Sign in')}
              onPress={() => router.push({ pathname: '/sign-in', params: { next: '/customer/bookings' } })}
            />
            <Button
              title={t('Create an account')}
              variant="secondary"
              onPress={() => router.push({ pathname: '/sign-up', params: { next: '/customer/bookings' } })}
            />
          </Row>
        </Empty>
      </Screen>
    );
  }

  const upcoming = bookings
    .filter((b) => b.status === 'confirmed' && new Date(b.ends_at).getTime() > now)
    .reverse();
  // Cancelled before their time came: listed on their own, not as the newest of Earlier.
  const cancelledAhead = bookings
    .filter((b) => b.status === 'cancelled' && new Date(b.starts_at).getTime() > now)
    .reverse();
  const past = bookings.filter((b) => !upcoming.includes(b) && !cancelledAhead.includes(b));
  // Done in the last 14 days and not rated yet: asked about on their own, above the rest.
  const toRate = past.filter((b) => canRate(b, now) && (!b.review || justRated.has(b.id)));
  const earlier = past.filter((b) => !toRate.includes(b));
  // The latest booking at each shop the customer isn't already booked at, so a regular cut is one tap.
  // Only real visits count, and only shops still taking online bookings.
  const visits = past.filter((b) => b.status !== 'cancelled' && new Date(b.starts_at).getTime() <= now);
  const lastVisits = visits
    .filter(
      (b, i) =>
        b.shops?.is_live &&
        visits.findIndex((p) => p.shop_id === b.shop_id) === i &&
        !upcoming.some((u) => u.shop_id === b.shop_id),
    )
    .slice(0, 3);

  const withBarber = (b: MyBooking) =>
    t('{service} with {barber}', { service: b.service_name, barber: b.barbers?.name ?? t('your barber') });
  const when = (b: MyBooking) => ({
    day: formatDay(b.starts_at, b.shops?.time_zone),
    time: formatTime(b.starts_at, b.shops?.time_zone),
  });

  function bookAgain(b: MyBooking) {
    router.push({
      pathname: '/shop/[slug]',
      params: { slug: b.shops!.slug, barber: b.barber_id, ...(b.service_id ? { service: b.service_id } : {}) },
    });
  }

  // Opens the shop page set to move this booking, on its service and barber.
  function changeTime(b: MyBooking) {
    router.push({
      pathname: '/shop/[slug]',
      params: { slug: b.shops!.slug, name: b.shops!.name, move: b.id, service: b.service_id!, barber: b.barber_id },
    });
  }

  function rated(b: MyBooking, review: MyReview) {
    setBookings((list) => list.map((x) => (x.id === b.id ? { ...x, review } : x)));
    if (!b.review) setJustRated((ids) => new Set(ids).add(b.id));
    setSavedId(b.id);
    setEditingId(null);
  }

  const rating = (b: MyBooking) => (
    <YourRating
      booking={b}
      now={now}
      saved={savedId === b.id}
      editing={editingId === b.id}
      onEdit={() => {
        setSavedId(null);
        setEditingId(b.id);
      }}
      onCancel={() => setEditingId(null)}
      onSaved={(review) => rated(b, review)}
    />
  );

  function showNotice(next: Notice | null) {
    clearTimeout(noticeTimer.current);
    setNotice(next);
    if (next) noticeTimer.current = setTimeout(() => setNotice(null), NOTICE_MS);
  }

  async function cancel(b: MyBooking) {
    const what = t('{service} on {day} at {time}', { service: b.service_name, ...when(b) });
    // The app can't take it out of their calendar, and its reminder would still go off.
    const ok = await confirmAction(
      t('Cancel booking?'),
      `${what}\n\n${t('Added it to your calendar? Delete it there too.')}`,
      t('Cancel booking'),
    );
    if (!ok) return;
    const { error } = await supabase.rpc('set_booking_status', { p_booking_id: b.id, p_status: 'cancelled' });
    if (error) {
      // The list may be behind the server (moved or cancelled elsewhere): show it as it is now, then why.
      await load();
      return setError(errorMessage(error));
    }
    // A late cancel only reaches the barber if they look at the app, so offer to tell them.
    const shop = b.shops;
    const message =
      shop && profile?.full_name
        ? t('Hi {shop}, this is {name}. I’ve cancelled my {service} on {day} at {time}.', {
            shop: shop.name,
            name: profile.full_name,
            service: b.service_name,
            ...when(b),
          })
        : undefined;
    showNotice({
      message: t('Booking cancelled.'),
      whatsapp: shop?.phone ? whatsappUrl(shop.phone, message) : undefined,
    });
    load();
  }

  const overlay = notice ? (
    <View style={styles.overlay}>
      <View style={styles.overlayInner}>
        <View
          role="status"
          accessibilityLiveRegion="polite"
          style={[styles.bar, { backgroundColor: theme.card, borderColor: theme.border }]}>
          <T style={{ flex: 1 }}>{notice.message}</T>
          {notice.whatsapp ? (
            <Button
              title={t('WhatsApp the shop')}
              variant="secondary"
              onPress={() => {
                const url = notice.whatsapp!;
                showNotice(null);
                Linking.openURL(url);
              }}
            />
          ) : null}
        </View>
      </View>
    </View>
  ) : null;

  // Cancel and Add to calendar wait for the server's list rather than act on last visit's,
  // where the time may have moved: dimmed until it comes (the title's spinner says it is coming).
  // WhatsApp the shop still opens, as it may be the way through on a weak line, but without the time.
  const hold = fromCache ? { disabled: true } : {};

  return (
    <Screen onRefresh={load} overlay={overlay}>
      <ScreenTitle title={t('My bookings')} refreshing={fromCache && loading} />
      {loaded && refreshError ? <StaleNote savedAt={savedAt} onRetry={load} retrying={loading} /> : null}
      {loaded ? <ErrorText message={error} /> : null}
      {!loaded ? (
        refreshError ? (
          <Empty title={t('Couldn’t load your bookings')} body={t('Check your connection and try again.')}>
            <Button title={t('Try again')} variant="secondary" loading={loading} onPress={load} />
          </Empty>
        ) : (
          <BookingsSkeleton />
        )
      ) : bookings.length === 0 ? (
        <Empty title={t('No bookings yet')} body={t('Find a barber and grab a slot.')}>
          <Button title={t('Find a barber')} onPress={() => router.push('/customer')} />
        </Empty>
      ) : null}

      {upcoming.length ? (
        <Section title={t('Upcoming')}>
          {upcoming.map((b) => {
            const shop = b.shops;
            const { day, time } = when(b);
            // So the barber knows which booking the chat is about without asking; on last
            // visit's list only hello, as the time may have moved since.
            const hello =
              shop && profile
                ? fromCache
                  ? t('Hi {shop}, this is {name}.', { shop: shop.name, name: profile.full_name })
                  : t('Hi {shop}, this is {name}. I booked {service} on {day} at {time}.', {
                      shop: shop.name,
                      name: profile.full_name,
                      service: b.service_name,
                      day,
                      time,
                    })
                : undefined;
            return (
              <Card key={b.id}>
                <T variant="heading">
                  {day}, {time}
                </T>
                <T>
                  {withBarber(b)} · {formatPrice(b.price)}
                </T>
                {b.customer_note ? <T variant="muted">“{b.customer_note}”</T> : null}
                <T variant="muted">
                  {shop?.name}
                  {shop?.address ? ` · ${shop.address}` : ''}
                </T>
                {shop && !shop.is_live ? (
                  <T variant="small">
                    {shop.phone
                      ? t('Online booking is paused at this shop. Your booking still stands; WhatsApp them if unsure.')
                      : t('Online booking is paused at this shop. Your booking still stands.')}
                  </T>
                ) : null}
                {/* What is needed on the day comes first. */}
                <View style={styles.actions}>
                  {shop ? (
                    <Button
                      title={t('Directions')}
                      variant="secondary"
                      style={styles.action}
                      onPress={() => Linking.openURL(directionsUrl(shop))}
                    />
                  ) : null}
                  {shop?.phone ? (
                    <Button
                      title={t('WhatsApp the shop')}
                      variant="secondary"
                      style={styles.action}
                      onPress={() => Linking.openURL(whatsappUrl(shop.phone!, hello))}
                    />
                  ) : null}
                  {shop ? (
                    <Button
                      title={t('Add to calendar')}
                      variant="secondary"
                      style={styles.action}
                      {...hold}
                      onPress={() =>
                        addToCalendar(
                          bookingEvent({
                            booking: b,
                            shop,
                            barber: b.barbers?.name,
                            link: bookingLink(shop.slug),
                            app: APP_NAME,
                          }),
                        )
                      }
                    />
                  ) : null}
                  {/* Needs the service to find free times, can't move once the time has started,
                      and a paused shop takes no changes online. */}
                  {shop?.is_live && b.service_id && new Date(b.starts_at).getTime() > now ? (
                    <Button
                      title={t('Change time')}
                      variant="secondary"
                      style={styles.action}
                      onPress={() => changeTime(b)}
                    />
                  ) : null}
                </View>
                <Button
                  title={t('Cancel booking')}
                  variant="ghost"
                  tone="danger"
                  accessibilityLabel={t('Cancel booking on {day}', { day })}
                  {...hold}
                  onPress={() => cancel(b)}
                />
              </Card>
            );
          })}
        </Section>
      ) : null}

      {cancelledAhead.length ? (
        <Section title={t('Cancelled')}>
          {cancelledAhead.map((b) => (
            <Card key={b.id}>
              <T variant="label">
                {when(b).day}, {when(b).time}
              </T>
              <Row style={{ justifyContent: 'space-between', flexWrap: 'nowrap' }}>
                <T style={{ flexShrink: 1 }}>{withBarber(b)}</T>
                <T>{formatPrice(b.price)}</T>
              </Row>
              <T variant="muted">{b.shops?.name}</T>
            </Card>
          ))}
        </Section>
      ) : null}

      {toRate.length ? (
        <Section title={t('Rate your cut')}>
          {toRate.map((b) => (
            <Card key={b.id}>
              <T variant="heading">{t('How was your cut?')}</T>
              <View>
                <T variant="label">{b.shops?.name}</T>
                <T variant="muted">
                  {withBarber(b)} · {when(b).day}
                </T>
              </View>
              {rating(b)}
            </Card>
          ))}
        </Section>
      ) : null}

      {lastVisits.length ? (
        <Section title={t('Book again')}>
          {lastVisits.map((b) => (
            <Card key={b.shop_id}>
              <Row style={{ flexWrap: 'nowrap' }}>
                <View style={{ flex: 1, gap: Spacing.xs }}>
                  <T variant="heading">{b.shops?.name}</T>
                  <T variant="muted">
                    {withBarber(b)} · {when(b).day}
                  </T>
                </View>
                <Button title={t('Book again')} variant="secondary" onPress={() => bookAgain(b)} />
              </Row>
            </Card>
          ))}
        </Section>
      ) : null}

      {earlier.length ? (
        <Section title={t('Earlier')}>
          {earlier.map((b) => (
            <Card key={b.id}>
              <Row style={{ justifyContent: 'space-between' }}>
                <T variant="label">{when(b).day}</T>
                <BookingStatusBadge booking={b} />
              </Row>
              <Row style={{ justifyContent: 'space-between', flexWrap: 'nowrap' }}>
                <T style={{ flexShrink: 1 }}>{withBarber(b)}</T>
                <T>{formatPrice(b.price)}</T>
              </Row>
              <T variant="muted">{b.shops?.name}</T>
              {b.review ? (
                <>
                  <View style={[styles.rule, { backgroundColor: theme.border }]} />
                  {rating(b)}
                </>
              ) : null}
            </Card>
          ))}
        </Section>
      ) : null}
      {/* Room for the bar, so it never covers the last card. */}
      {notice ? <View style={{ height: 72 }} /> : null}
    </Screen>
  );
}

/** The shape of two upcoming bookings, while the first list loads. */
function BookingsSkeleton() {
  return (
    <Skeleton label={t('Loading your bookings')}>
      <Bone width="35%" height={20} />
      {[0, 1].map((i) => (
        <Card key={i}>
          <Bone width="55%" height={20} />
          <Bone width="80%" />
          <Bone width="65%" />
          <View style={styles.actions}>
            {[0, 1, 2, 3].map((j) => (
              <Bone key={j} height={48} style={styles.actionBone} />
            ))}
          </View>
        </Card>
      ))}
    </Skeleton>
  );
}

/**
 * A cut's rating: the stars to give while there are none, or the stars given
 * with the comment, the shop's reply, and Edit while it can still change.
 */
function YourRating({
  booking: b,
  now,
  saved,
  editing,
  onEdit,
  onCancel,
  onSaved,
}: {
  booking: MyBooking;
  now: number;
  /** Just sent: says so. */
  saved: boolean;
  editing: boolean;
  onEdit: () => void;
  onCancel: () => void;
  onSaved: (review: MyReview) => void;
}) {
  const theme = useTheme();
  const review = b.review;
  const open = canRate(b, now);
  if (open && (editing || !review)) {
    return (
      <RateForm bookingId={b.id} initial={review ?? undefined} onSaved={onSaved} onCancel={review ? onCancel : undefined} />
    );
  }
  if (!review) return null;
  const tz = b.shops?.time_zone;
  // The window shuts at the cut's own time of day, so the time is said too.
  const until = rateUntil(b.starts_at);
  return (
    <View style={styles.rating}>
      {saved ? (
        <View role="status" accessibilityLiveRegion="polite">
          <T variant="label" style={{ color: theme.success }}>
            {t('Thanks! Your rating is saved.')}
          </T>
        </View>
      ) : null}
      <Row>
        <T variant="small">{t('Your rating')}</T>
        <Stars rating={review.rating} label={t('Your rating: {stars}', { stars: starsLabel(review.rating) })} />
      </Row>
      {review.comment ? <T variant="muted">“{review.comment}”</T> : null}
      {review.reply ? <ShopReply text={review.reply} /> : null}
      {open ? (
        <Row style={{ flexWrap: 'nowrap' }}>
          <T variant="small" style={{ flex: 1 }}>
            {t('You can change it until {day} at {time}.', {
              day: noBreak(formatDay(until, tz)),
              time: noBreak(formatTime(until, tz)),
            })}
          </T>
          <Button
            title={t('Edit')}
            variant="ghost"
            accessibilityLabel={t('Change your rating for {day}', { day: formatDay(b.starts_at, tz) })}
            onPress={onEdit}
          />
        </Row>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  rule: { height: StyleSheet.hairlineWidth, marginVertical: Spacing.xs },
  rating: { gap: Spacing.xs },
  // Two even columns, so the card stays short and the buttons line up.
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.sm },
  action: { flexGrow: 1, flexBasis: '40%', paddingHorizontal: Spacing.sm },
  actionBone: { flexGrow: 1, flexBasis: '40%', width: 'auto', borderRadius: Radius.md },
  overlay: { position: 'absolute', left: 0, right: 0, bottom: 0, pointerEvents: 'box-none' },
  overlayInner: {
    width: '100%',
    maxWidth: MaxContentWidth,
    alignSelf: 'center',
    padding: Spacing.lg,
    pointerEvents: 'box-none',
  },
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
    borderWidth: 1,
    borderRadius: Radius.md,
    paddingVertical: Spacing.xs,
    paddingLeft: Spacing.lg,
    paddingRight: Spacing.xs,
    boxShadow: '0 4px 12px rgba(0, 0, 0, 0.2)',
  },
});
