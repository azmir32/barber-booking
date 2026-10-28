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
import { placeLine, QUEUE_POLL_MS, queuedFor, type MyQueue } from '@/lib/queue';
import { canRate, rateUntil, starsLabel, type MyReview } from '@/lib/reviews';
import { errorMessage, supabase } from '@/lib/supabase';
import { useBigText } from '@/lib/text-size-provider';
import { formatDay, formatPrice, formatTime, localDateString, noBreak } from '@/lib/time';
import type { Booking } from '@/lib/types';
import { openRequests, requestService, type MyWaiting } from '@/lib/waitlist';

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
  const big = useBigText();
  // Last visit's list shows at once, while the server is asked again.
  const [kept] = useState(() => (session ? appCache.peek<MyBooking[]>(cacheKey(session.user.id, 'my-bookings')) : null));
  const [bookings, setBookings] = useState<MyBooking[]>(kept?.data ?? []);
  // The days they asked a shop to tell them if a time frees up, kept and asked for alongside.
  const [waits, setWaits] = useState<MyWaiting[]>(
    () => (session ? appCache.peek<MyWaiting[]>(cacheKey(session.user.id, 'my-waitlist'))?.data : null) ?? [],
  );
  // Their place in a walk-in queue today, if any, kept and asked for alongside, then every 30 seconds.
  const [queue, setQueue] = useState<MyQueue[]>(
    () => (session ? appCache.peek<MyQueue[]>(cacheKey(session.user.id, 'my-queue'))?.data : null) ?? [],
  );
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
  const [noticeHeight, setNoticeHeight] = useState(0);
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
    // One request: the bookings, the days they're waiting on and their place in a walk-in queue come together.
    const { data, error } = await supabase.rpc('my_bookings');
    setLoading(false);
    // A refresh that fails keeps the bookings, requests and place already on screen.
    if (error) return setRefreshError(errorMessage(error));
    const mine = (data ?? {}) as { bookings?: MyBooking[]; waitlist?: MyWaiting[]; queue?: MyQueue[] };
    const queued = mine.queue ?? [];
    setQueue(queued);
    appCache.write(cacheKey(session.user.id, 'my-queue'), queued);
    const waiting = mine.waitlist ?? [];
    setWaits(waiting);
    appCache.write(cacheKey(session.user.id, 'my-waitlist'), waiting);
    const list = mine.bookings ?? [];
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

  /** Just their place in the queue: one small request. */
  const loadQueue = useCallback(async () => {
    if (!session) return;
    const { data, error } = await supabase.rpc('my_queue');
    if (error) return;
    setQueue((data ?? []) as MyQueue[]);
    appCache.write(cacheKey(session.user.id, 'my-queue'), data ?? []);
  }, [session]);
  // While they wait, their place is asked for every 30 seconds with the screen in front;
  // not for a place the shop took off, which only says so.
  const inQueue = queue.some((q) => q.state !== 'gone');
  useFocusEffect(
    useCallback(() => {
      if (!inQueue) return;
      const id = setInterval(loadQueue, QUEUE_POLL_MS);
      return () => clearInterval(id);
    }, [inQueue, loadQueue]),
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
  // Gone once the day has passed or they have booked that day at that shop, even on last visit's list.
  const waiting = openRequests(waits, bookings, now);
  // A place kept from a day gone by is over, even on last visit's list.
  const places = queue.filter(
    (q) => localDateString(new Date(q.created_at), q.shop.time_zone) === localDateString(new Date(now), q.shop.time_zone),
  );
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

  // The shop page on that day, with what they asked for, to see whether a time has freed up.
  function seeTimes(w: MyWaiting) {
    router.push({
      pathname: '/shop/[slug]',
      params: {
        slug: w.shop.slug,
        name: w.shop.name,
        service: w.service_id,
        day: w.day,
        ...(w.barber_id ? { barber: w.barber_id } : {}),
      },
    });
  }

  async function leaveQueue(q: MyQueue) {
    const ok = await confirmAction(t('Leave the queue?'), t('If you join again, you go to the end of it.'), t('Leave'));
    if (!ok) return;
    const { error } = await supabase.rpc('leave_queue', { p_id: q.id });
    if (error) return setError(errorMessage(error));
    setError(null);
    loadQueue();
  }

  async function leave(w: MyWaiting) {
    const ok = await confirmAction(
      t('Leave the waiting list?'),
      t('If you join again, you go to the end of it.'),
      t('Leave'),
    );
    if (!ok) return;
    const { error } = await supabase.rpc('leave_waitlist', { p_id: w.id });
    if (error) return setError(errorMessage(error));
    setError(null);
    const list = waits.filter((x) => x.id !== w.id);
    setWaits(list);
    appCache.write(cacheKey(session!.user.id, 'my-waitlist'), list);
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
          onLayout={(e) => setNoticeHeight(e.nativeEvent.layout.height)}
          style={[styles.bar, { backgroundColor: theme.card, borderColor: theme.border }]}>
          <T style={[styles.barText, big && styles.wholeLine]}>{notice.message}</T>
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
      ) : bookings.length === 0 && waiting.length === 0 && places.length === 0 ? (
        <Empty title={t('No bookings yet')} body={t('Find a barber and grab a slot.')}>
          <Button title={t('Find a barber')} onPress={() => router.push('/customer')} />
        </Empty>
      ) : null}

      {places.length ? (
        <Section title={t('Walk-in queue')}>
          {places.map((q) => {
            const called = q.state === 'called';
            const takenOff = q.state === 'gone';
            const seeShop = (
              <Button
                title={t('See the shop')}
                variant="secondary"
                style={big ? styles.wholeAction : styles.action}
                accessibilityLabel={t('See {shop}', { shop: q.shop.name })}
                onPress={() => router.push({ pathname: '/shop/[slug]', params: { slug: q.shop.slug, name: q.shop.name } })}
              />
            );
            return (
              <Card
                key={q.id}
                style={called ? { borderColor: theme.success, borderWidth: 2 } : undefined}>
                {/* Read out when it changes, as the place moves up while the screen is open. */}
                <T
                  variant="heading"
                  role="status"
                  accessibilityLiveRegion="polite"
                  style={called ? { color: theme.success } : takenOff ? { color: theme.danger } : undefined}>
                  {called
                    ? t('It’s your turn. Head to the shop now.')
                    : takenOff
                      ? t('The shop took you off the queue. Message them if you’re on your way.')
                      : placeLine(q)}
                </T>
                {q.service_name ? <T>{queuedFor(q)}</T> : null}
                <T variant="muted">
                  {q.shop.name}
                  {q.shop.address ? ` · ${q.shop.address}` : ''}
                </T>
                <View style={styles.actions}>
                  {called ? (
                    <Button
                      title={t('Directions')}
                      variant="secondary"
                      style={big ? styles.wholeAction : styles.action}
                      accessibilityLabel={t('Directions to {shop}', { shop: q.shop.name })}
                      onPress={() => Linking.openURL(directionsUrl(q.shop))}
                    />
                  ) : null}
                  {takenOff && q.shop.phone ? (
                    <Button
                      title={t('WhatsApp the shop')}
                      icon="logo-whatsapp"
                      iconColor={theme.success}
                      variant="secondary"
                      style={big ? styles.wholeAction : styles.action}
                      onPress={() =>
                        Linking.openURL(
                          whatsappUrl(
                            q.shop.phone!,
                            profile?.full_name
                              ? t('Hi {shop}, this is {name}. I was in your walk-in queue today.', {
                                  shop: q.shop.name,
                                  name: profile.full_name,
                                })
                              : undefined,
                          ),
                        )
                      }
                    />
                  ) : null}
                  {seeShop}
                  {/* Waits for the server's answer: the place on last visit's list may be over. */}
                  {takenOff ? null : (
                    <Button
                      title={t('Leave')}
                      variant="secondary"
                      tone="danger"
                      style={big ? styles.wholeAction : styles.action}
                      accessibilityLabel={t('Leave the queue at {shop}', { shop: q.shop.name })}
                      onPress={() => leaveQueue(q)}
                      {...hold}
                    />
                  )}
                </View>
              </Card>
            );
          })}
        </Section>
      ) : null}

      {waiting.length ? (
        <Section title={t('Waiting list')}>
          {waiting.map((w) => {
            const day = formatDay(`${w.day}T00:00:00Z`, 'UTC');
            return (
              <Card key={w.id}>
                <T variant="heading">{t('Waiting for a time on {day}', { day: noBreak(day) })}</T>
                <T>{requestService(w)}</T>
                <T variant="muted">{w.shop.name}</T>
                <T variant="small">{t('If a time frees up, the shop may WhatsApp you. They decide who gets it.')}</T>
                <View style={styles.actions}>
                  <Button
                    title={t('See free times')}
                    variant="secondary"
                    style={big ? styles.wholeAction : styles.action}
                    accessibilityLabel={t('See free times on {day} at {shop}', { day, shop: w.shop.name })}
                    onPress={() => seeTimes(w)}
                  />
                  <Button
                    title={t('Leave')}
                    variant="secondary"
                    tone="danger"
                    style={big ? styles.wholeAction : styles.action}
                    accessibilityLabel={t('Leave the waiting list for {day}', { day })}
                    onPress={() => leave(w)}
                  />
                </View>
              </Card>
            );
          })}
        </Section>
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
              <Row style={big ? undefined : styles.noWrap}>
                <View style={[styles.lastVisit, big && styles.wholeLine]}>
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
      {/* Room for the bar, so it never covers the last card; with big text it is taller. */}
      {notice ? <View style={{ height: Math.max(72, noticeHeight) }} /> : null}
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
  noWrap: { flexWrap: 'nowrap' },
  lastVisit: { flex: 1, gap: Spacing.xs },
  // With big text (useBigText) Book again goes under the shop's name rather than squeezing it,
  // and WhatsApp the shop under Booking cancelled.
  wholeLine: { flexBasis: '100%' },
  rule: { height: StyleSheet.hairlineWidth, marginVertical: Spacing.xs },
  rating: { gap: Spacing.xs },
  // Two even columns, so the card stays short and the buttons line up.
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.sm },
  action: { flexGrow: 1, flexBasis: '40%', paddingHorizontal: Spacing.sm },
  // A waiting request's two buttons with big text (useBigText): one under the other, rather than a long Malay label on three lines.
  wholeAction: { flexGrow: 1, flexBasis: '100%', paddingHorizontal: Spacing.sm },
  actionBone: { flexGrow: 1, flexBasis: '40%', width: 'auto', borderRadius: Radius.md },
  overlay: { position: 'absolute', left: 0, right: 0, bottom: 0, pointerEvents: 'box-none' },
  overlayInner: {
    width: '100%',
    maxWidth: MaxContentWidth,
    alignSelf: 'center',
    padding: Spacing.lg,
    pointerEvents: 'box-none',
  },
  // With big text the button goes on a line of its own, at the right, rather than off the side of the screen.
  bar: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: Spacing.sm,
    borderWidth: 1,
    borderRadius: Radius.md,
    paddingVertical: Spacing.xs,
    paddingLeft: Spacing.lg,
    paddingRight: Spacing.xs,
    boxShadow: '0 4px 12px rgba(0, 0, 0, 0.2)',
  },
  // Beside the button, the message takes what room is left (on the web, never less than its longest word).
  barText: { flexGrow: 1, flexShrink: 1, flexBasis: 0 },
});
