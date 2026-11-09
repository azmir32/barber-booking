import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { Linking } from 'react-native';

import { DayPicker } from '@/components/day-picker';
import { Button, Card, Chip, ErrorText, Loading, Row, Screen, Section, T } from '@/components/ui';
import { WALK_IN } from '@/lib/customers';
import { t } from '@/lib/lang';
import { useMyShop } from '@/lib/my-shop';
import { whatsappUrl } from '@/lib/phone';
import { errorMessage, supabase } from '@/lib/supabase';
import {
  formatDay,
  formatPrice,
  formatTime,
  groupByPartOfDay,
  localClock,
  localDateString,
  partOfDay,
  upcomingDays,
  type PartOfDay,
} from '@/lib/time';
import type { Barber, Booking, Slot } from '@/lib/types';

type ShopBooking = Booking & {
  barbers: { name: string } | null;
  customer: { full_name: string; phone: string | null } | null;
};

const whoFor = (b: ShopBooking) =>
  b.customer?.full_name || (b.guest_name === WALK_IN ? t('Walk-in') : b.guest_name) || t('Customer');

/**
 * The shop moves a booking to another free time, when a customer calls to
 * come later: the booking stays theirs, with its note and price, and their
 * app shows the new time. Then one tap tells them on WhatsApp.
 */
