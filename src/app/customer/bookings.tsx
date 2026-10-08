import { router, useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { Linking, View } from 'react-native';

import { BookingStatusBadge } from '@/components/booking-status';
import { Button, Card, Empty, ErrorText, Row, Screen, Section, T } from '@/components/ui';
import { Spacing } from '@/constants/theme';
import { useNow } from '@/hooks/use-now';
import { useAuth } from '@/lib/auth';
import { confirmAction } from '@/lib/confirm';
import { t } from '@/lib/lang';
import { whatsappUrl } from '@/lib/phone';
import { errorMessage, supabase } from '@/lib/supabase';
import { formatDay, formatPrice, formatTime } from '@/lib/time';
import type { Booking } from '@/lib/types';

type MyBooking = Booking & {
  shops: {
    name: string;
    slug: string;
    address: string | null;
    area: string;
    phone: string | null;
    time_zone: string;
  } | null;
  barbers: { name: string } | null;
};

export default function MyBookings() {
  const { session, profile } = useAuth();
  const now = useNow();
  const [bookings, setBookings] = useState<MyBooking[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!session) return setLoading(false);
    setLoading(true);
    const { data, error } = await supabase
      .from('bookings')
      .select('*, shops(name, slug, address, area, phone, time_zone), barbers(name)')
      .eq('customer_id', session.user.id)
      .order('starts_at', { ascending: false })
      .limit(100);
    setLoading(false);
    if (error) return setError(errorMessage(error));
    setError(null);
    setBookings((data ?? []) as MyBooking[]);
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
  const past = bookings.filter((b) => !upcoming.includes(b));
  // The latest booking at each shop the customer isn't already booked at, so a regular cut is one tap.
  // Only real visits count, not a cancelled booking that is still to come.
  const visits = past.filter((b) => b.status !== 'cancelled' && new Date(b.starts_at).getTime() <= now);
  const lastVisits = visits
    .filter(
      (b, i) =>
        b.shops && visits.findIndex((p) => p.shop_id === b.shop_id) === i && !upcoming.some((u) => u.shop_id === b.shop_id),
    )
    .slice(0, 3);

  const withBarber = (b: MyBooking) =>
    t('{service} with {barber}', { service: b.service_name, barber: b.barbers?.name ?? t('your barber') });

  function bookAgain(b: MyBooking) {
    router.push({
      pathname: '/shop/[slug]',
      params: { slug: b.shops!.slug, barber: b.barber_id, ...(b.service_id ? { service: b.service_id } : {}) },
    });
  }

  async function cancel(b: MyBooking) {
    const tz = b.shops?.time_zone;
    const ok = await confirmAction(
      t('Cancel booking?'),
      t('{service} on {day} at {time}', {
        service: b.service_name,
        day: formatDay(b.starts_at, tz),
        time: formatTime(b.starts_at, tz),
      }),
      t('Cancel booking'),
    );
    if (!ok) return;
    const { error } = await supabase.rpc('set_booking_status', { p_booking_id: b.id, p_status: 'cancelled' });
    if (error) return setError(errorMessage(error));
    load();
  }

  return (
    <Screen onRefresh={load}>
      <T variant="title">{t('My bookings')}</T>
      <ErrorText message={error} />
      {!loading && bookings.length === 0 ? (
        <Empty title={t('No bookings yet')} body={t('Find a barber and grab a slot.')}>
          <Button title={t('Find a barber')} onPress={() => router.push('/customer')} />
        </Empty>
      ) : null}

      {upcoming.length ? (
        <Section title={t('Upcoming')}>
          {upcoming.map((b) => {
            const shop = b.shops;
            const tz = shop?.time_zone;
            // So the barber knows which booking the chat is about without asking.
            const hello =
              shop && profile
                ? t('Hi {shop}, this is {name}. I booked {service} on {day} at {time}.', {
                    shop: shop.name,
                    name: profile.full_name,
                    service: b.service_name,
                    day: formatDay(b.starts_at, tz),
                    time: formatTime(b.starts_at, tz),
                  })
                : undefined;
            return (
              <Card key={b.id}>
                <T variant="heading">
                  {formatDay(b.starts_at, tz)}, {formatTime(b.starts_at, tz)}
                </T>
                <T>
                  {withBarber(b)} · {formatPrice(b.price)}
                </T>
                {b.customer_note ? <T variant="muted">“{b.customer_note}”</T> : null}
                <T variant="muted">
                  {shop?.name}
                  {shop?.address ? ` · ${shop.address}` : ''}
                </T>
                <Row>
                  {shop?.phone ? (
                    <Button
                      title={t('WhatsApp shop')}
                      variant="secondary"
                      onPress={() => Linking.openURL(whatsappUrl(shop.phone!, hello))}
                    />
                  ) : null}
                  {shop ? (
                    <Button title={t('Directions')} variant="secondary" onPress={() => Linking.openURL(directionsUrl(shop))} />
                  ) : null}
                  <Button title={t('Cancel')} variant="ghost" onPress={() => cancel(b)} />
                </Row>
              </Card>
            );
          })}
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
                    {withBarber(b)} · {formatDay(b.starts_at, b.shops?.time_zone)}
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
                <T variant="label">{formatDay(b.starts_at, b.shops?.time_zone)}</T>
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
    </Screen>
  );
}

/** A Google Maps search for the shop. Needs no API key and opens the Maps app when it is installed. */
function directionsUrl(shop: { name: string; address: string | null; area: string }) {
  const query = `${shop.name}, ${shop.address || shop.area}`;
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`;
}
