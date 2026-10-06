import { router, useFocusEffect } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import { Linking } from 'react-native';

import { BookingStatusBadge } from '@/components/booking-status';
import { DayPicker } from '@/components/day-picker';
import { Badge, Button, Card, Empty, ErrorText, Row, Screen, Section, T } from '@/components/ui';
import { useNow } from '@/hooks/use-now';
import { confirmAction } from '@/lib/confirm';
import { t } from '@/lib/lang';
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
      // New online bookings show up while the screen stays open at the counter.
      const timer = setInterval(load, 60_000);
      return () => clearInterval(timer);
    }, [load]),
  );

  async function setStatus(b: ShopBooking, status: BookingStatus) {
    if (status === 'cancelled') {
      const ok = b.is_block
        ? await confirmAction(t('Remove this block?'), t('Customers will be able to book this time again.'), t('Remove'))
        : await confirmAction(
            t('Cancel this booking?'),
            t('{who} · {service} at {time}. Let them know on WhatsApp.', {
              who: whoFor(b),
              service: b.service_name,
              time: formatTime(b.starts_at, tz),
            }),
            t('Cancel booking'),
          );
      if (!ok) return;
    }
    const { error } = await supabase.rpc('set_booking_status', { p_booking_id: b.id, p_status: status });
    if (error) return setError(errorMessage(error));
    load();
  }

  if (!shop) return null;

  const active = bookings.filter((b) => b.status !== 'cancelled' && !b.is_block);
  const expected = active.reduce((sum, b) => sum + Number(b.price), 0);
  const ready = setup && setup.services > 0 && setup.barbers > 0 && setup.hours > 0 && shop.is_published;

  return (
    <Screen onRefresh={load}>
      <T variant="title">{t('Bookings')}</T>

      {setup && !ready ? (
        <Card>
          <T variant="heading">{t('Get ready for bookings')}</T>
          <SetupStep
            done={setup.services > 0}
            label={t('Add your services and prices')}
            onPress={() => router.push('/barber/services')}
          />
          <SetupStep
            done={setup.barbers > 0 && setup.hours > 0}
            label={t('Check your barbers and working hours')}
            onPress={() => router.push('/barber/team')}
          />
          <SetupStep
            done={shop.is_published}
            label={t('Go live and share your booking link')}
            onPress={() => router.push('/barber/shop')}
          />
        </Card>
      ) : null}

      <DayPicker days={days} selected={day} onSelect={setDay} />

      <ErrorText message={error} />

      <Section
        title={formatDay(dayBounds(day, tz).start, tz)}
        action={active.length ? <T variant="muted">{active.length} · {formatPrice(expected)}</T> : undefined}>
        <Button
          title={t('+ Add booking or block time')}
          variant="secondary"
          onPress={() => router.push({ pathname: '/barber/new-booking', params: { day } })}
        />
        {bookings.length === 0 ? (
          <Empty
            title={t('No bookings')}
            body={shop.is_published ? t('Share your booking link to fill this day.') : undefined}
          />
        ) : (
          bookings.map((b) => {
            const phone = b.customer?.phone ?? b.guest_phone;
            const live = b.status === 'confirmed';
            return (
              <Card key={b.id} style={b.status === 'cancelled' ? { opacity: 0.6 } : undefined}>
                <Row style={{ justifyContent: 'space-between' }}>
                  <T variant="heading">
                    {isWholeDay(b) ? t('Whole day') : `${formatTime(b.starts_at, tz)} – ${formatTime(b.ends_at, tz)}`}
                  </T>
                  {b.is_block ? <Badge label={t('Blocked')} /> : <BookingStatusBadge booking={b} />}
                </Row>
                {b.is_block ? (
                  <T>
                    {b.service_name}
                    {b.barbers ? ` · ${b.barbers.name}` : ''}
                  </T>
                ) : (
                  <>
                    <T variant="label">
                      {b.customer_id ? whoFor(b) : t('{name} (added by you)', { name: whoFor(b) })}
                    </T>
                    <T>
                      {b.service_name} · {formatPrice(b.price)}
                      {b.barbers ? ` · ${b.barbers.name}` : ''}
                    </T>
                  </>
                )}
                {b.customer_note ? <T variant="muted">“{b.customer_note}”</T> : null}
                {live ? (
                  <Row>
                    {!b.is_block && new Date(b.starts_at).getTime() <= now ? (
                      <>
                        <Button title={t('Done')} variant="secondary" onPress={() => setStatus(b, 'completed')} />
                        <Button title={t('No-show')} variant="ghost" onPress={() => setStatus(b, 'no_show')} />
                      </>
                    ) : null}
                    <Button title={b.is_block ? t('Remove') : t('Cancel')} variant="ghost" onPress={() => setStatus(b, 'cancelled')} />
                    {phone && !b.is_block ? (
                      <Button
                        title="WhatsApp"
                        variant="ghost"
                        onPress={() =>
                          Linking.openURL(
                            whatsappUrl(
                              phone,
                              t('Hi {who}, this is {shop} about your {service} on {day} at {time}.', {
                                who: whoFor(b),
                                shop: shop.name,
                                service: b.service_name,
                                day: formatDay(b.starts_at, tz),
                                time: formatTime(b.starts_at, tz),
                              }),
                            ),
                          )
                        }
                      />
                    ) : null}
                  </Row>
                ) : null}
              </Card>
            );
          })
        )}
      </Section>
    </Screen>
  );
}

const isWholeDay = (b: Booking) =>
  b.is_block && new Date(b.ends_at).getTime() - new Date(b.starts_at).getTime() >= 24 * 60 * 60 * 1000;

function whoFor(b: ShopBooking): string {
  return b.customer?.full_name || b.guest_name || t('Customer');
}

function SetupStep({ done, label, onPress }: { done: boolean; label: string; onPress: () => void }) {
  return (
    <Row style={{ justifyContent: 'space-between', flexWrap: 'nowrap' }}>
      <T style={{ flex: 1 }}>
        {done ? '✓ ' : '○ '}
        {label}
      </T>
      {done ? null : <Button title={t('Go')} variant="secondary" onPress={onPress} />}
    </Row>
  );
}