export default function MoveBooking() {
  const { shop } = useMyShop();
  const { id } = useLocalSearchParams<{ id: string }>();
  const tz = shop!.time_zone;
  const days = useMemo(() => upcomingDays(15, tz), [tz]);
  const [booking, setBooking] = useState<ShopBooking | null>(null);
  const [barbers, setBarbers] = useState<Barber[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [day, setDay] = useState<string | null>(null);
  const [barberId, setBarberId] = useState<string | null>(null);
  const [startsAt, setStartsAt] = useState<string | null>(null);
  const [part, setPart] = useState<PartOfDay | null>(null);
  // The free times and which day and barber they are for; bumping `version` asks again.
  const [slots, setSlots] = useState<{ key: string; list: Slot[]; error: string | null } | null>(null);
  const [version, setVersion] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [moved, setMoved] = useState<ShopBooking | null>(null);
  // A service hidden or deleted on the Services tab has no free times, whoever the barber.
  const [serviceOff, setServiceOff] = useState<'hidden' | 'deleted' | null>(null);

  useEffect(() => {
    if (!shop || !id) return;
    Promise.all([
      supabase
        .from('bookings')
        .select('*, barbers(name), customer:profiles!bookings_customer_id_fkey(full_name, phone)')
        .eq('id', id)
        .maybeSingle(),
      supabase.from('barbers').select('*').eq('shop_id', shop.id).eq('is_active', true).order('sort_order').order('created_at'),
    ]).then(([b, team]) => {
      if (b.error || team.error) return setLoadError(errorMessage(b.error ?? team.error));
      const row = b.data as ShopBooking | null;
      if (!row || row.is_block || row.status !== 'confirmed' || Date.parse(row.starts_at) <= Date.now()) {
        return setLoadError(t('You can only change an upcoming booking.'));
      }
      const list = (team.data ?? []) as Barber[];
      if (row.service_id) {
        supabase
          .from('services')
          .select('is_active')
          .eq('id', row.service_id)
          .maybeSingle()
          .then(({ data, error: failed }) => setServiceOff(failed || data?.is_active ? null : 'hidden'));
      } else {
        setServiceOff('deleted');
      }
      setBooking(row);
      setBarbers(list);
      setDay(localDateString(new Date(row.starts_at), tz));
      // Same barber unless they are away now.
      setBarberId(list.some((x) => x.id === row.barber_id) ? row.barber_id : (list[0]?.id ?? null));
      setPart(partOfDay(Number(localClock(row.starts_at, tz).slice(0, 2))));
    });
  }, [shop, id, tz]);

  const slotsKey = booking && day && barberId ? `${day}|${barberId}|${version}` : null;

  useEffect(() => {
    if (!booking || !slotsKey) return;
    let active = true;
    supabase
      .rpc('available_slots', {
        p_service_id: booking.service_id,
        p_day: day,
        p_barber_id: barberId,
        // Its own time doesn't count as taken, so it can move 15 minutes later.
        p_ignore_booking: booking.id,
      })
      .then(({ data, error: failed }) => {
        if (!active) return;
        setSlots({ key: slotsKey, list: (data ?? []) as Slot[], error: failed ? errorMessage(failed) : null });
      });
    return () => {
      active = false;
    };
  }, [booking, slotsKey, day, barberId]);

  if (!shop) return null;
  if (!booking) {
    return loadError ? (
      <Screen edges={[]}>
        <ErrorText message={loadError} />
        <Button title={t('Back')} variant="secondary" onPress={() => router.back()} />
      </Screen>
    ) : (
      <Loading />
    );
  }

  const who = whoFor(booking);
  const phone = booking.customer?.phone ?? booking.guest_phone;
  const barberName = (barber: string) => barbers.find((b) => b.id === barber)?.name ?? booking.barbers?.name ?? '';

  if (moved) {
    const vars = {
      who,
      shop: shop.name,
      service: moved.service_name,
      day: formatDay(moved.starts_at, tz),
      time: formatTime(moved.starts_at, tz),
      barber: barberName(moved.barber_id),
    };
    return (
      <Screen edges={[]}>
        <T variant="heading">{t('Booking moved')}</T>
        <T>{t('{who} is now booked on {day} at {time} with {barber}.', vars)}</T>
        <T variant="small">
          {t('Was {day} at {time}.', { day: formatDay(booking.starts_at, tz), time: formatTime(booking.starts_at, tz) })}
        </T>
        {phone ? (
          <Button
            title={t('Let {name} know on WhatsApp', { name: who })}
            onPress={() =>
              Linking.openURL(
                whatsappUrl(phone, t('Hi {who}, this is {shop}. Your {service} is now on {day} at {time}. See you then!', vars)),
              ).catch(() => {})
            }
          />
        ) : null}
        <Button title={t('Done')} variant={phone ? 'secondary' : 'primary'} onPress={() => router.back()} />
      </Screen>
    );
  }

  const fresh = slots && slots.key === slotsKey ? slots : null;
  // The time it is booked at now isn't a new time.
  const isCurrent = (at: string) =>
    barberId === booking.barber_id && Date.parse(at) === Date.parse(booking.starts_at);
  const times = (fresh?.list ?? []).map((s) => s.starts_at).filter((at) => !isCurrent(at));
  const groups = groupByPartOfDay(times, tz);
  const [shownPart, shownTimes] = groups.find(([p]) => p === part) ?? groups[0] ?? [null, []];
  const name = barbers.find((b) => b.id === barberId)?.name ?? '';

  async function move() {
    if (!booking || !startsAt) return setError(t('Pick a new time.'));
    setBusy(true);
    setError(null);
    const { data, error: failed } = await supabase.rpc('reschedule_booking', {
      p_booking_id: booking.id,
      p_starts_at: startsAt,
      p_barber_id: barberId,
    });
    setBusy(false);
    if (failed) {
      setError(errorMessage(failed));
      // Someone may have just taken it: show what is still free.
      setStartsAt(null);
      setVersion((v) => v + 1);
      return;
    }
    setMoved({ ...booking, ...(data as Booking) });
  }

  return (
    <Screen
      edges={[]}
      footer={
        <>
          <ErrorText message={error} />
          <Button title={t('Move to this time')} onPress={move} loading={busy} />
        </>
      }>
      <Card>
        <T variant="label">{who}</T>
        <T>
          {booking.service_name} · {formatPrice(booking.price)}
        </T>
        <T variant="small">
          {t('Booked {day} at {time}', { day: formatDay(booking.starts_at, tz), time: formatTime(booking.starts_at, tz) })}
          {booking.barbers ? ` · ${booking.barbers.name}` : ''}
        </T>
      </Card>

      <Section title={t('Day')}>
        <DayPicker
          days={days}
          selected={day}
          onSelect={(d) => {
            setDay(d);
            setStartsAt(null);
          }}
        />
      </Section>

      {barbers.length > 1 ? (
        <Section title={t('Barber')}>
          <Row role="radiogroup" accessibilityLabel={t('Barber')}>
            {barbers.map((b) => (
              <Chip
                key={b.id}
                label={b.name}
                selected={barberId === b.id}
                onPress={() => {
                  setBarberId(b.id);
                  setStartsAt(null);
                }}
              />
            ))}
          </Row>
        </Section>
      ) : null}

      <Section title={t('New time')}>
        {!fresh ? (
          <T variant="muted">{t('Checking free times…')}</T>
        ) : fresh.error ? (
          <>
            <ErrorText message={`${t('Couldn’t load free times.')} ${fresh.error}`} />
            <Button title={t('Try again')} variant="secondary" onPress={() => setVersion((v) => v + 1)} />
          </>
        ) : groups.length === 0 && serviceOff ? (
          <T variant="muted">
            {serviceOff === 'hidden'
              ? t('{service} is hidden on the Services tab, so it has no free times. Show it there to move this booking.', {
                  service: booking.service_name,
                })
              : t('{service} was deleted, so it has no free times. Cancel this booking and add a new one instead.', {
                  service: booking.service_name,
                })}
          </T>
        ) : groups.length === 0 ? (
          <T variant="muted">{t('{name} has no free times this day.', { name })}</T>
        ) : (
          <>
            <Row role="radiogroup" accessibilityLabel={t('Part of the day')}>
              {groups.map(([p, list]) => (
                <Chip
                  key={p}
                  label={t(p)}
                  sublabel={t('{count} free', { count: list.length })}
                  selected={p === shownPart}
                  onPress={() => setPart(p)}
                />
              ))}
            </Row>
            <Row role="radiogroup" accessibilityLabel={t('Free times for {name}', { name })}>
              {shownTimes.map((at) => (
                <Chip key={at} label={formatTime(at, tz)} selected={startsAt === at} onPress={() => setStartsAt(at)} />
              ))}
            </Row>
          </>
        )}
      </Section>
    </Screen>
  );
}
