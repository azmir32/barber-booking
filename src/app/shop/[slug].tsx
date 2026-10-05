import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { Linking, View } from 'react-native';

import { DayPicker } from '@/components/day-picker';
import { Button, Card, Chip, Empty, ErrorText, Field, Loading, Row, Screen, Section, T } from '@/components/ui';
import { Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { useAuth } from '@/lib/auth';
import { whatsappUrl } from '@/lib/phone';
import { errorMessage, supabase } from '@/lib/supabase';
import { formatClock, shopWeek, WEEK_ORDER } from '@/lib/hours';
import { formatDay, formatDuration, formatPrice, formatTime, groupByPartOfDay, localDateString, upcomingDays } from '@/lib/time';
import { WEEKDAYS, type Barber, type Booking, type Service, type Shop, type Slot, type WorkingHours } from '@/lib/types';

type BarberWithHours = Barber & { working_hours: Pick<WorkingHours, 'weekday' | 'opens_at' | 'closes_at'>[] };

const DAYS_AHEAD = 14;

export default function ShopPage() {
  const { slug } = useLocalSearchParams<{ slug: string }>();
  const { session } = useAuth();
  const theme = useTheme();

  const [shop, setShop] = useState<Shop | null>(null);
  const [services, setServices] = useState<Service[]>([]);
  const [barbers, setBarbers] = useState<BarberWithHours[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [serviceId, setServiceId] = useState<string | null>(null);
  const [barberId, setBarberId] = useState<string | null>(null); // null = any barber
  const days = useMemo(() => upcomingDays(DAYS_AHEAD, shop?.time_zone), [shop?.time_zone]);
  const [pickedDay, setPickedDay] = useState<string | null>(null);
  const day = pickedDay ?? days[0]?.date ?? null;
  const [slots, setSlots] = useState<Slot[]>([]);
  // Which request the current `slots` answer; bumping slotsVersion refetches.
  const [slotsFor, setSlotsFor] = useState<string | null>(null);
  const [slotsVersion, setSlotsVersion] = useState(0);
  const [startsAt, setStartsAt] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [booking, setBooking] = useState(false);
  const [confirmed, setConfirmed] = useState<Booking | null>(null);

  useEffect(() => {
    (async () => {
      setLoading(true);
      const { data: shopRow, error } = await supabase.from('shops').select('*').eq('slug', slug).maybeSingle();
      if (error || !shopRow) {
        setError(error ? errorMessage(error) : null);
        setLoading(false);
        return;
      }
      const [svc, brb] = await Promise.all([
        supabase.from('services').select('*').eq('shop_id', shopRow.id).eq('is_active', true).order('sort_order').order('name'),
        supabase
          .from('barbers')
          .select('*, working_hours(weekday, opens_at, closes_at)')
          .eq('shop_id', shopRow.id)
          .eq('is_active', true)
          .order('sort_order')
          .order('name'),
      ]);
      setShop(shopRow as Shop);
      setServices((svc.data ?? []) as Service[]);
      setBarbers((brb.data ?? []) as BarberWithHours[]);
      setLoading(false);
    })();
  }, [slug]);

  const slotsKey = serviceId && day ? `${serviceId}|${day}|${barberId ?? 'any'}|${slotsVersion}` : null;
  const slotsLoading = slotsKey !== null && slotsKey !== slotsFor;

  useEffect(() => {
    if (!slotsKey || !serviceId || !day) return;
    let active = true;
    supabase
      .rpc('available_slots', { p_service_id: serviceId, p_day: day, p_barber_id: barberId })
      .then(({ data, error }) => {
        if (!active) return;
        if (error) setError(errorMessage(error));
        setSlots((data ?? []) as Slot[]);
        setSlotsFor(slotsKey);
      });
    return () => {
      active = false;
    };
  }, [slotsKey, serviceId, day, barberId]);

  // Changing service, barber or day clears the picked time.
  const pickService = (id: string) => {
    setServiceId(id);
    setStartsAt(null);
  };
  const pickBarber = (id: string | null) => {
    setBarberId(id);
    setStartsAt(null);
  };
  const pickDay = (d: string) => {
    setPickedDay(d);
    setStartsAt(null);
  };

  // With "any barber", several barbers can share a start time; show it once.
  const times = useMemo(() => [...new Set(slots.map((s) => s.starts_at))], [slots]);
  const timeGroups = useMemo(() => groupByPartOfDay(times, shop?.time_zone), [times, shop?.time_zone]);
  const week = useMemo(() => shopWeek(barbers.flatMap((b) => b.working_hours ?? [])), [barbers]);
  const service = services.find((s) => s.id === serviceId);
  const barberName = barbers.find((b) => b.id === barberId)?.name;

  async function book() {
    if (!session) {
      router.push({ pathname: '/sign-in', params: { next: `/shop/${slug}` } });
      return;
    }
    if (!serviceId || !startsAt) return;
    setBooking(true);
    setError(null);
    const { data, error } = await supabase.rpc('book_appointment', {
      p_service_id: serviceId,
      p_starts_at: startsAt,
      p_barber_id: barberId,
      p_note: note,
    });
    setBooking(false);
    if (error) {
      setError(errorMessage(error));
      setStartsAt(null);
      setSlotsVersion((v) => v + 1);
      return;
    }
    setConfirmed(data as Booking);
  }

  if (loading) return <Loading />;
  if (!shop) {
    return (
      <Screen edges={[]}>
        <Empty title="Shop not found" body="This booking link may be wrong, or the shop isn't taking bookings right now.">
          <Button title="Find another barber" onPress={() => router.replace('/customer')} />
        </Empty>
      </Screen>
    );
  }

  if (confirmed) {
    const tz = shop.time_zone;
    const who = barbers.find((b) => b.id === confirmed.barber_id)?.name;
    return (
      <Screen edges={[]}>
        <Stack.Screen options={{ title: shop.name }} />
        <Empty
          title="You're booked!"
          body={`${confirmed.service_name}${who ? ` with ${who}` : ''} on ${formatDay(confirmed.starts_at, tz)} at ${formatTime(confirmed.starts_at, tz)}.`}
        />
        <Card>
          <T variant="label">{shop.name}</T>
          {shop.address ? <T variant="muted">{shop.address}</T> : null}
          <T variant="small">{"Can't make it? Cancel from My bookings so someone else can take the slot."}</T>
          {shop.phone ? (
            <Button title="WhatsApp the shop" variant="secondary" onPress={() => Linking.openURL(whatsappUrl(shop.phone!))} />
          ) : null}
        </Card>
        <Button title="See my bookings" onPress={() => router.replace('/customer/bookings')} />
      </Screen>
    );
  }

  return (
    <Screen edges={[]}>
      <Stack.Screen options={{ title: shop.name }} />
      <View style={{ gap: Spacing.xs }}>
        <T variant="title">{shop.name}</T>
        <T variant="muted">{shop.address || shop.area}</T>
        {shop.about ? <T>{shop.about}</T> : null}
        <Row>
          {shop.phone ? (
            <Button title="WhatsApp" variant="secondary" onPress={() => Linking.openURL(whatsappUrl(shop.phone!))} />
          ) : null}
          {shop.instagram ? (
            <Button
              title="Instagram"
              variant="secondary"
              onPress={() => Linking.openURL(`https://instagram.com/${shop.instagram!.replace(/^@/, '')}`)}
            />
          ) : null}
        </Row>
      </View>

      {services.length === 0 || barbers.length === 0 ? (
        <Empty title="Not taking online bookings yet" body="Message the shop to book for now." />
      ) : (
        <>
          <Section title="1. Pick a service">
            {services.map((s) => (
              <Card
                key={s.id}
                onPress={() => pickService(s.id)}
                style={s.id === serviceId ? { borderColor: theme.accent, borderWidth: 2 } : undefined}>
                <Row style={{ justifyContent: 'space-between' }}>
                  <T variant="label">{s.name}</T>
                  <T variant="label">{formatPrice(s.price)}</T>
                </Row>
                <T variant="small">{formatDuration(s.duration_min)}</T>
              </Card>
            ))}
          </Section>

          {serviceId ? (
            <>
              {barbers.length > 1 ? (
                <Section title="2. Pick a barber">
                  <Row>
                    <Chip label="Any barber" selected={barberId === null} onPress={() => pickBarber(null)} />
                    {barbers.map((b) => (
                      <Chip key={b.id} label={b.name} selected={barberId === b.id} onPress={() => pickBarber(b.id)} />
                    ))}
                  </Row>
                </Section>
              ) : null}

              <Section title={barbers.length > 1 ? '3. Pick a time' : '2. Pick a time'}>
                <DayPicker days={days} selected={day} onSelect={pickDay} />
                {slotsLoading ? (
                  <T variant="muted">Checking free times…</T>
                ) : times.length === 0 ? (
                  <T variant="muted">No free times this day. Try another day{barberId ? ' or any barber' : ''}.</T>
                ) : (
                  timeGroups.map(([part, list]) => (
                    <View key={part} style={{ gap: Spacing.sm }}>
                      <T variant="small">{part}</T>
                      <Row>
                        {list.map((t) => (
                          <Chip
                            key={t}
                            label={formatTime(t, shop.time_zone)}
                            selected={startsAt === t}
                            onPress={() => setStartsAt(t)}
                          />
                        ))}
                      </Row>
                    </View>
                  ))
                )}
              </Section>
            </>
          ) : null}

          {service && startsAt ? (
            <Card>
              <T variant="heading">
                {formatDay(startsAt, shop.time_zone)}, {formatTime(startsAt, shop.time_zone)}
              </T>
              <T>
                {service.name}
                {barberName ? ` with ${barberName}` : ''} · {formatDuration(service.duration_min)} ·{' '}
                {formatPrice(service.price)}
              </T>
              <T variant="small">Pay at the shop.</T>
              <Field
                label="Note for your barber (optional)"
                value={note}
                onChangeText={setNote}
                placeholder="e.g. low fade, keep the top long"
                maxLength={280}
              />
              <ErrorText message={error} />
              <Button
                title={session ? 'Confirm booking' : 'Sign in to book'}
                onPress={book}
                loading={booking}
              />
            </Card>
          ) : (
            <ErrorText message={error} />
          )}
        </>
      )}

      {week.some(Boolean) ? (
        <Card>
          <T variant="label">Opening hours</T>
          {WEEK_ORDER.map((weekday) => {
            const d = week[weekday];
            const isToday = weekday === new Date(`${localDateString(new Date(), shop.time_zone)}T00:00:00Z`).getUTCDay();
            return (
              <Row key={weekday} style={{ justifyContent: 'space-between' }}>
                <T variant={isToday ? 'label' : 'muted'}>{WEEKDAYS[weekday]}</T>
                <T variant={isToday ? 'label' : 'muted'}>
                  {d ? `${formatClock(d.opens)} – ${formatClock(d.closes)}` : 'Closed'}
                </T>
              </Row>
            );
          })}
        </Card>
      ) : null}
    </Screen>
  );
}
