import { router, Stack, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useEffectEvent, useMemo, useRef, useState } from 'react';
import { Linking, View, type LayoutChangeEvent, type ScrollView, type TextInput } from 'react-native';

import { DayPicker } from '@/components/day-picker';
import { Button, Card, Chip, Empty, ErrorText, Field, Loading, Row, Screen, Section, T } from '@/components/ui';
import { APP_NAME, bookingLink } from '@/constants/brand';
import { Spacing } from '@/constants/theme';
import { useNow } from '@/hooks/use-now';
import { useTheme } from '@/hooks/use-theme';
import { addToCalendar } from '@/lib/add-to-calendar';
import { useAuth } from '@/lib/auth';
import { bookingEvent } from '@/lib/calendar';
import { t } from '@/lib/lang';
import { directionsUrl } from '@/lib/maps';
import { whatsappUrl } from '@/lib/phone';
import { errorMessage, supabase } from '@/lib/supabase';
import { formatClock, openStatus, shopWeek, WEEK_ORDER } from '@/lib/hours';
import {
  formatClockOnly,
  formatDay,
  formatDuration,
  formatPrice,
  formatTime,
  groupByPartOfDay,
  localClock,
  localDateString,
  noBreak,
  partOfDay,
  upcomingDays,
  type PartOfDay,
} from '@/lib/time';
import { WEEKDAYS, type Barber, type Booking, type Service, type Shop, type Slot, type WorkingHours } from '@/lib/types';

type BarberWithHours = Barber & { working_hours: Pick<WorkingHours, 'weekday' | 'opens_at' | 'closes_at'>[] };
type Step = 'move' | 'barber' | 'time' | 'note';
/** A shop that exists but is hidden from customers (paused, or its trial ended). */
type HiddenShop = { name: string; phone: string | null; is_live: boolean };

const DAYS_AHEAD = 14;

/** "Fri, 9 Oct" for a YYYY-MM-DD date. */
const dayText = (date: string) => formatDay(`${date}T00:00:00Z`, 'UTC');

