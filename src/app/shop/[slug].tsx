import { router, Stack, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useEffectEvent, useMemo, useRef, useState } from 'react';
import { Linking, View, type LayoutChangeEvent, type ScrollView } from 'react-native';

import { DayPicker } from '@/components/day-picker';
import { Button, Card, Chip, Empty, ErrorText, Field, Loading, Row, Screen, Section, T } from '@/components/ui';
import { Spacing } from '@/constants/theme';
import { useAuth } from '@/lib/auth';
import { t } from '@/lib/lang';
import { whatsappUrl } from '@/lib/phone';
import { errorMessage, supabase } from '@/lib/supabase';
import { formatClock, shopWeek, WEEK_ORDER } from '@/lib/hours';
import {
  formatDay,
  formatDuration,
  formatPrice,
  formatTime,
  groupByPartOfDay,
  localDateString,
  upcomingDays,
  type PartOfDay,
} from '@/lib/time';
import { WEEKDAYS, type Barber, type Booking, type Service, type Shop, type Slot, type WorkingHours } from '@/lib/types';

type BarberWithHours = Barber & { working_hours: Pick<WorkingHours, 'weekday' | 'opens_at' | 'closes_at'>[] };
type Step = 'barber' | 'time';

const DAYS_AHEAD = 14;

/** "Fri, 9 Oct" for a YYYY-MM-DD date. */
const dayText = (date: string) => formatDay(`${date}T00:00:00Z`, 'UTC');

