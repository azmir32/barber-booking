import { router, useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Linking, StyleSheet, View } from 'react-native';

import { BookingStatusBadge } from '@/components/booking-status';
import { Button, Card, Empty, ErrorText, Row, Screen, Section, T } from '@/components/ui';
import { APP_NAME, bookingLink } from '@/constants/brand';
import { MaxContentWidth, Radius, Spacing } from '@/constants/theme';
import { useNow } from '@/hooks/use-now';
import { useTheme } from '@/hooks/use-theme';
import { addToCalendar } from '@/lib/add-to-calendar';
import { useAuth } from '@/lib/auth';
import { bookingEvent } from '@/lib/calendar';
import { confirmAction } from '@/lib/confirm';
import { t } from '@/lib/lang';
import { directionsUrl } from '@/lib/maps';
import { whatsappUrl } from '@/lib/phone';
import { errorMessage, supabase } from '@/lib/supabase';
import { formatDay, formatPrice, formatTime } from '@/lib/time';
import type { Booking } from '@/lib/types';

/** One of the customer's bookings, from my_bookings(): its shop and barber come even when the shop is paused. */
type MyBooking = Booking & {
  shops: {
    name: string;
    slug: string;
    address: string | null;
    area: string;
    phone: string | null;
    time_zone: string;
    /** False while the shop is paused or its trial has ended: no online changes, but the booking stands. */
    is_live: boolean;
  } | null;
  barbers: { name: string } | null;
};

/** The bar after a cancel: it worked, and a tap tells the shop. */
type Notice = { message: string; whatsapp?: string };

/** How long the bar stays up: time to decide whether to message the shop. */
const NOTICE_MS = 10_000;

export default function MyBookings() {
  const { session, profile } = useAuth();
  const theme = useTheme();
  const now = useNow();
  const [bookings, setBookings] = useState<MyBooking[]>([]);
  // Set once the list has come back, so a load that failed never reads as "No bookings yet".
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const noticeTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(noticeTimer.current), []);

  const load = useCallback(async () => {
    if (!session) return setLoading(false);
    setLoading(true);
    const { data, error } = await supabase.rpc('my_bookings');
    setLoading(false);
    // A refresh that fails keeps the bookings already on screen.
    if (error) return setError(errorMessage(error));
    setError(null);
    setBookings((data ?? []) as MyBooking[]);
    setLoaded(true);
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
    if (error) return setError(errorMessage(error));
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

  return (
    <Screen onRefresh={load} overlay={overlay}>
      <T variant="title">{t('My bookings')}</T>
      {loaded ? <ErrorText message={error} /> : null}
      {!loaded ? (
        error ? (
          <Empty title={t('Couldn’t load your bookings')} body={t('Check your connection and try again.')}>
            <Button title={t('Try again')} variant="secondary" loading={loading} onPress={load} />
          </Empty>
        ) : (
          <T variant="muted">{t('Loading your bookings…')}</T>
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
            // So the barber knows which booking the chat is about without asking.
            const hello =
              shop && profile
                ? t('Hi {shop}, this is {name}. I booked {service} on {day} at {time}.', {
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

      {past.length ? (
        <Section title={t('Earlier')}>
          {past.map((b) => (
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
            </Card>
          ))}
        </Section>
      ) : null}
      {/* Room for the bar, so it never covers the last card. */}
      {notice ? <View style={{ height: 72 }} /> : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  // Two even columns, so the card stays short and the buttons line up.
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.sm },
  action: { flexGrow: 1, flexBasis: '40%', paddingHorizontal: Spacing.sm },
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