/** "Ali", "Ali or Danial", "Ali, Danial or Hafiz". */
const orList = (names: string[]) =>
  names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} ${t('or')} ${names.at(-1)}`;

export default function ShopPage() {
  // `name` titles the header while the shop loads; "Book again" passes `service` and `barber`,
  // and "Change time" adds `move`, the booking to move.
  const params = useLocalSearchParams<{ slug: string; name?: string; service?: string; barber?: string; move?: string }>();
  const { slug } = params;
  const { session, profile, loading: authLoading } = useAuth();
  // Signed out, a move link is just the booking page. The user only counts with a move
  // link, so signing up to book on a normal page doesn't reload it.
  const moveUser = params.move ? session?.user.id : undefined;
  const waitForAuth = Boolean(params.move) && authLoading;
  const theme = useTheme();
  const now = useNow();

  const [shop, setShop] = useState<Shop | null>(null);
  const [hidden, setHidden] = useState<HiddenShop | null>(null);
  const [services, setServices] = useState<Service[]>([]);
  const [barbers, setBarbers] = useState<BarberWithHours[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);

  const [serviceId, setServiceId] = useState<string | null>(null);
  const [barberId, setBarberId] = useState<string | null>(null); // null = any barber
  const days = useMemo(() => upcomingDays(DAYS_AHEAD, shop?.time_zone), [shop?.time_zone]);
  const today = days[0]?.date ?? null;
  // Days the barber closed the whole shop, like Hari Raya.
  const [shutDays, setShutDays] = useState<Set<string>>(new Set());
  const shopId = shop?.id;
  useEffect(() => {
    if (!shopId || days.length === 0) return;
    supabase
      .rpc('shop_closed_days', { p_shop_id: shopId, p_from: days[0].date, p_to: days[days.length - 1].date })
      .then(({ data }) => setShutDays(new Set(((data ?? []) as { day: string }[]).map((d) => d.day))));
  }, [shopId, days, reload]);
  // Today's hours, leaving out barbers with the day off and a shop closed for the day.
  // Fetched again after midnight, so a page left open doesn't show yesterday's.
  const todayDate = localDateString(new Date(now), shop?.time_zone);
  const [hoursToday, setHoursToday] = useState<{ date: string; opens: string | null; closes: string | null } | null>(
    null,
  );
  useEffect(() => {
    if (!shopId) return;
    let active = true;
    supabase.rpc('shop_hours_today', { p_shop_id: shopId }).then(({ data }) => {
      const row = ((data ?? []) as { opens_today: string | null; closes_today: string | null }[])[0];
      if (active && row) setHoursToday({ date: todayDate, opens: row.opens_today, closes: row.closes_today });
    });
    return () => {
      active = false;
    };
  }, [shopId, todayDate, reload]);
  // Days nobody works (or the picked barber doesn't), so they can be shown as closed.
  const closedDays = useMemo(() => {
    const working = barbers.filter((b) => !barberId || b.id === barberId);
    const open = new Set(working.flatMap((b) => (b.working_hours ?? []).map((h) => h.weekday)));
    return new Set(
      days.filter((d) => shutDays.has(d.date) || !open.has(new Date(`${d.date}T00:00:00Z`).getUTCDay())).map((d) => d.date),
    );
  }, [barbers, barberId, days, shutDays]);
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
  // Moving a booking: the booking as it was, whether the link can't be used, and the booking once moved.
  const [moving, setMoving] = useState<Booking | null>(null);
  const [moveMissing, setMoveMissing] = useState(false);
  const [moved, setMoved] = useState<Booking | null>(null);
  // Set while a guest signs up to book; once they are back and signed in, the booking goes through.
  const pendingBook = useRef(false);

  const scrollRef = useRef<ScrollView>(null);
  const noteRef = useRef<TextInput>(null);
  // Where the steps below the services (or the booking being moved) start, and a step to scroll to once it is laid out.
  const stepY = useRef<Partial<Record<Step, number>>>({});
  const scrollAfterLayout = useRef<Step | null>(null);

  useEffect(() => {
    if (waitForAuth) return;
    // A guest who signed up from a move link to book is booking, not moving: leave the page as it is.
    if (pendingBook.current) return;
    (async () => {
      setLoading(true);
      setLoadError(null);
      setHidden(null);
      const { data: shopRow, error } = await supabase.from('shops').select('*').eq('slug', slug).maybeSingle();
      if (error) {
        setLoadError(errorMessage(error));
        setLoading(false);
        return;
      }
      if (!shopRow) {
        // Customers can't read a paused shop, but its link may still be on a poster
        // or in an Instagram bio, so find out whose it is to say more than "not found".
        const status = await supabase.rpc('shop_public_status', { p_slug: slug });
        const row = ((status.data ?? []) as HiddenShop[])[0];
        setLoadError(status.error ? errorMessage(status.error) : null);
        setHidden(row && !row.is_live ? row : null);
        setLoading(false);
        return;
      }
      const [svc, brb, mv] = await Promise.all([
        supabase.from('services').select('*').eq('shop_id', shopRow.id).eq('is_active', true).order('sort_order').order('name'),
        supabase
          .from('barbers')
          .select('*, working_hours(weekday, opens_at, closes_at)')
          .eq('shop_id', shopRow.id)
          .eq('is_active', true)
          .order('sort_order')
          .order('name'),
        moveUser ? supabase.from('bookings').select('*').eq('id', params.move!).maybeSingle() : null,
      ]);
      // Without these the page would wrongly say the shop isn't taking bookings.
      if (svc.error || brb.error || mv?.error) {
        setLoadError(errorMessage(svc.error ?? brb.error ?? mv?.error));
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
      // Change time: only the customer's own upcoming booking here, for a service the shop still offers.
      const move = (mv?.data ?? null) as Booking | null;
      const canMove = Boolean(
        move &&
          move.customer_id === moveUser &&
          move.shop_id === shopRow.id &&
          move.status === 'confirmed' &&
          Date.parse(move.starts_at) > Date.now() &&
          activeServices.some((s) => s.id === move.service_id),
      );
      setMoving(canMove ? move : null);
      setMoveMissing(Boolean(moveUser) && !canMove);
      if (canMove && move) {
        setServiceId(move.service_id);
        // Scroll to what is being changed, with the pickers right under it.
        scrollAfterLayout.current = 'move';
        // Open on the booking's own day and part of the day, so its time shows among the free ones.
        const bookedDay = localDateString(new Date(move.starts_at), shopRow.time_zone);
        if (upcomingDays(DAYS_AHEAD, shopRow.time_zone).some((d) => d.date === bookedDay)) setPickedDay(bookedDay);
        setPart(partOfDay(Number(localClock(move.starts_at, shopRow.time_zone).slice(0, 2))));
      }
      setLoading(false);
    })();
  }, [slug, reload, params.service, params.barber, params.move, moveUser, waitForAuth]);

  const movingId = moving?.id ?? null;
  const slotsKey = serviceId && day ? `${serviceId}|${day}|${barberId ?? 'any'}|${movingId}|${slotsVersion}` : null;
  const slotsLoading = slotsKey !== null && slotsKey !== slotsFor;

  useEffect(() => {
    if (!slotsKey || !serviceId || !day) return;
    let active = true;
    supabase
      // When moving, the booking's own time doesn't count as taken, so it can move to a time next to it.
      .rpc('available_slots', { p_service_id: serviceId, p_day: day, p_barber_id: barberId, p_ignore_booking: movingId })
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
  }, [slotsKey, serviceId, day, barberId, movingId, checkToday, pickKey]);

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
  // Moving: the booking's own time comes back free, since it is left out of the taken times.
  // Picking it with the same barber would change nothing, so it shows as the current time instead.
  const currentAt =
    moving &&
    (!barberId || barberId === moving.barber_id) &&
    slots.some((s) => s.barber_id === moving.barber_id && Date.parse(s.starts_at) === Date.parse(moving.starts_at))
      ? Date.parse(moving.starts_at)
      : null;
  const isCurrent = (time: string) => Date.parse(time) === currentAt;
  const freeCount = times.filter((time) => !isCurrent(time)).length;
  const timeGroups = useMemo(() => groupByPartOfDay(times, shop?.time_zone), [times, shop?.time_zone]);
  // One part of the day at a time keeps the grid short. The customer's choice
  // sticks across days while that part still has free times.
  const [shownPart, shownTimes] = timeGroups.find(([p]) => p === part) ?? timeGroups[0] ?? [null, []];
  const nextOpen = day ? days.find((d) => d.date > day && !closedDays.has(d.date)) : undefined;
  const week = useMemo(() => shopWeek(barbers.flatMap((b) => b.working_hours ?? [])), [barbers]);
  const todayWeekday = new Date(`${todayDate}T00:00:00Z`).getUTCDay();
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
      // The summary names the shop (and barber), for someone who has looked at a few.
      pendingBook.current = true;
      const barberName = barbers.find((b) => b.id === barberId)?.name;
      const what = barberName
        ? t('{service} with {barber} at {shop}', { service: service.name, barber: barberName, shop: shop?.name ?? '' })
        : t('{service} at {shop}', { service: service.name, shop: shop?.name ?? '' });
      router.push({
        pathname: '/sign-up',
        params: {
          next: `/shop/${slug}`,
          role: 'customer',
          summary: `${what} · ${noBreak(formatDay(startsAt, shop?.time_zone))}, ${noBreak(formatTime(startsAt, shop?.time_zone))}`,
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
    if (error) return failed(error);
    setConfirmed(data as Booking);
  }

  async function move() {
    if (!moving || !startsAt) return;
    setBooking(true);
    setBookError(null);
    const { data, error } = await supabase.rpc('reschedule_booking', {
      p_booking_id: moving.id,
      p_starts_at: startsAt,
      p_barber_id: barberId,
    });
    setBooking(false);
    if (error) return failed(error);
    setMoved(data as Booking);
  }

  // The time was most likely just taken, so drop it and fetch the free times again.
  function failed(error: unknown) {
    setBookError(errorMessage(error));
    setStartsAt(null);
    setSlotsVersion((v) => v + 1);
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
  if (hidden) {
    const phone = hidden.phone;
    return (
      <Screen edges={[]}>
        <Stack.Screen options={{ title: hidden.name }} />
        <Empty
          title={t('{shop} isn’t taking online bookings right now', { shop: hidden.name })}
          body={
            phone
              ? t('Message them on WhatsApp to book, or find another barber.')
              : t('Check back later, or find another barber.')
          }>
          {phone ? (
            <Button
              title={t('WhatsApp {name}', { name: hidden.name })}
              onPress={() => Linking.openURL(whatsappUrl(phone))}
            />
          ) : null}
          <Button
            title={t('Find another barber')}
            variant={phone ? 'secondary' : 'primary'}
            onPress={() => router.replace('/customer')}
          />
        </Empty>
      </Screen>
    );
  }
  if (!shop) {
    return (
      <Screen edges={[]}>
        <Stack.Screen options={{ title: t('Shop not found') }} />
        <Empty title={t('Shop not found')} body={t('This booking link may be wrong. Check it with the shop.')}>
          <Button title={t('Find another barber')} onPress={() => router.replace('/customer')} />
        </Empty>
      </Screen>
    );
  }

  const tz = shop.time_zone;
  const openNow =
    hoursToday?.date === todayDate && week.some(Boolean) ? openStatus(hoursToday.opens, hoursToday.closes, now, tz) : null;
  const when = (at: string) => ({ day: formatDay(at, tz), time: formatTime(at, tz) });
  /** The same, kept whole on screen: a heading never breaks between "4:00" and "pm". */
  const whenShown = (at: string) => ({ day: noBreak(formatDay(at, tz)), time: noBreak(formatTime(at, tz)) });
  const dayAndTime = (at: string) => `${formatDay(at, tz)}, ${formatTime(at, tz)}`;
  /** "Haircut with Ali", or just "Haircut" if that barber is away now. */
  const withBarber = (b: Booking) => {
    const who = barbers.find((x) => x.id === b.barber_id)?.name;
    return who ? t('{service} with {barber}', { service: b.service_name, barber: who }) : b.service_name;
  };

  if (moving && moved) {
    const what = withBarber(moved);
    // A move to another barber can keep the same time, so then the barbers say what changed.
    const oldBarber = barbers.find((x) => x.id === moving.barber_id)?.name;
    const newBarber = barbers.find((x) => x.id === moved.barber_id)?.name;
    const barberChanged = moved.barber_id !== moving.barber_id && oldBarber && newBarber;
    const change = {
      service: moved.service_name,
      old: dayAndTime(moving.starts_at),
      new: dayAndTime(moved.starts_at),
    };
    // Tells the barber which booking moved, so they can find it in their day.
    const message = !profile?.full_name
      ? undefined
      : barberChanged
        ? t('Hi {shop}, this is {name}. I moved my {service} with {oldBarber} on {old} to {newBarber} on {new}.', {
            shop: shop.name,
            name: profile.full_name,
            oldBarber,
            newBarber,
            ...change,
          })
        : t('Hi {shop}, this is {name}. I moved my {service} from {old} to {new}.', {
            shop: shop.name,
            name: profile.full_name,
            ...change,
          });
    return (
      <Screen key="moved" edges={[]}>
        {header}
        <Empty
          title={t('Booking moved')}
          body={t('{service} on {day} at {time}.', { service: what, ...whenShown(moved.starts_at) })}>
          <T variant="muted" style={{ textAlign: 'center' }}>
            {barberChanged
              ? t('Was {service} on {day} at {time}.', { service: withBarber(moving), ...whenShown(moving.starts_at) })
              : t('Was {day} at {time}.', whenShown(moving.starts_at))}
          </T>
          {/* An entry at the old time would remind them at the wrong time. Adding again
              doesn't move it in Google Calendar, so the old one has to be deleted there. */}
          <Button
            title={t('Add to calendar')}
            variant="secondary"
            style={{ marginTop: Spacing.sm }}
            onPress={() =>
              addToCalendar(
                bookingEvent({ booking: moved, shop, barber: newBarber, link: bookingLink(shop.slug), app: APP_NAME }),
              )
            }
          />
          <T variant="small" style={{ textAlign: 'center' }}>
            {t('Added it to your calendar before? Delete the old one there.')}
          </T>
        </Empty>
        <Card>
          <T variant="label">{shop.name}</T>
          {shop.address ? <T variant="muted">{shop.address}</T> : null}
          {shop.phone ? (
            <Button
              title={t('WhatsApp the shop')}
              variant="secondary"
              onPress={() => Linking.openURL(whatsappUrl(shop.phone!, message))}
            />
          ) : null}
        </Card>
        {/* Back to the bookings screen this came from, rather than a second copy on top of it. */}
        <Button title={t('See my bookings')} onPress={() => router.dismissTo('/customer/bookings')} />
      </Screen>
    );
  }

  if (confirmed) {
    const what = withBarber(confirmed);
    const booked = when(confirmed.starts_at);
    // Tells the barber which booking the chat is about, so they don't have to ask.
    const message = profile?.full_name
      ? t('Hi {shop}, this is {name}. I booked {service} on {day} at {time}.', {
          shop: shop.name,
          name: profile.full_name,
          service: what,
          ...booked,
        })
      : undefined;
    const calendarEvent = () =>
      bookingEvent({
        booking: confirmed,
        shop,
        barber: barbers.find((x) => x.id === confirmed.barber_id)?.name,
        link: bookingLink(shop.slug),
        app: APP_NAME,
      });
    return (
      // A new key starts the booked page at the top instead of where the picker was scrolled.
      <Screen key="booked" edges={[]}>
        {header}
        <Empty
          title={t('You’re booked!')}
          body={t('{service} on {day} at {time}.', { service: what, ...whenShown(confirmed.starts_at) })}>
          <T variant="label">
            {formatPrice(confirmed.price)} · {t('Pay at the shop.')}
          </T>
          {confirmed.customer_note ? (
            <T variant="muted" style={{ textAlign: 'center' }}>
              “{confirmed.customer_note}”
            </T>
          ) : null}
          {/* Right under the time it saves, so the phone reminds them and they don't miss it. */}
          <Button
            title={t('Add to calendar')}
            variant="secondary"
            style={{ marginTop: Spacing.sm }}
            onPress={() => addToCalendar(calendarEvent())}
          />
        </Empty>
        <Card>
          <T variant="label">{shop.name}</T>
          {shop.address ? <T variant="muted">{shop.address}</T> : null}
          <Button title={t('Directions')} variant="secondary" onPress={() => Linking.openURL(directionsUrl(shop))} />
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

  if (moveMissing) {
    return (
      <Screen edges={[]}>
        {header}
        <Empty
          title={t('This booking can’t be changed')}
          body={t('It may have been cancelled or already started, or the shop no longer offers this service.')}>
          <Button title={t('See my bookings')} onPress={() => router.dismissTo('/customer/bookings')} />
        </Empty>
      </Screen>
    );
  }

  // The note sits under the times, out of sight behind this bar; a tap here goes to it.
  // Focus first: on the web, focusing stops a smooth scroll that has already started.
  const openNote = () => {
    noteRef.current?.focus();
    scrollToStep('note');
  };

  // Stays at the bottom so Confirm is never buried under the time chips.
  const footer =
    service && startsAt ? (
      <>
        <T variant="label" numberOfLines={2}>
          {dayAndTime(startsAt)} · {serviceWith(service.name)} · {formatPrice(moving ? moving.price : service.price)}
        </T>
        {moving ? (
          <Button title={t('Move to this time')} onPress={move} loading={booking} />
        ) : (
          <Row style={{ flexWrap: 'nowrap' }}>
            <Button
              title={note.trim() ? t('Edit note') : t('+ Add note')}
              variant="secondary"
              accessibilityLabel={note.trim() ? t('Edit note') : t('Add note')}
              onPress={openNote}
              style={{ paddingHorizontal: Spacing.md }}
            />
            <Button
              title={session ? t('Confirm booking') : t('Continue to book')}
              onPress={book}
              loading={booking}
              style={{ flex: 1 }}
            />
          </Row>
        )}
      </>
    ) : bookError ? (
      <ErrorText message={bookError} />
    ) : null;
  // A move skips the service step, so the steps after it come up one.
  const timeTitle = moving
    ? barbers.length > 1 ? t('2. Pick a new time') : t('1. Pick a new time')
    : barbers.length > 1 ? t('3. Pick a time') : t('2. Pick a time');

  return (
    <Screen edges={[]} scrollRef={scrollRef} footer={footer}>
      {header}
      <View style={{ gap: Spacing.xs }}>
        <T variant="title">{shop.name}</T>
        <T variant="muted">{shop.address || shop.area}</T>
        {openNow ? (
          <T variant="label" style={{ color: openNow.state === 'open' ? theme.success : theme.textSecondary }}>
            {openNow.label}
          </T>
        ) : null}
        {shop.about ? <T>{shop.about}</T> : null}
        <Row>
          {/* Where it is, before booking: often what decides between two barbers. */}
          <Button title={t('Directions')} variant="secondary" onPress={() => Linking.openURL(directionsUrl(shop))} />
          {shop.phone ? (
            <Button
              title={t('WhatsApp the shop')}
              variant="secondary"
              onPress={() => Linking.openURL(whatsappUrl(shop.phone!))}
            />
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
          {moving ? (
            // A move keeps the service, so it is a summary here rather than a choice.
            <View onLayout={(e) => onStepLayout('move', e)}>
              <Card>
                <T variant="heading">{t('Changing your booking')}</T>
                <T>
                  {withBarber(moving)} · {dayAndTime(moving.starts_at)}
                </T>
                <T variant="small">{t('Your booking stays as it is until you move it.')}</T>
              </Card>
            </View>
          ) : (
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
          )}

          {serviceId ? (
            <>
              {barbers.length > 1 ? (
                <View onLayout={(e) => onStepLayout('barber', e)}>
                  <Section title={moving ? t('1. Pick a barber') : t('2. Pick a barber')}>
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
                <Section title={timeTitle}>
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
                  ) : freeCount === 0 ? (
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
                            sublabel={t('{count} free', { count: list.filter((time) => !isCurrent(time)).length })}
                            selected={p === shownPart}
                            onPress={() => setPart(p)}
                          />
                        ))}
                      </Row>
                      <Row role="radiogroup" accessibilityLabel={t('Free times')}>
                        {shownTimes.map((time) => {
                          // The booking's own time stays in view, so the customer sees where it sits.
                          const current = isCurrent(time);
                          return (
                            // The tab above says am or pm, so the chip shows only the clock and three or
                            // more fit a row in Malay too; screen readers still hear the whole time.
                            <Chip
                              key={time}
                              label={formatClockOnly(time, tz)}
                              sublabel={current ? t('Your time') : undefined}
                              accessibilityLabel={
                                current
                                  ? t('{time}, your current time', { time: formatTime(time, tz) })
                                  : formatTime(time, tz)
                              }
                              selected={startsAt === time}
                              disabled={current}
                              current={current}
                              onPress={() => pickTime(time)}
                            />
                          );
                        })}
                      </Row>
                    </>
                  )}
                </Section>
              </View>
            </>
          ) : null}

          {/* The bar below already says the day, time, service and price. */}
          {service && startsAt && !moving ? (
            <View onLayout={(e) => onStepLayout('note', e)}>
              <Card>
                <Field
                  ref={noteRef}
                  label={t('Note for your barber (optional)')}
                  value={note}
                  onChangeText={setNote}
                  placeholder={t('e.g. low fade, keep the top long')}
                  maxLength={280}
                />
                <T variant="small">{t('Pay at the shop.')}</T>
              </Card>
            </View>
          ) : null}
        </>
      )}

      {week.some(Boolean) ? (
        <Card>
          <T variant="label">{t('Opening hours')}</T>
          {WEEK_ORDER.map((weekday) => {
            const d = week[weekday];
            const isToday = weekday === todayWeekday;
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