/** "Ali", "Ali or Danial", "Ali, Danial or Hafiz". */
const orList = (names: string[]) =>
  names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} ${t('or')} ${names.at(-1)}`;

export default function ShopPage() {
  // `name` titles the header while the shop loads; "Book again" passes `service` and `barber`.
  const params = useLocalSearchParams<{ slug: string; name?: string; service?: string; barber?: string }>();
  const { slug } = params;
  const { session, profile } = useAuth();

  const [shop, setShop] = useState<Shop | null>(null);
  const [services, setServices] = useState<Service[]>([]);
  const [barbers, setBarbers] = useState<BarberWithHours[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);

  const [serviceId, setServiceId] = useState<string | null>(null);
  const [barberId, setBarberId] = useState<string | null>(null); // null = any barber
  const days = useMemo(() => upcomingDays(DAYS_AHEAD, shop?.time_zone), [shop?.time_zone]);
  const today = days[0]?.date ?? null;
  // Days nobody works (or the picked barber doesn't), so they can be shown as closed.
  const closedDays = useMemo(() => {
    const working = barbers.filter((b) => !barberId || b.id === barberId);
    const open = new Set(working.flatMap((b) => (b.working_hours ?? []).map((h) => h.weekday)));
    return new Set(days.filter((d) => !open.has(new Date(`${d.date}T00:00:00Z`).getUTCDay())).map((d) => d.date));
  }, [barbers, barberId, days]);
  const [pickedDay, setPickedDay] = useState<string | null>(null);
  // Late in the evening today has nothing left. Remember that for this service and
  // barber, so the page opens on the next open day instead of an empty Today.
  const pickKey = `${serviceId}|${barberId ?? 'any'}`;
  const [todayFullFor, setTodayFullFor] = useState<string | null>(null);
  const skipToday = todayFullFor === pickKey;
  const autoDay = days.find((d) => !closedDays.has(d.date) && !(skipToday && d.date === today))?.date ?? today;
  // A day the customer tapped is kept, unless the barber they then picked doesn't work it.
  const day = pickedDay && !closedDays.has(pickedDay) ? pickedDay : autoDay;
  const autoPicked = day !== pickedDay;
  const checkToday = autoPicked && day === today;

  const [slots, setSlots] = useState<Slot[]>([]);
  const [slotsError, setSlotsError] = useState<string | null>(null);
  // Which request the current `slots` answer; bumping slotsVersion refetches.
  const [slotsFor, setSlotsFor] = useState<string | null>(null);
  const [slotsVersion, setSlotsVersion] = useState(0);
  const [part, setPart] = useState<PartOfDay | null>(null);
  const [startsAt, setStartsAt] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [booking, setBooking] = useState(false);
  const [bookError, setBookError] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState<Booking | null>(null);
  // Set while a guest signs up to book; once they are back and signed in, the booking goes through.
  const pendingBook = useRef(false);

  const scrollRef = useRef<ScrollView>(null);
  // Where the steps below the services start, and a step to scroll to once it is laid out.
  const stepY = useRef<Partial<Record<Step, number>>>({});
  const scrollAfterLayout = useRef<Step | null>(null);

  useEffect(() => {
    (async () => {
      setLoading(true);
      setLoadError(null);
      const { data: shopRow, error } = await supabase.from('shops').select('*').eq('slug', slug).maybeSingle();
      if (error || !shopRow) {
        setLoadError(error ? errorMessage(error) : null);
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
      // Without these the page would wrongly say the shop isn't taking bookings.
      if (svc.error || brb.error) {
        setLoadError(errorMessage(svc.error ?? brb.error));
        setLoading(false);
        return;
      }
      const activeServices = (svc.data ?? []) as Service[];
      const activeBarbers = (brb.data ?? []) as BarberWithHours[];
      setShop(shopRow as Shop);
      setServices(activeServices);
      setBarbers(activeBarbers);
      // Book again: start from the last visit's picks if the shop still offers them.
      if (activeBarbers.some((b) => b.id === params.barber)) setBarberId(params.barber!);
      if (activeServices.some((s) => s.id === params.service)) {
        setServiceId(params.service!);
        scrollAfterLayout.current = 'time';
      }
      setLoading(false);
    })();
  }, [slug, reload, params.service, params.barber]);

  const slotsKey = serviceId && day ? `${serviceId}|${day}|${barberId ?? 'any'}|${slotsVersion}` : null;
  const slotsLoading = slotsKey !== null && slotsKey !== slotsFor;

  useEffect(() => {
    if (!slotsKey || !serviceId || !day) return;
    let active = true;
    supabase
      .rpc('available_slots', { p_service_id: serviceId, p_day: day, p_barber_id: barberId })
      .then(({ data, error }) => {
        if (!active) return;
        setSlotsError(error ? errorMessage(error) : null);
        setSlots((data ?? []) as Slot[]);
        setSlotsFor(slotsKey);
        if (checkToday && !error && !data?.length) setTodayFullFor(pickKey);
      });
    return () => {
      active = false;
    };
  }, [slotsKey, serviceId, day, barberId, checkToday, pickKey]);

  function scrollToStep(step: Step) {
    const y = stepY.current[step];
    if (y === undefined) scrollAfterLayout.current = step;
    else scrollRef.current?.scrollTo({ y: Math.max(0, y - Spacing.lg), animated: true });
  }
  // The steps appear after the first pick and grow when the free times arrive. Until
  // then the page is too short to scroll that far, so keep following the step.
  function onStepLayout(step: Step, e: LayoutChangeEvent) {
    stepY.current[step] = e.nativeEvent.layout.y;
    const target = scrollAfterLayout.current;
    if (!target || stepY.current[target] === undefined) return;
    if (!slotsLoading) scrollAfterLayout.current = null;
    scrollToStep(target);
  }

  // Changing service, barber or day clears the picked time, and any error about the last one.
  const pickTime = (time: string | null) => {
    setStartsAt(time);
    setBookError(null);
    pendingBook.current = false;
    scrollAfterLayout.current = null;
  };
  const pickService = (id: string) => {
    setServiceId(id);
    pickTime(null);
    scrollToStep(barbers.length > 1 ? 'barber' : 'time');
  };
  const pickBarber = (id: string | null) => {
    setBarberId(id);
    pickTime(null);
  };
  const pickDay = (d: string) => {
    setPickedDay(d);
    pickTime(null);
  };

  // With "any barber", several barbers can share a start time; show it once.
  const times = useMemo(() => [...new Set(slots.map((s) => s.starts_at))], [slots]);
  const timeGroups = useMemo(() => groupByPartOfDay(times, shop?.time_zone), [times, shop?.time_zone]);
  // One part of the day at a time keeps the grid short. The customer's choice
  // sticks across days while that part still has free times.
  const [shownPart, shownTimes] = timeGroups.find(([p]) => p === part) ?? timeGroups[0] ?? [null, []];
  const nextOpen = day ? days.find((d) => d.date > day && !closedDays.has(d.date)) : undefined;
  const week = useMemo(() => shopWeek(barbers.flatMap((b) => b.working_hours ?? [])), [barbers]);
  const service = services.find((s) => s.id === serviceId);
  // Who can take the picked time. With "any barber" the booking goes to one of them, so say so up front.
  const freeNames = barbers
    .filter((b) => slots.some((s) => s.barber_id === b.id && s.starts_at === startsAt))
    .map((b) => b.name);
  const serviceWith = (name: string) =>
    freeNames.length === 1
      ? t('{service} with {barber}', { service: name, barber: freeNames[0] })
      : freeNames.length > 1
        ? t('{service} with {names}, whoever is free', { service: name, names: orList(freeNames) })
        : name;

  async function book() {
    if (!service || !startsAt) return;
    if (!session) {
      // Sign-up comes back to this page with the picks intact, then the effect below books.
      pendingBook.current = true;
      router.push({
        pathname: '/sign-up',
        params: {
          next: `/shop/${slug}`,
          role: 'customer',
          summary: `${service.name} · ${formatDay(startsAt, shop?.time_zone)}, ${formatTime(startsAt, shop?.time_zone)}`,
        },
      });
      return;
    }
    setBooking(true);
    setBookError(null);
    const { data, error } = await supabase.rpc('book_appointment', {
      p_service_id: service.id,
      p_starts_at: startsAt,
      p_barber_id: barberId,
      p_note: note,
    });
    setBooking(false);
    if (error) {
      setBookError(errorMessage(error));
      setStartsAt(null);
      setSlotsVersion((v) => v + 1);
      return;
    }
    setConfirmed(data as Booking);
  }

  const bookAfterSignUp = useEffectEvent(() => {
    if (!pendingBook.current || !startsAt) return;
    pendingBook.current = false;
    book();
  });
  useEffect(() => {
    if (session) bookAfterSignUp();
  }, [session]);
  // Back here still signed out means they left sign-up, so a later sign-in must not book on its own.
  useFocusEffect(
    useCallback(() => {
      if (!session) pendingBook.current = false;
    }, [session]),
  );

  const header = <Stack.Screen options={{ title: shop?.name ?? params.name ?? '' }} />;

  if (loading) {
    return (
      <>
        {header}
        <Loading />
      </>
    );
  }
  if (loadError) {
    return (
      <Screen edges={[]}>
        {header}
        <Empty title={t('Couldn’t load this shop')} body={t('Check your connection and try again.')}>
          <Button title={t('Try again')} variant="secondary" onPress={() => setReload((n) => n + 1)} />
        </Empty>
      </Screen>
    );
  }
  if (!shop) {
    return (
      <Screen edges={[]}>
        <Stack.Screen options={{ title: t('Shop not found') }} />
        <Empty
          title={t('Shop not found')}
          body={t('This booking link may be wrong, or the shop isn’t taking bookings right now.')}>
          <Button title={t('Find another barber')} onPress={() => router.replace('/customer')} />
        </Empty>
      </Screen>
    );
  }

  const tz = shop.time_zone;

  if (confirmed) {
    const who = barbers.find((b) => b.id === confirmed.barber_id)?.name;
    const what = who ? t('{service} with {barber}', { service: confirmed.service_name, barber: who }) : confirmed.service_name;
    const when = { day: formatDay(confirmed.starts_at, tz), time: formatTime(confirmed.starts_at, tz) };
    // Tells the barber which booking the chat is about, so they don't have to ask.
    const message = profile?.full_name
      ? t('Hi {shop}, this is {name}. I booked {service} on {day} at {time}.', {
          shop: shop.name,
          name: profile.full_name,
          service: what,
          ...when,
        })
      : undefined;
    const place = encodeURIComponent(`${shop.name}, ${shop.address || shop.area}`);
    return (
      // A new key starts the booked page at the top instead of where the picker was scrolled.
      <Screen key="booked" edges={[]}>
        {header}
        <Empty title={t('You’re booked!')} body={t('{service} on {day} at {time}.', { service: what, ...when })}>
          <T variant="label">
            {formatPrice(confirmed.price)} · {t('Pay at the shop.')}
          </T>
          {confirmed.customer_note ? (
            <T variant="muted" style={{ textAlign: 'center' }}>
              “{confirmed.customer_note}”
            </T>
          ) : null}
        </Empty>
        <Card>
          <T variant="label">{shop.name}</T>
          {shop.address ? <T variant="muted">{shop.address}</T> : null}
          {/* A maps search link needs no API key, and Android offers Google Maps or Waze. */}
          <Button
            title={t('Directions')}
            variant="secondary"
            onPress={() => Linking.openURL(`https://www.google.com/maps/search/?api=1&query=${place}`)}
          />
          {shop.phone ? (
            <Button
              title={t('WhatsApp the shop')}
              variant="secondary"
              onPress={() => Linking.openURL(whatsappUrl(shop.phone!, message))}
            />
          ) : null}
          <T variant="small">{t('Can’t make it? Cancel from My bookings so someone else can take the slot.')}</T>
        </Card>
        <Button title={t('See my bookings')} onPress={() => router.replace('/customer/bookings')} />
      </Screen>
    );
  }

  // Stays at the bottom so Confirm is never buried under the time chips.
  const footer =
    service && startsAt ? (
      <>
        <T variant="label" numberOfLines={2}>
          {formatDay(startsAt, tz)}, {formatTime(startsAt, tz)} · {serviceWith(service.name)} · {formatPrice(service.price)}
        </T>
        <Button title={session ? t('Confirm booking') : t('Continue to book')} onPress={book} loading={booking} />
      </>
    ) : bookError ? (
      <ErrorText message={bookError} />
    ) : null;

  return (
    <Screen edges={[]} scrollRef={scrollRef} footer={footer}>
      {header}
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
        <Empty title={t('Not taking online bookings yet')} body={t('Message the shop to book for now.')} />
      ) : (
        <>
          <Section title={t('1. Pick a service')}>
            {services.map((s) => (
              <Card key={s.id} role="radio" selected={s.id === serviceId} onPress={() => pickService(s.id)}>
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
                <View onLayout={(e) => onStepLayout('barber', e)}>
                  <Section title={t('2. Pick a barber')}>
                    <Row role="radiogroup" accessibilityLabel={t('Barber')}>
                      <Chip label={t('Any barber')} selected={barberId === null} onPress={() => pickBarber(null)} />
                      {barbers.map((b) => (
                        <Chip key={b.id} label={b.name} selected={barberId === b.id} onPress={() => pickBarber(b.id)} />
                      ))}
                    </Row>
                  </Section>
                </View>
              ) : null}

              <View onLayout={(e) => onStepLayout('time', e)}>
                <Section title={barbers.length > 1 ? t('3. Pick a time') : t('2. Pick a time')}>
                  <DayPicker
                    days={days}
                    selected={day}
                    onSelect={pickDay}
                    closed={closedDays}
                    closedLabel={barberId ? t('Off') : t('Closed')}
                  />
                  {autoPicked && skipToday && day ? (
                    <T variant="small">{t('No times left today. Showing {day}.', { day: dayText(day) })}</T>
                  ) : null}
                  {slotsLoading ? (
                    <T variant="muted">{t('Checking free times…')}</T>
                  ) : slotsError ? (
                    <>
                      <ErrorText message={`${t('Couldn’t load free times.')} ${slotsError}`} />
                      <Button title={t('Try again')} variant="secondary" onPress={() => setSlotsVersion((v) => v + 1)} />
                    </>
                  ) : times.length === 0 ? (
                    <>
                      <T variant="muted">
                        {barberId
                          ? t('No free times this day. Try another day or any barber.')
                          : t('No free times this day. Try another day.')}
                      </T>
                      {nextOpen ? (
                        <Button
                          title={t('See {day}', { day: dayText(nextOpen.date) })}
                          variant="secondary"
                          onPress={() => pickDay(nextOpen.date)}
                        />
                      ) : null}
                    </>
                  ) : (
                    <>
                      <Row role="radiogroup" accessibilityLabel={t('Part of the day')}>
                        {timeGroups.map(([p, list]) => (
                          <Chip
                            key={p}
                            label={t(p)}
                            sublabel={t('{count} free', { count: list.length })}
                            selected={p === shownPart}
                            onPress={() => setPart(p)}
                          />
                        ))}
                      </Row>
                      <Row role="radiogroup" accessibilityLabel={t('Free times')}>
                        {shownTimes.map((time) => (
                          <Chip
                            key={time}
                            label={formatTime(time, tz)}
                            selected={startsAt === time}
                            onPress={() => pickTime(time)}
                          />
                        ))}
                      </Row>
                    </>
                  )}
                </Section>
              </View>
            </>
          ) : null}

          {service && startsAt ? (
            <Card>
              <T variant="heading">
                {formatDay(startsAt, tz)}, {formatTime(startsAt, tz)}
              </T>
              <T>
                {serviceWith(service.name)} · {formatDuration(service.duration_min)} · {formatPrice(service.price)}
              </T>
              <T variant="small">{t('Pay at the shop.')}</T>
              <Field
                label={t('Note for your barber (optional)')}
                value={note}
                onChangeText={setNote}
                placeholder={t('e.g. low fade, keep the top long')}
                maxLength={280}
              />
            </Card>
          ) : null}
        </>
      )}

      {week.some(Boolean) ? (
        <Card>
          <T variant="label">{t('Opening hours')}</T>
          {WEEK_ORDER.map((weekday) => {
            const d = week[weekday];
            const isToday = weekday === new Date(`${localDateString(new Date(), tz)}T00:00:00Z`).getUTCDay();
            return (
              <Row key={weekday} style={{ justifyContent: 'space-between' }}>
                <T variant={isToday ? 'label' : 'muted'}>{t(WEEKDAYS[weekday])}</T>
                <T variant={isToday ? 'label' : 'muted'}>
                  {d ? `${formatClock(d.opens)} – ${formatClock(d.closes)}` : t('Closed')}
                </T>
              </Row>
            );
          })}
        </Card>
      ) : null}
    </Screen>
  );
}
