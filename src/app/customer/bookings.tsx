import { router, useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { Linking } from 'react-native';

import { BookingStatusBadge } from '@/components/booking-status';
import { Button, Card, Empty, ErrorText, Row, Screen, Section, T } from '@/components/ui';
import { useNow } from '@/hooks/use-now';
import { useAuth } from '@/lib/auth';
import { confirmAction } from '@/lib/confirm';
import { whatsappUrl } from '@/lib/phone';
import { errorMessage, supabase } from '@/lib/supabase';
import { formatDay, formatPrice, formatTime } from '@/lib/time';
import type { Booking } from '@/lib/types';

type MyBooking = Booking & {
  shops: { name: string; slug: string; address: string | null; phone: string | null; time_zone: string } | null;
  barbers: { name: string } | null;
};

export default function MyBookings() {
  const { session } = useAuth();
  const now = useNow();
  const [bookings, setBookings] = useState<MyBooking[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!session) return setLoading(false);
    setLoading(true);
    const { data, error } = await supabase
      .from('bookings')
      .select('*, shops(name, slug, address, phone, time_zone), barbers(name)')
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
        <Empty title="Your bookings live here" body="Sign in to see and manage your appointments.">
          <Button title="Sign in" onPress={() => router.push({ pathname: '/sign-in', params: { next: '/customer/bookings' } })} />
        </Empty>
      </Screen>
    );
  }

  const upcoming = bookings
    .filter((b) => b.status === 'confirmed' && new Date(b.ends_at).getTime() > now)
    .reverse();
  const past = bookings.filter((b) => !upcoming.includes(b));

  async function cancel(b: MyBooking) {
    const tz = b.shops?.time_zone;
    const ok = await confirmAction(
      'Cancel booking?',
      `${b.service_name} on ${formatDay(b.starts_at, tz)} at ${formatTime(b.starts_at, tz)}`,
      'Cancel booking',
    );
    if (!ok) return;
    const { error } = await supabase.rpc('set_booking_status', { p_booking_id: b.id, p_status: 'cancelled' });
    if (error) return setError(errorMessage(error));
    load();
  }

  return (
    <Screen onRefresh={load}>
      <T variant="title">My bookings</T>
      <ErrorText message={error} />
      {!loading && bookings.length === 0 ? (
        <Empty title="No bookings yet" body="Find a barber and grab a slot.">
          <Button title="Find a barber" onPress={() => router.push('/customer')} />
        </Empty>
      ) : null}

      {upcoming.length ? (
        <Section title="Upcoming">
          {upcoming.map((b) => (
            <Card key={b.id}>
              <T variant="heading">
                {formatDay(b.starts_at, b.shops?.time_zone)}, {formatTime(b.starts_at, b.shops?.time_zone)}
              </T>
              <T>
                {b.service_name} with {b.barbers?.name ?? 'your barber'} · {formatPrice(b.price)}
              </T>
              <T variant="muted">
                {b.shops?.name}
                {b.shops?.address ? ` · ${b.shops.address}` : ''}
              </T>
              <Row>
                {b.shops?.phone ? (
                  <Button
                    title="WhatsApp shop"
                    variant="secondary"
                    onPress={() => Linking.openURL(whatsappUrl(b.shops!.phone!))}
                  />
                ) : null}
                <Button title="Cancel" variant="ghost" onPress={() => cancel(b)} />
              </Row>
            </Card>
          ))}
        </Section>
      ) : null}

      {past.length ? (
        <Section title="Past">
          {past.map((b) => (
            <Card key={b.id}>
              <Row style={{ justifyContent: 'space-between' }}>
                <T variant="label">{formatDay(b.starts_at, b.shops?.time_zone)}</T>
                <BookingStatusBadge booking={b} />
              </Row>
              <T>
                {b.service_name} at {b.shops?.name}
              </T>
              {b.shops ? (
                <Button title="Book again" variant="secondary" onPress={() => router.push(`/shop/${b.shops!.slug}`)} />
              ) : null}
            </Card>
          ))}
        </Section>
      ) : null}
    </Screen>
  );
}
