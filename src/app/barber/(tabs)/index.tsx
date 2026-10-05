import { router, useFocusEffect } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import { Linking, ScrollView } from 'react-native';

import { BookingStatusBadge } from '@/components/booking-status';
import { Button, Card, Empty, ErrorText, Row, Chip, Screen, Section, T } from '@/components/ui';
import { Spacing } from '@/constants/theme';
import { useNow } from '@/hooks/use-now';
import { confirmAction } from '@/lib/confirm';
import { useMyShop } from '@/lib/my-shop';
import { whatsappUrl } from '@/lib/phone';
import { errorMessage, supabase } from '@/lib/supabase';
import { dayBounds, formatDay, formatPrice, formatTime, upcomingDays } from '@/lib/time';
import type { Booking, BookingStatus } from '@/lib/types';

type ShopBooking = Booking & {
  barbers: { name: string } | null;
  customer: { full_name: string; phone: string | null } | null;
};

type Setup = { services: number; barbers: number; hours: number };

export default function BarberBookings() {
  const { shop } = useMyShop();
  const now = useNow();
  const tz = shop!.time_zone;
  // Yesterday is included so last-minute no-shows can still be marked.
  const days = useMemo(() => upcomingDays(15, tz, new Date(), -1), [tz]);
  const [day, setDay] = useState(days[1].date);
  const [bookings, setBookings] = useState<ShopBooking[]>([]);
  const [setup, setSetup] = useState<Setup | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!shop) return;
    const { start, end } = dayBounds(day, tz);
    const [list, services, barbers, hours] = await Promise.all([
      supabase
        .from('bookings')
        .select('*, barbers(name), customer:profiles!bookings_customer_id_fkey(full_name, phone)')
        .eq('shop_id', shop.id)
        .gte('starts_at', start.toISOString())
        .lt('starts_at', end.toISOString())
        .order('starts_at'),
      supabase.from('services').select('id', { count: 'exact', head: true }).eq('shop_id', shop.id).eq('is_active', true),
      supabase.from('barbers').select('id', { count: 'exact', head: true }).eq('shop_id', shop.id).eq('is_active', true),
      supabase.from('working_hours').select('id, barbers!inner(shop_id)', { count: 'exact', head: true }).eq('barbers.shop_id', shop.id),
    ]);
    if (list.error) return setError(errorMessage(list.error));
    setError(null);
    setBookings((list.data ?? []) as ShopBooking[]);
    setSetup({ services: services.count ?? 0, barbers: barbers.count ?? 0, hours: hours.count ?? 0 });
  }, [shop, day, tz]);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  async function setStatus(b: ShopBooking, status: BookingStatus) {
    if (status === 'cancelled') {
      const ok = await confirmAction(
        'Cancel this booking?',
        `${b.customer?.full_name || 'The customer'} · ${b.service_name} at ${formatTime(b.starts_at, tz)}. Let them know on WhatsApp.`,
        'Cancel booking',
      );
      if (!ok) return;
    }
    const { error } = await supabase.rpc('set_booking_status', { p_booking_id: b.id, p_status: status });
    if (error) return setError(errorMessage(error));
    load();
  }

  if (!shop) return null;

  const active = bookings.filter((b) => b.status !== 'cancelled');
  const expected = active.reduce((sum, b) => sum + Number(b.price), 0);
  const ready = setup && setup.services > 0 && setup.barbers > 0 && setup.hours > 0 && shop.is_published;

  return (
    <Screen>
      <T variant="title">Bookings</T>

      {setup && !ready ? (
        <Card>
          <T variant="heading">Get ready for bookings</T>
          <SetupStep done={setup.services > 0} label="Add your services and prices" onPress={() => router.push('/barber/services')} />
          <SetupStep done={setup.barbers > 0 && setup.hours > 0} label="Check your barbers and working hours" onPress={() => router.push('/barber/team')} />
          <SetupStep done={shop.is_published} label="Go live and share your booking link" onPress={() => router.push('/barber/shop')} />
        </Card>
      ) : null}

      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: Spacing.sm }}>
        {days.map((d) => (
          <Chip
            key={d.date}
            label={d.label}
            sublabel={`${d.dayOfMonth} ${d.month}`}
            selected={day === d.date}
            onPress={() => setDay(d.date)}
          />
        ))}
      </ScrollView>

      <ErrorText message={error} />

      <Section
        title={formatDay(dayBounds(day, tz).start, tz)}
        action={active.length ? <T variant="muted">{active.length} · {formatPrice(expected)}</T> : undefined}>
        {bookings.length === 0 ? (
          <Empty title="No bookings" body={shop.is_published ? 'Share your booking link to fill this day.' : undefined} />
        ) : (
          bookings.map((b) => (
            <Card key={b.id} style={b.status === 'cancelled' ? { opacity: 0.6 } : undefined}>
              <Row style={{ justifyContent: 'space-between' }}>
                <T variant="heading">
                  {formatTime(b.starts_at, tz)} – {formatTime(b.ends_at, tz)}
                </T>
                <BookingStatusBadge booking={b} />
              </Row>
              <T variant="label">{b.customer?.full_name || 'Customer'}</T>
              <T>
                {b.service_name} · {formatPrice(b.price)}
                {b.barbers ? ` · ${b.barbers.name}` : ''}
              </T>
              {b.customer_note ? <T variant="muted">“{b.customer_note}”</T> : null}
              {b.status === 'confirmed' ? (
                <Row>
                  {new Date(b.starts_at).getTime() <= now ? (
                    <>
                      <Button title="Done" variant="secondary" onPress={() => setStatus(b, 'completed')} />
                      <Button title="No-show" variant="ghost" onPress={() => setStatus(b, 'no_show')} />
                    </>
                  ) : null}
                  <Button title="Cancel" variant="ghost" onPress={() => setStatus(b, 'cancelled')} />
                  {b.customer?.phone ? (
                    <Button
                      title="WhatsApp"
                      variant="ghost"
                      onPress={() =>
                        Linking.openURL(
                          whatsappUrl(
                            b.customer!.phone!,
                            `Hi ${b.customer!.full_name}, this is ${shop.name} about your ${b.service_name} on ${formatDay(b.starts_at, tz)} at ${formatTime(b.starts_at, tz)}.`,
                          ),
                        )
                      }
                    />
                  ) : null}
                </Row>
              ) : null}
            </Card>
          ))
        )}
      </Section>
    </Screen>
  );
}

function SetupStep({ done, label, onPress }: { done: boolean; label: string; onPress: () => void }) {
  return (
    <Row style={{ justifyContent: 'space-between', flexWrap: 'nowrap' }}>
      <T style={{ flex: 1 }}>
        {done ? '✓ ' : '○ '}
        {label}
      </T>
      {done ? null : <Button title="Go" variant="secondary" onPress={onPress} />}
    </Row>
  );
}
