import Ionicons from '@expo/vector-icons/Ionicons';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Animated, Linking, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { BookingStatusBadge } from '@/components/booking-status';
import { bookingLabel, ChairNames, Chairs, ChairsPanel, ChairsSkeleton, type ChairsFrame } from '@/components/chairs';
import { DayPicker } from '@/components/day-picker';
import {
  Badge,
  Bone,
  Button,
  Card,
  Chip,
  Empty,
  ErrorText,
  IconButton,
  Row,
  Screen,
  ScreenTitle,
  Section,
  Skeleton,
  StaleNote,
  T,
} from '@/components/ui';
import { MaxContentWidth, Radius, Spacing } from '@/constants/theme';
import { useNow } from '@/hooks/use-now';
import { useTheme } from '@/hooks/use-theme';
import { appCache } from '@/lib/app-cache';
import { useAuth } from '@/lib/auth';
import { cacheKey } from '@/lib/cache';
import { chairsDay, isWholeDay } from '@/lib/chairs';
import { dateRange } from '@/lib/closures';
import { confirmAction } from '@/lib/confirm';
import { WALK_IN } from '@/lib/customers';
import { t } from '@/lib/lang';
import { useMyShop } from '@/lib/my-shop';
import { ago, changeLine, changeTag, moreText, seenMark, type ShopChange, type ShopChanges } from '@/lib/news';
import { whatsappUrl } from '@/lib/phone';
import { canRemind, needsReminder, reminderMessage } from '@/lib/reminders';
import { useShopNews } from '@/lib/shop-news';
import { errorMessage, supabase } from '@/lib/supabase';
import {
  addDays,
  dayBounds,
  formatDay,
  formatDuration,
  formatPrice,
  formatTime,
  formatTimeParts,
  localDateString,
  noBreak,
  upcomingDays,
} from '@/lib/time';
import type { Barber, Booking, BookingStatus, WorkingHours } from '@/lib/types';

type ShopBooking = Booking & {
  barbers: { name: string } | null;
  customer: { full_name: string; phone: string | null } | null;
};

/** Just enough of tomorrow's bookings to count who still needs a reminder. */
type ToRemind = Pick<
  Booking,
  'id' | 'barber_id' | 'status' | 'is_block' | 'starts_at' | 'reminded_at' | 'guest_phone' | 'created_at'
> & {
  customer: { phone: string | null } | null;
};

/** A reminder WhatsApp opened for but the shop's record missed, with the time the message named. */
type Unsaved = { startsAt: string; reason: string };

type BarberWithHours = Barber & { working_hours: WorkingHours[] };

type ClosedDay = { day: string; reason: string | null; is_closure: boolean };

/** Everything a day's screen asks for, as kept for next time; null for a part whose request failed. */
type DayAnswer = {
  bookings: ShopBooking[];
  services: number;
  barbers: BarberWithHours[] | null;
  closed: ClosedDay[] | null;
  tomorrow: ToRemind[] | null;
};

/**
 * Buttons that change a customer's booking, while the day on screen is last
 * visit's: dimmed until the server's list arrives (the title's spinner says it
 * is on its way), so nothing is done to a booking that has since moved or been
 * cancelled.
 */
type Held = { disabled: boolean } | null;

/**
 * The bar at the bottom: what just happened and one thing to do about it (undo, or message the
 * customer). A closable one stays until the barber acts on it or closes it.
 */
type Notice = { message: string; actionLabel: string; onAction: () => void; closable?: boolean };

/** How long the bar stays up: long enough to notice a slip with wet hands. */
const NOTICE_MS = 8000;
/** Whose bookings this phone shows, so each barber's phone opens on their own queue. */
const filterKey = (shopId: string) => `potongku.barberFilter.${shopId}`;
/** Set once the owner has looked at the hours every new barber starts with. */

/** The day as a list in time order, or as chairs side by side. */
type DayView = 'list' | 'chairs';
/** Which this phone shows, kept for next time. */
const dayViewKey = (shopId: string) => `potongku.dayView.${shopId}`;
/** The same, for this visit, so coming back to the tab doesn't flash the list first. */
const dayViews: Record<string, DayView> = {};
/**
 * Shops whose day as chairs has had its one chance this visit to open on now
 * (see openAtNow). A tap on the switch or a day uses it up: the screen never
 * moves away from what was just tapped.
 */
const nowPlaced = new Set<string>();

export default function BarberBookings() {
  const { shop } = useMyShop();
  const uid = useAuth().session?.user.id;
  const theme = useTheme();
  const now = useNow();
  const tz = shop!.time_zone;
  // From the Barbers tab: one barber's bookings on a day ("See bookings" for a barber marked away).
  const params = useLocalSearchParams<{ day?: string; barber?: string; at?: string }>();
  // Yesterday is included so last-minute no-shows can still be marked.
  const days = useMemo(() => upcomingDays(15, tz, new Date(), -1), [tz]);
  const [day, setDay] = useState(params.day ?? days[1].date);
  const [bookings, setBookings] = useState<ShopBooking[]>([]);
  // The day `bookings` belong to. Until the day on screen has loaded, its list isn't shown,
  // so the day before's cards never sit under the new date.
  const [loadedDay, setLoadedDay] = useState<string | null>(null);
  const [tomorrow, setTomorrow] = useState<ToRemind[]>([]);
  const [barbers, setBarbers] = useState<BarberWithHours[]>([]);
  const [services, setServices] = useState<number | null>(null);
  // Why an action failed.
  const [error, setError] = useState<string | null>(null);
  // Why the last refresh failed; the day on screen stays.
  const [refreshError, setRefreshError] = useState<string | null>(null);
  // When the server gave the day on screen, and the day it last answered for on this visit.
  const [savedAt, setSavedAt] = useState(0);
  const [freshFor, setFreshFor] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);
  const [barberId, setBarberId] = useState<string | null>(params.barber ?? null);
  // Each "See bookings" tap carries a new `at`, so tapping it again goes back to that barber's day.
  const [seenAt, setSeenAt] = useState(params.at);
  if (params.at !== seenAt) {
    setSeenAt(params.at);
    if (params.day) setDay(params.day);
    if (params.barber) setBarberId(params.barber);
    setError(null);
    setRefreshError(null);
  }
  const [showFinished, setShowFinished] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [noticeHeight, setNoticeHeight] = useState(0);
  // The floating add button only shows once the one under the date has scrolled away.
  const [addButtonBottom, setAddButtonBottom] = useState(0);
  // A boolean, so scrolling only re-renders the day when it crosses that line.
  const [pastAddButton, setPastAddButton] = useState(false);
  // By booking. Reloads keep them, so the row still says so when the barber is back from WhatsApp.
  const [unsaved, setUnsaved] = useState<Record<string, Unsaved>>({});
  // Bookings cancelled from this screen, whose WhatsApp says sorry rather than just hello.
  const [cancelledHere, setCancelledHere] = useState<Set<string>>(() => new Set());
  // Days on the strip the shop is closed (Hari Raya, say), with the reason the owner gave,
  // and days every barber has off.
  const [closures, setClosures] = useState<Record<string, string | null>>({});
  const [allOff, setAllOff] = useState<Set<string>>(() => new Set());
  const noticeTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const latest = useRef(0);
  const shopId = shop?.id;
  // What customers changed since this phone last looked; the tab's badge counts the same.
  const { news, seen, refresh: refreshNews, markSeen } = useShopNews();
  const scroller = useRef<ScrollView>(null);
  const scrollY = useRef(0);
  const insets = useSafeAreaInsets();
  // A booking opened from that card, brought into view once its day is on screen.
  const [focus, setFocus] = useState<{ id: string; day: string } | null>(null);
  const focusPending = useRef(false);
  const focusRef = useRef<View>(null);
  const dayHeaderRef = useRef<View>(null);
  const [dayView, setDayView] = useState<DayView>(() => (shopId && dayViews[shopId]) || 'list');
  // The booking whose actions are open over the chairs, on its day.
  const [picked, setPicked] = useState<{ id: string; day: string } | null>(null);
  const [chairsX] = useState(() => new Animated.Value(0));
  const [chairsFrame, setChairsFrame] = useState<ChairsFrame | null>(null);
  // Scrolled past the chairs' row of names, so a copy stays at the top.
  const [namesStuck, setNamesStuck] = useState(false);
  const [panelHeight, setPanelHeight] = useState(0);

  useEffect(() => {
    if (!shopId) return;
    AsyncStorage.getItem(filterKey(shopId))
      // A barber picked on the Barbers tab meanwhile comes first.
      .then((saved) => setBarberId((current) => current ?? (saved || null)))
      .catch(() => {});
    AsyncStorage.getItem(dayViewKey(shopId))
      .then((saved) => {
        // Unless the switch was tapped meanwhile.
        if ((saved === 'list' || saved === 'chairs') && !dayViews[shopId]) {
          dayViews[shopId] = saved;
          setDayView(saved);
        }
      })
      .catch(() => {});
  }, [shopId]);

  const onChairsFrame = useCallback((frame: ChairsFrame) => {
    setChairsFrame(frame);
    setNamesStuck(scrollY.current > frame.top);
  }, []);

  useEffect(() => () => clearTimeout(noticeTimer.current), []);

  const showDay = useCallback((a: DayAnswer, forDay: string) => {
    setBookings(a.bookings);
    setLoadedDay(forDay);
    setServices(a.services);
    if (a.barbers) setBarbers(a.barbers);
    if (a.closed) {
      setClosures(Object.fromEntries(a.closed.filter((d) => d.is_closure).map((d) => [d.day, d.reason])));
      setAllOff(new Set(a.closed.filter((d) => !d.is_closure).map((d) => d.day)));
    }
    if (a.tomorrow) setTomorrow(a.tomorrow);
  }, []);

  // A day kept from before (last visit, or earlier on this one) shows at once while it is asked for again.
  const dayKey = uid && shopId ? cacheKey(uid, 'day', shopId, day) : null;
  const [peeked, setPeeked] = useState<string | null>(null);
  if (dayKey && peeked !== dayKey) {
    setPeeked(dayKey);
    const kept = appCache.peek<DayAnswer>(dayKey);
    if (kept && loadedDay !== day) {
      showDay(kept.data, day);
      setSavedAt(kept.at);
    }
  }

  const load = useCallback(async () => {
    if (!shop) return;
    // Only the newest load fills the screen, so a slow answer for the day before can't replace it.
    const request = ++latest.current;
    setAsking(true);
    const { start, end } = dayBounds(day, tz);
    const today = localDateString(new Date(), tz);
    // On today, tomorrow's bookings nobody has reminded yet, for the card at the top.
    const next = day === today ? dayBounds(addDays(today, 1), tz) : null;
    const first = days[0].date;
    const last = days[days.length - 1].date;
    const [list, active, team, closed, unreminded] = await Promise.all([
      supabase
        .from('bookings')
        .select('*, barbers(name), customer:profiles!bookings_customer_id_fkey(full_name, phone)')
        .eq('shop_id', shop.id)
        .gte('starts_at', start.toISOString())
        .lt('starts_at', end.toISOString())
        .order('starts_at'),
      supabase.from('services').select('id', { count: 'exact', head: true }).eq('shop_id', shop.id).eq('is_active', true),
      supabase.from('barbers').select('*, working_hours(*)').eq('shop_id', shop.id).order('sort_order').order('created_at'),
      // The whole strip, so closed days say so before they are picked.
      supabase.rpc('shop_closed_days', {
        p_shop_id: shop.id,
        p_from: day < first ? day : first,
        p_to: day > last ? day : last,
      }),
      next
        ? supabase
            .from('bookings')
            .select(
              'id, barber_id, status, is_block, starts_at, reminded_at, guest_phone, created_at, customer:profiles!bookings_customer_id_fkey(phone)',
            )
            .eq('shop_id', shop.id)
            .eq('status', 'confirmed')
            .eq('is_block', false)
            .is('reminded_at', null)
            .gte('starts_at', next.start.toISOString())
            .lt('starts_at', next.end.toISOString())
        : null,
    ]);
    if (request !== latest.current) return;
    setAsking(false);
    if (list.error) {
      setRefreshError(errorMessage(list.error));
      return;
    }
    const answer: DayAnswer = {
      bookings: (list.data ?? []) as ShopBooking[],
      services: active.count ?? 0,
      barbers: team.error ? null : ((team.data ?? []) as BarberWithHours[]),
      closed: closed.error ? null : ((closed.data ?? []) as ClosedDay[]),
      // The client can't tell that the customer is one profile rather than a list.
      tomorrow: !unreminded ? [] : unreminded.error ? null : ((unreminded.data ?? []) as unknown as ToRemind[]),
    };
    setRefreshError(null);
    setError(null);
    showDay(answer, day);
    setSavedAt(Date.now());
    setFreshFor(day);
    if (uid) appCache.write(cacheKey(uid, 'day', shop.id, day), answer);
    return answer.bookings;
  }, [shop, day, tz, days, uid, showDay]);

  // Reloads after a status change use the day on screen by then, not the day the button was tapped on.
  const loadRef = useRef(load);
  useEffect(() => {
    loadRef.current = load;
  }, [load]);

  useEffect(() => {
    if (!focus || !focusPending.current || focus.day !== day || loadedDay !== day) return;
    focusPending.current = false;
    // The card itself, or the day's heading when the card is folded away or no longer there.
    (focusRef.current ?? dayHeaderRef.current)?.measureInWindow((_x, y) =>
      scroller.current?.scrollTo({ y: Math.max(0, scrollY.current + y - insets.top - Spacing.lg), animated: true }),
    );
  }, [focus, day, loadedDay, insets.top]);

  useFocusEffect(
    useCallback(() => {
      load();
      // New online bookings show up while the screen stays open at the counter.
      const timer = setInterval(load, 60_000);
      return () => clearInterval(timer);
    }, [load]),
  );

  if (!shop) return null;

  /** With stay, it waits to be dismissed, for news the barber only sees on coming back from WhatsApp. */
  const showNotice = (next: Notice | null, stay = false) => {
    clearTimeout(noticeTimer.current);
    setNotice(next);
    if (next && !stay) noticeTimer.current = setTimeout(() => setNotice(null), NOTICE_MS);
  };

  /** Sets one status on several bookings and returns the ones that changed. */
  const setStatuses = async (list: ShopBooking[], status: BookingStatus) => {
    const results = await Promise.all(
      list.map((b) => supabase.rpc('set_booking_status', { p_booking_id: b.id, p_status: status })),
    );
    const changed = list.filter((_, i) => !results[i].error);
    // Move the cards right away; the reload below catches anything else that changed.
    const ids = new Set(changed.map((b) => b.id));
    setBookings((all) => all.map((b) => (ids.has(b.id) ? { ...b, status } : b)));
    const failed = results.find((r) => r.error)?.error;
    // A good reload clears the error line, so show the error after it.
    loadRef.current().then(() => {
      if (failed) setError(errorMessage(failed));
    });
    return changed;
  };

  const mark = async (list: ShopBooking[], status: 'completed' | 'no_show') => {
    const marked = await setStatuses(list, status);
    if (marked.length === 0) return;
    const name = whoFor(marked[0]);
    showNotice({
      message:
        marked.length > 1
          ? t('Marked {count} as done', { count: marked.length })
          : status === 'completed'
            ? t('Marked {name} as done', { name })
            : t('Marked {name} as no-show', { name }),
      actionLabel: t('Undo'),
      onAction: () => restore(marked),
    });
  };

  /** Takes back Done or No-show; the server lets the shop do this at any time. */
  const restore = (list: ShopBooking[]) => setStatuses(list, 'confirmed');

  const messageVars = (b: ShopBooking) => ({
    who: whoFor(b),
    shop: shop.name,
    service: b.service_name,
    day: formatDay(b.starts_at, tz),
    time: formatTime(b.starts_at, tz),
  });

  const whatsapp = (b: ShopBooking) => {
    const phone = phoneOf(b);
    if (!phone) return;
    openWhatsApp(
      phone,
      // Until the server answers for the day, the booking may have moved since last visit, so no time is named.
      freshFor === day
        ? t('Hi {who}, this is {shop} about your {service} on {day} at {time}.', messageVars(b))
        : t('Hi {who}, this is {shop}.', messageVars(b)),
    );
  };

  /** The shop had to cancel: sorry, and an offer of another time. */
  const sorry = (b: ShopBooking) => {
    const phone = phoneOf(b);
    if (!phone) return;
    openWhatsApp(
      phone,
      t(
        'Hi {who}, sorry, {shop} has to cancel your {service} on {day} at {time}. Reply here and we will find you another time.',
        messageVars(b),
      ),
    );
  };

  /**
   * Records a reminder for the time the message named, so the other phones in
   * the shop see it. If that fails, the row says so and can save it again
   * without a second message. A booking that has left the list meanwhile
   * (cancelled, or moved to another day) has no row to say it, so the bar does.
   */
  const saveReminder = async (b: ShopBooking, startsAt: string) => {
    const { data, error: failed } = await supabase.rpc('mark_booking_reminded', {
      p_booking_id: b.id,
      p_starts_at: startsAt,
    });
    if (failed) {
      const reason = errorMessage(failed);
      setUnsaved((all) => ({ ...all, [b.id]: { startsAt, reason } }));
      loadRef.current().then((fresh) => {
        const row = fresh?.find((x) => x.id === b.id);
        if (fresh && !(row && awaitsReminder(row, Date.now()))) {
          showNotice(
            {
              message: t('Reminder for {name} not saved. {reason}', { name: whoFor(b), reason }),
              actionLabel: t('OK'),
              onAction: () => {},
            },
            true,
          );
        }
      });
      return;
    }
    setUnsaved((all) => Object.fromEntries(Object.entries(all).filter(([id]) => id !== b.id)));
    const at = (data as Booking).reminded_at;
    setBookings((all) => all.map((x) => (x.id === b.id ? { ...x, reminded_at: at } : x)));
  };

  /** Opens WhatsApp first, while the tap still counts (browsers block a new tab after a round trip). */
  const remind = async (b: ShopBooking) => {
    const phone = phoneOf(b);
    if (!phone) return;
    openWhatsApp(phone, reminderMessage(messageVars(b), b.starts_at, now, tz));
    await saveReminder(b, b.starts_at);
  };

  /** For a message that never went out, so the booking counts as still to remind. */
  const unremind = async (b: ShopBooking) => {
    const { error: failed } = await supabase.rpc('mark_booking_reminded', {
      p_booking_id: b.id,
      p_starts_at: b.starts_at,
      p_reminded: false,
    });
    if (failed) {
      loadRef.current().then(() => setError(errorMessage(failed)));
      return;
    }
    setBookings((all) => all.map((x) => (x.id === b.id ? { ...x, reminded_at: null } : x)));
  };

  const cancel = async (b: ShopBooking) => {
    const phone = phoneOf(b);
    const when = { who: whoFor(b), service: b.service_name, time: formatTime(b.starts_at, tz) };
    const ok = b.is_block
      ? await confirmAction(t('Remove this block?'), t('Customers will be able to book this time again.'), t('Remove'))
      : await confirmAction(
          t('Cancel this booking?'),
          phone ? t('{who} · {service} at {time}. Let them know on WhatsApp.', when) : t('{who} · {service} at {time}.', when),
          phone ? t('Cancel and WhatsApp') : t('Cancel booking'),
        );
    if (!ok) return;
    const [cancelled] = await setStatuses([b], 'cancelled');
    if (!cancelled || !phone) return;
    // The Cancelled row's WhatsApp says sorry too, for when the bar has gone.
    setCancelledHere((all) => new Set(all).add(b.id));
    // Browsers block a new tab that isn't opened by a tap, and the cancel took a round trip,
    // so on the web the barber taps once more in the bar, which waits for it.
    if (Platform.OS === 'web') {
      showNotice(
        {
          message: t('Booking cancelled. Let {name} know.', { name: whoFor(b) }),
          actionLabel: t('Send WhatsApp'),
          onAction: () => sorry(b),
          closable: true,
        },
        true,
      );
    } else {
      sorry(b);
    }
  };

  /** Shop closed this day by mistake, or plans changed: open it again for bookings. */
  const reopen = async () => {
    const range = dateRange(day, day);
    const ok = await confirmAction(
      t('Reopen {days}?', { days: range }),
      t('Customers will be able to book again.'),
      t('Reopen'),
    );
    if (!ok) return;
    const { error: failed } = await supabase.rpc('reopen_shop_days', { p_from: day, p_days: 1 });
    if (failed) return setError(errorMessage(failed));
    await load();
  };

  /** Another day: any message on screen was about the day before. */
  const pickDay = (next: string) => {
    if (next === day) return;
    nowPlaced.add(shop.id);
    setDay(next);
    setError(null);
    setRefreshError(null);
    setPicked((p) => (p?.day === next ? p : null));
  };

  const pickView = (next: DayView) => {
    nowPlaced.add(shop.id);
    dayViews[shop.id] = next;
    setDayView(next);
    setPicked(null);
    AsyncStorage.setItem(dayViewKey(shop.id), next).catch(() => {});
  };

  const pickBarber = (id: string | null) => {
    setBarberId(id);
    AsyncStorage.setItem(filterKey(shop.id), id ?? '').catch(() => {});
  };

  // Setup -------------------------------------------------------------------
  const activeBarbers = barbers.filter((b) => b.is_active);
  const hasHours = activeBarbers.some((b) => b.working_hours.length > 0);
  const ready = services !== null && services > 0 && activeBarbers.length > 0 && hasHours && shop.is_published;
  const notTaking =
    shop.published_at == null
      ? {
          title: t('Not taking bookings yet'),
          body: t('Customers can book once your shop is live. The steps are on My shop.'),
        }
      : { title: t('Customers can’t book right now'), body: t('My shop says what to do.') };

  // The day's list ---------------------------------------------------------
  const loaded = loadedDay === day;
  // Last visit's list for this day, until the server answers for it.
  const fromCache = loaded && freshFor !== day;
  const held: Held = fromCache ? { disabled: true } : null;
  // A removed block is gone from the barber's point of view.
  const kept = loaded ? bookings.filter((b) => !(b.is_block && b.status === 'cancelled')) : [];
  // A barber marked away keeps a chip on days they still have customers booked.
  const awayIds = new Set(barbers.filter((b) => !b.is_active).map((b) => b.id));
  const chipBarbers = barbers.filter(
    (b) => b.is_active || kept.some((x) => x.barber_id === b.id && !x.is_block && x.status === 'confirmed'),
  );
  // A saved choice for a barber who has left, or is away with nobody booked, shows everyone.
  const filterId = chipBarbers.length > 1 && chipBarbers.some((b) => b.id === barberId) ? barberId : null;
  const shown = filterId ? kept.filter((b) => b.barber_id === filterId) : kept;
  const showBarber = barbers.length > 1 && !filterId;
  const isToday = day === localDateString(new Date(now), tz);
  const todayStart = dayBounds(localDateString(new Date(now), tz), tz).start.getTime();
  const closure = loaded && day in closures ? { reason: closures[day] } : null;
  const toRemind = isToday
    ? tomorrow.filter((b) => (!filterId || b.barber_id === filterId) && needsReminder(b, phoneOf(b), now, tz)).length
    : 0;
  const started = (b: Booking) => new Date(b.starts_at).getTime() <= now;
  const ended = (b: Booking) => new Date(b.ends_at).getTime() <= now;
  // Blocks are never marked, so they count as finished once their time is over.
  const isFinished = (b: ShopBooking) => b.status !== 'confirmed' || (b.is_block && ended(b));
  const chairs = dayView === 'chairs';
  // The list's sections; Chairs lays out the same bookings its own way.
  const listed = chairs ? [] : shown;
  const finished = listed.filter(isFinished);
  const open = listed.filter((b) => !finished.includes(b));
  const needsMarking = open.filter(ended);
  const inChair = open.filter((b) => started(b) && !ended(b));
  const upcoming = open.filter((b) => !started(b));
  const onlyFinished = finished.length === listed.length;
  const finishedOpen = showFinished || onlyFinished;
  const finishedTitle = finished.every((b) => b.status === 'cancelled')
    ? t('Cancelled ({count})', { count: finished.length })
    : t('Finished ({count})', { count: finished.length });

  // No-shows and cancellations bring in nothing, so they stay out of the money.
  const counted = shown.filter((b) => !b.is_block && (b.status === 'confirmed' || b.status === 'completed'));
  const completed = counted.filter((b) => b.status === 'completed');
  const total = (list: ShopBooking[]) => formatPrice(list.reduce((sum, b) => sum + Number(b.price), 0));
  const summary = [
    counted.length === 1 ? t('1 booking') : t('{count} bookings', { count: counted.length }),
    t('{money} expected', { money: total(counted) }),
    ...(completed.length ? [t('{money} done', { money: total(completed) })] : []),
  ].join(' · ');

  // Nothing can be added to a day the shop is closed; reopening it comes first.
  const canAdd = !closure;
  // On the barber's own phone, the barber they show; with no services yet, only time can be blocked.
  const addBooking = () =>
    router.push({
      pathname: '/barber/new-booking',
      params: { day, barber: filterId ?? '', kind: services === 0 ? 'block' : 'booking' },
    });
  /** From free time in a chair: that barber, at the quarter hour tapped. */
  const addAt = (barber: string, time: string) =>
    router.push({
      pathname: '/barber/new-booking',
      params: { day, barber, time, kind: services === 0 ? 'block' : 'booking' },
    });
  // The day as chairs, for the barbers shown; null while it shows as a list, isn't loaded or is closed.
  const grid =
    chairs && loaded && !closure
      ? chairsDay(day, filterId ? barbers.filter((b) => b.id === filterId) : barbers, shown, tz)
      : null;
  // The booking whose actions are open over the chairs; gone with the day or once it leaves it.
  const pickedBooking = grid && picked?.day === day ? (kept.find((b) => b.id === picked.id) ?? null) : null;
  // Opened on today as chairs (kept from last time), the day opens on now, once a visit: when the server
  // has answered, or failed to, unless the barber has scrolled or tapped the switch or a day meanwhile.
  const openAtNow = Boolean(grid) && isToday && !nowPlaced.has(shop.id) && (freshFor === day || refreshError !== null);
  const onOpenAtNow = (y: number | null) => {
    if (nowPlaced.has(shop.id)) return;
    nowPlaced.add(shop.id);
    // What is above comes first: a failed refresh (so the barber knows the day may be out of date), an
    // error, or what customers changed.
    const readFirst = refreshError || error || (news && news.count > 0);
    if (y !== null && !readFirst && scrollY.current <= 0) scroller.current?.scrollTo({ y, animated: false });
  };
  // The floating button would cover the bar, and the button under the date already shows near the top.
  const showFab = canAdd && !notice && !pickedBooking && pastAddButton;

  // Cards the customer booked or moved since this phone last looked say so until Got it.
  const seenUpTo = seenMark(seen, news);
  /** The booking opened from the news card, with a handle to bring it into view. */
  const focusable = (b: ShopBooking, row: ReactNode) =>
    b.id === focus?.id ? (
      <View key={b.id} ref={focusRef}>
        {row}
      </View>
    ) : (
      row
    );

  const renderOpen = (b: ShopBooking) => focusable(b, openCard(b));

  /**
   * A booking still to come or to mark, or time still blocked, with everything that can be done to it.
   * Over the chairs the barber is said above it, so it leaves out their badge.
   */
  const openCard = (b: ShopBooking, withBarber = showBarber) =>
    b.is_block ? (
      <Card key={b.id} style={styles.compactCard}>
        <BlockRow booking={b} tz={tz} onRemove={() => cancel(b)} />
      </Card>
    ) : (
      <LiveCard
        key={b.id}
        booking={b}
        tz={tz}
        now={now}
        showBarber={withBarber}
        away={awayIds.has(b.barber_id)}
        held={held}
        onMark={(status) => mark([b], status)}
        onCancel={() => cancel(b)}
        onMove={() => router.push({ pathname: '/barber/move-booking', params: { id: b.id } })}
        onWhatsApp={() => whatsapp(b)}
        unsaved={unsaved[b.id] && awaitsReminder(b, now) ? unsaved[b.id] : undefined}
        onRemind={() => remind(b)}
        onSaveReminder={() => saveReminder(b, unsaved[b.id].startsAt)}
        onUnremind={() => unremind(b)}
        tag={changeTag(b, seenUpTo, todayStart)}
      />
    );

  /** A booking that is done, a no-show or cancelled, or time blocked that is over. */
  const finishedRow = (b: ShopBooking, withBarber = showBarber) =>
    b.is_block ? (
      <BlockRow key={b.id} booking={b} tz={tz} />
    ) : (
      <FinishedRow
        key={b.id}
        booking={b}
        tz={tz}
        showBarber={withBarber}
        held={held}
        onRestore={() => restore([b])}
        onWhatsApp={() => (b.status === 'cancelled' && cancelledHere.has(b.id) ? sorry(b) : whatsapp(b))}
      />
    );

  const closeNotice = () => showNotice(null);

  /** A line of the news card: its day, with that booking brought into view. */
  const openChange = async (c: ShopChange) => {
    // A phone set to one barber's bookings switches to that booking's barber, without saving it as its choice.
    // Even when today shows no chips to pick from: the day it opens may.
    if (barberId && barberId !== c.barber_id) setBarberId(c.barber_id);
    // Cancelled ones wait in the folded list at the bottom.
    if (c.change === 'cancelled') setShowFinished(true);
    const target = localDateString(new Date(c.starts_at), tz);
    // The day on screen may have loaded before the customer booked.
    if (target === day) await load();
    focusPending.current = true;
    setFocus({ id: c.booking_id, day: target });
    // In its chair, with its actions open (a cancelled one's WhatsApp too), over the time it leaves free.
    if (chairs) setPicked({ id: c.booking_id, day: target });
    pickDay(target);
  };

  /** Over the chairs: the tapped booking's time and barber, and the same card the list has for it. */
  const panel = pickedBooking ? (
    <ChairsPanel
      key={pickedBooking.id}
      label={bookingLabel(pickedBooking, whoFor, pickedBooking.barbers?.name ?? '', tz, now)}
      title={`${
        isWholeDay(pickedBooking)
          ? t('Whole day')
          : noBreak(`${formatTime(pickedBooking.starts_at, tz)}–${formatTime(pickedBooking.ends_at, tz)}`)
      }${pickedBooking.barbers ? ` · ${pickedBooking.barbers.name}` : ''}`}
      onClose={() => setPicked(null)}
      onLayout={(e) => setPanelHeight(e.nativeEvent.layout.height)}>
      {isFinished(pickedBooking) ? (
        <Card style={styles.compactCard}>{finishedRow(pickedBooking, false)}</Card>
      ) : (
        openCard(pickedBooking, false)
      )}
    </ChairsPanel>
  ) : null;

  return (
    <Screen
      onRefresh={() => Promise.all([load(), refreshNews()])}
      scrollRef={scroller}
      onScroll={(y) => {
        scrollY.current = y;
        setPastAddButton(y > addButtonBottom);
        setNamesStuck(chairsFrame !== null && y > chairsFrame.top);
      }}
      overlay={
        <>
          {grid && chairsFrame && namesStuck ? (
            <ChairNames chairs={grid.chairs} frame={chairsFrame} scrollX={chairsX} topInset={insets.top} />
          ) : null}
          <View style={styles.overlay}>
            {panel ? <View style={[styles.panelWrap, !notice && { paddingBottom: Spacing.lg }]}>{panel}</View> : null}
            {notice || showFab ? (
              <View style={styles.overlayInner}>
                {notice ? (
                  <View
                    role="status"
                    accessibilityLiveRegion="polite"
                    onLayout={(e) => setNoticeHeight(e.nativeEvent.layout.height)}
                    style={[styles.undoBar, { backgroundColor: theme.card, borderColor: theme.border }]}>
                    <T style={styles.noticeText}>{notice.message}</T>
                    <View style={styles.noticeActions}>
                      <Button
                        title={notice.actionLabel}
                        variant="secondary"
                        onPress={() => {
                          closeNotice();
                          notice.onAction();
                        }}
                      />
                      {notice.closable ? (
                        <IconButton icon="close" label={t('Close')} variant="ghost" onPress={closeNotice} />
                      ) : null}
                    </View>
                  </View>
                ) : null}
                {/* Adding a walk-in works from anywhere in a long day. */}
                {showFab ? (
                  <View style={styles.fab}>
                    <IconButton icon="add" label={t('Add booking or block time')} variant="primary" onPress={addBooking} />
                  </View>
                ) : null}
              </View>
            ) : null}
          </View>
        </>
      }>
      <ScreenTitle title={t('Bookings')} refreshing={fromCache && asking} />
      {loaded && refreshError ? (
        <StaleNote savedAt={savedAt} onRetry={load} retrying={asking} timeZone={tz} />
      ) : null}

      {news && news.count > 0 ? (
        <NewsCard
          news={news}
          tz={tz}
          now={now}
          showBarber={barbers.length > 1 || new Set(news.changes.map((c) => c.barber_id)).size > 1}
          onOpen={openChange}
          onDone={markSeen}
        />
      ) : null}

      {/* The steps themselves are on My shop, so a new owner never sees two lists. */}
      {services !== null && !ready ? (
        <Card
          style={styles.compactCard}
          onPress={() => router.push('/barber/shop')}
          accessibilityLabel={`${notTaking.title}: ${notTaking.body}`}>
          <View style={styles.compactRow}>
            <Ionicons name="storefront-outline" size={22} color={theme.tint} />
            <View style={styles.info}>
              <T variant="label">{notTaking.title}</T>
              <T variant="small">{notTaking.body}</T>
            </View>
            <Ionicons name="chevron-forward" size={22} color={theme.textSecondary} />
          </View>
        </Card>
      ) : null}

      <DayPicker
        days={days}
        selected={day}
        onSelect={pickDay}
        closed={new Set([...Object.keys(closures), ...allOff])}
        pickClosed
      />

      {chipBarbers.length > 1 ? (
        <Row role="radiogroup" accessibilityLabel={t('Show bookings for')}>
          <Chip label={t('Everyone')} selected={!filterId} onPress={() => pickBarber(null)} />
          {chipBarbers.map((b) => (
            <Chip
              key={b.id}
              label={b.name}
              sublabel={b.is_active ? undefined : t('Away')}
              selected={filterId === b.id}
              onPress={() => pickBarber(b.id)}
            />
          ))}
        </Row>
      ) : null}

      {/* By the day picker it changes; the whole card is the button, so the words fit at phone width. */}
      {toRemind > 0 ? (
        <Card
          style={styles.compactCard}
          onPress={() => pickDay(addDays(day, 1))}
          accessibilityLabel={`${t('Remind tomorrow’s customers')}: ${t('{count} still to remind', { count: toRemind })}`}>
          <View style={styles.compactRow}>
            <Ionicons name="logo-whatsapp" size={22} color={theme.success} />
            <View style={styles.info}>
              <T variant="label">{t('Remind tomorrow’s customers')}</T>
              <T variant="small">{t('{count} still to remind', { count: toRemind })}</T>
            </View>
            <Ionicons name="chevron-forward" size={22} color={theme.textSecondary} />
          </View>
        </Card>
      ) : null}

      {loaded ? <ErrorText message={error} /> : null}

      <View ref={dayHeaderRef} style={styles.dayHeader}>
        <View style={styles.dayTitle}>
          <T variant="heading" style={styles.dayName}>
            {formatDay(dayBounds(day, tz).start, tz)}
          </T>
          {/* Chairs side by side show the gaps, often to fit a walk-in; List is easier with a screen reader. */}
          <Row role="radiogroup" accessibilityLabel={t('Show the day as')} style={styles.noWrap}>
            <Chip label={t('List')} icon="list" selected={!chairs} onPress={() => pickView('list')} />
            <Chip label={t('Chairs')} icon="grid-outline" selected={chairs} onPress={() => pickView('chairs')} />
          </Row>
        </View>
        {loaded && counted.length ? <T variant="muted">{summary}</T> : null}
      </View>
      {canAdd ? (
        <View onLayout={(e) => setAddButtonBottom(e.nativeEvent.layout.y + e.nativeEvent.layout.height)}>
          <Button title={t('+ Add booking or block time')} variant="secondary" onPress={addBooking} />
        </View>
      ) : null}

      {!loaded ? (
        refreshError ? (
          // This day never loaded, so there is nothing to show under its date but the reason and a retry.
          <View style={styles.list}>
            <ErrorText message={refreshError} />
            <Button
              title={t('Try again')}
              variant="secondary"
              onPress={() => {
                // Back to the shapes while it tries.
                setRefreshError(null);
                load();
              }}
            />
          </View>
        ) : chairs ? (
          <ChairsSkeleton />
        ) : (
          <DaySkeleton />
        )
      ) : closure ? (
        <Card>
          <T variant="heading">{t('Shop closed')}</T>
          {closure.reason ? <T>{closure.reason}</T> : null}
          <T variant="small">{t('Customers can’t book this day.')}</T>
          <Button
            title={t('Reopen')}
            accessibilityLabel={t('Reopen {days}', { days: dateRange(day, day) })}
            variant="secondary"
            onPress={reopen}
          />
        </Card>
      ) : grid ? (
        <Chairs
          grid={grid}
          day={day}
          tz={tz}
          now={now}
          nameOf={whoFor}
          selectedId={pickedBooking?.id ?? null}
          focus={focus?.day === day ? (kept.find((b) => b.id === focus.id) ?? null) : null}
          focusRef={focusRef}
          scrollX={chairsX}
          emptyTitle={
            filterId
              ? t('{name} isn’t working this day', { name: barbers.find((b) => b.id === filterId)?.name ?? '' })
              : t('Nobody is working this day')
          }
          onOpen={(b) => setPicked({ id: b.id, day })}
          onAdd={addAt}
          onFrame={onChairsFrame}
          openAtNow={openAtNow}
          onOpenAtNow={onOpenAtNow}
        />
      ) : shown.length === 0 ? (
        <Empty
          title={t('No bookings')}
          body={shop.is_published ? t('Share your booking link to fill this day.') : undefined}
        />
      ) : null}

      {needsMarking.length ? (
        <Section
          title={t('Needs marking')}
          action={
            needsMarking.length > 1 ? (
              <Button
                title={t('Mark all as done')}
                variant="secondary"
                {...held}
                onPress={() => mark(needsMarking, 'completed')}
              />
            ) : undefined
          }>
          {needsMarking.map(renderOpen)}
        </Section>
      ) : null}

      {inChair.length ? <Section title={t('Now')}>{inChair.map(renderOpen)}</Section> : null}

      {upcoming.length ? (
        isToday ? (
          <Section title={t('Next')}>{upcoming.map(renderOpen)}</Section>
        ) : (
          <View style={styles.list}>{upcoming.map(renderOpen)}</View>
        )
      ) : null}

      {finished.length ? (
        <View style={styles.list}>
          {onlyFinished ? (
            <T variant="heading">{finishedTitle}</T>
          ) : (
            // Folded, so the day's remaining work stays at the top.
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ expanded: finishedOpen }}
              aria-expanded={finishedOpen}
              onPress={() => setShowFinished(!showFinished)}
              style={styles.fold}>
              <T variant="heading">{finishedTitle}</T>
              <Ionicons name={finishedOpen ? 'chevron-up' : 'chevron-down'} size={22} color={theme.textSecondary} />
            </Pressable>
          )}
          {finishedOpen ? (
            <Card style={styles.compactCard}>
              {finished.map((b) => (b.is_block ? finishedRow(b) : focusable(b, finishedRow(b))))}
            </Card>
          ) : null}
        </View>
      ) : null}

      {/* Room for the add button, the bar and a booking's actions over the chairs, so none covers the end of the day for good. */}
      <View style={{ height: (notice ? Math.max(48, noticeHeight) : 48) + (panel ? panelHeight : 0) }} />
    </Screen>
  );
}

const minutesOf = (b: Booking) => Math.round((new Date(b.ends_at).getTime() - new Date(b.starts_at).getTime()) / 60000);

function whoFor(b: ShopBooking): string {
  return b.customer?.full_name || (b.guest_name === WALK_IN ? t('Walk-in') : b.guest_name) || t('Customer');
}

const phoneOf = (b: Pick<Booking, 'is_block' | 'guest_phone'> & { customer: { phone: string | null } | null }) =>
  b.is_block ? null : (b.customer?.phone ?? b.guest_phone);

/** Still to come with nobody's reminder recorded, so a row can say one wasn't saved. */
const awaitsReminder = (b: Booking, now: number) =>
  b.status === 'confirmed' && !b.reminded_at && new Date(b.starts_at).getTime() > now;

const openWhatsApp = (phone: string, message: string) => Linking.openURL(whatsappUrl(phone, message)).catch(() => {});

const call = (phone: string) => Linking.openURL(`tel:${phone.replace(/[^\d+]/g, '')}`).catch(() => {});

/**
 * A start time in the time column, read as one ("10:30 am"). Malay's longer
 * periods ("tengah hari") go on a line of their own under the clock, so the
 * time never breaks in the middle and the column fits both languages.
 */
function StartTime({ at, tz, variant }: { at: string; tz: string; variant: 'heading' | 'label' }) {
  const { clock, period } = formatTimeParts(at, tz);
  const short = period.length <= 2;
  return (
    <T variant={variant} style={variant === 'heading' ? styles.time : undefined}>
      {short ? `${clock} ${period}` : clock}
      {short ? null : <Text style={styles.period}>{`\n${period}`}</Text>}
    </T>
  );
}

/**
 * A booking still to come or still to mark. The time sits on the left so a
 * column of cards reads like the day; Change time, Cancel and Call wait behind
 * "more", away from Done and No-show, with the whole note. The day before,
 * Remind takes Done's place until someone in the shop has sent one; other
 * reminders, and taking one back, wait behind "more".
 */
function LiveCard({
  booking: b,
  tz,
  now,
  showBarber,
  away,
  unsaved,
  held,
  onMark,
  onCancel,
  onMove,
  onWhatsApp,
  onRemind,
  onSaveReminder,
  onUnremind,
  tag,
}: {
  booking: ShopBooking;
  tz: string;
  now: number;
  showBarber: boolean;
  /** The barber is marked away, so someone has to see to this customer. */
  away: boolean;
  unsaved?: Unsaved;
  held: Held;
  onMark: (status: 'completed' | 'no_show') => void;
  onCancel: () => void;
  onMove: () => void;
  onWhatsApp: () => void;
  onRemind: () => Promise<void>;
  onSaveReminder: () => Promise<void>;
  onUnremind: () => Promise<void>;
  /** Booked or moved by the customer since this phone last looked. */
  tag: ReturnType<typeof changeTag>;
}) {
  const theme = useTheme();
  const [more, setMore] = useState(false);
  const [noteOpen, setNoteOpen] = useState(false);
  const [reminding, setReminding] = useState(false);
  const wholeNote = more || noteOpen;
  const who = whoFor(b);
  const phone = phoneOf(b);
  const remindable = canRemind(b, phone, now, tz);
  const due = needsReminder(b, phone, now, tz);
  // Saving again sends nothing; a message naming a time the booking has moved from can't be saved.
  const resave = unsaved && new Date(unsaved.startsAt).getTime() === new Date(b.starts_at).getTime();
  const busy = (action: () => Promise<void>) => async () => {
    setReminding(true);
    try {
      await action();
    } finally {
      setReminding(false);
    }
  };
  // The server only takes Done or No-show once the appointment has started.
  const started = new Date(b.starts_at).getTime() <= now;
  const ended = new Date(b.ends_at).getTime() <= now;
  const barber = showBarber && b.barbers ? b.barbers.name : null;
  // Only bookings still to come: someone has to see to them, or let the customer know.
  const awayNow = away && !started;
  // Added at the counter or from a call, rather than booked online by the customer.
  const byShop = !b.customer_id;
  return (
    <Card>
      <View style={styles.cardRow}>
        <View style={styles.timeCol}>
          <StartTime at={b.starts_at} tz={tz} variant="heading" />
          <T variant="small">{formatDuration(minutesOf(b))}</T>
        </View>
        <View style={styles.info}>
          <T variant="label">{who}</T>
          <T>
            {b.service_name} · {formatPrice(b.price)}
          </T>
          {tag || barber || awayNow || ended || byShop ? (
            <Row style={styles.badges}>
              {tag ? <Badge label={tag.label} tone={tag.kind === 'new' ? 'success' : 'warning'} /> : null}
              {/* Even on that barber's own list, so nobody expects them in. */}
              {awayNow ? (
                <Badge label={t('{name} is away', { name: b.barbers?.name ?? '' })} tone="warning" />
              ) : barber ? (
                <Badge label={barber} />
              ) : null}
              {ended ? <BookingStatusBadge booking={b} forShop /> : null}
              {byShop ? <Badge label={t('Added by shop')} /> : null}
            </Row>
          ) : null}
          {/* Notes can be long (up to 280 characters): a tap on a long one, or More, shows the whole of it.
              About 60 characters fill the two lines it gets on a small phone. */}
          {b.customer_note && b.customer_note.length <= 60 ? (
            <T variant="muted">“{b.customer_note}”</T>
          ) : b.customer_note ? (
            <Pressable
              accessibilityRole="button"
              accessibilityHint={wholeNote ? undefined : t('Shows the whole note')}
              aria-expanded={wholeNote}
              onPress={() => setNoteOpen(!wholeNote)}>
              <T variant="muted" numberOfLines={wholeNote ? undefined : 2}>
                “{b.customer_note}”
              </T>
            </Pressable>
          ) : null}
          {b.reminded_at ? <T variant="small">✓ {t('Reminded')}</T> : null}
        </View>
        <View>
          {phone ? (
            <IconButton
              icon="logo-whatsapp"
              label={t('WhatsApp {name}', { name: who })}
              variant="ghost"
              color={theme.success}
              onPress={onWhatsApp}
            />
          ) : null}
          <IconButton
            icon={more ? 'chevron-up' : 'ellipsis-horizontal'}
            label={more ? t('Hide actions for {name}', { name: who }) : t('More actions for {name}', { name: who })}
            variant="ghost"
            onPress={() => setMore(!more)}
          />
        </View>
      </View>
      {unsaved ? (
        <ErrorText
          message={t('Reminder not saved. {reason}', {
            reason: resave ? unsaved.reason : t('This booking has changed. Check the new time.'),
          })}
        />
      ) : null}
      {started ? (
        <Row style={styles.noWrap}>
          <Button title={t('Done')} variant="secondary" style={{ flex: 1 }} {...held} onPress={() => onMark('completed')} />
          <Button title={t('No-show')} variant="ghost" {...held} onPress={() => onMark('no_show')} />
        </Row>
      ) : resave ? (
        <Button
          title={t('Mark as reminded')}
          accessibilityLabel={t('Mark {name} as reminded', { name: who })}
          variant="secondary"
          loading={reminding}
          disabled={held?.disabled}
          onPress={busy(onSaveReminder)}
        />
      ) : due ? (
        <Button
          title={t('Remind on WhatsApp')}
          accessibilityLabel={t('Remind {name} on WhatsApp', { name: who })}
          variant="secondary"
          loading={reminding}
          disabled={held?.disabled}
          onPress={busy(onRemind)}
        />
      ) : null}
      {more ? (
        <Row>
          {remindable && (resave || !due) ? (
            <Button
              title={b.reminded_at ? t('Remind again') : t('Remind on WhatsApp')}
              variant="secondary"
              loading={reminding}
              disabled={held?.disabled}
              onPress={busy(onRemind)}
            />
          ) : null}
          {b.reminded_at && !started ? (
            <Button
              title={t('Undo “{status}”', { status: t('Reminded') })}
              variant="secondary"
              loading={reminding}
              disabled={held?.disabled}
              onPress={busy(onUnremind)}
            />
          ) : null}
          {/* A customer who calls to come later keeps their booking, and their app shows the new time. */}
          {started ? null : (
            <Button
              title={t('Change time')}
              accessibilityLabel={t('Change time for {name}', { name: who })}
              variant="secondary"
              onPress={onMove}
            />
          )}
          {phone ? <Button title={t('Call')} variant="secondary" onPress={() => call(phone)} /> : null}
          <Button title={t('Cancel booking')} variant="danger" {...held} onPress={onCancel} />
        </Row>
      ) : null}
    </Card>
  );
}

/**
 * What customers booked, moved or cancelled since this phone last looked,
 * newest first, one sentence each. A line opens its day; Got it clears the
 * card and the tab's number until something else changes.
 */
function NewsCard({
  news,
  tz,
  now,
  showBarber,
  onOpen,
  onDone,
}: {
  news: ShopChanges;
  tz: string;
  now: number;
  showBarber: boolean;
  onOpen: (c: ShopChange) => void;
  onDone: () => void;
}) {
  const theme = useTheme();
  const more = moreText(news.count, news.changes.length);
  const look = {
    booked: { icon: 'add-circle-outline', color: theme.success },
    moved: { icon: 'swap-horizontal-outline', color: theme.warning },
    cancelled: { icon: 'close-circle-outline', color: theme.danger },
  } as const;
  return (
    <Card style={styles.compactCard}>
      <T variant="heading" style={styles.newsHeading}>
        {t('Since you last looked')}
      </T>
      {news.changes.map((c) => {
        const text = changeLine(c, now, tz, showBarber);
        const when = ago(c.changed_at, now);
        return (
          <Pressable
            key={c.booking_id}
            accessibilityRole="button"
            accessibilityLabel={`${text}. ${when}`}
            onPress={() => onOpen(c)}
            style={({ pressed }) => [styles.newsLine, pressed && { opacity: 0.6 }]}>
            <Ionicons name={look[c.change].icon} size={22} color={look[c.change].color} />
            <T style={styles.newsText}>
              {text}
              {/* Kept together and with the word before, so the dot never starts or ends a line. */}
              <Text style={{ color: theme.textSecondary }}>{noBreak(` · ${when}`)}</Text>
            </T>
            <Ionicons name="chevron-forward" size={20} color={theme.textSecondary} />
          </Pressable>
        );
      })}
      <View style={styles.newsFooter}>
        {more ? (
          <T variant="muted" style={styles.newsText}>
            {more}
          </T>
        ) : null}
        <Button title={t('Got it')} variant="secondary" onPress={onDone} />
      </View>
    </Card>
  );
}

/** Time the barber blocked off, on one short line. */
function BlockRow({ booking: b, tz, onRemove }: { booking: ShopBooking; tz: string; onRemove?: () => void }) {
  return (
    <View style={styles.compactRow}>
      <View style={styles.timeCol}>
        {isWholeDay(b) ? <T variant="label">{t('Whole day')}</T> : <StartTime at={b.starts_at} tz={tz} variant="label" />}
        {isWholeDay(b) ? null : <T variant="small">{formatDuration(minutesOf(b))}</T>}
      </View>
      <View style={styles.info}>
        <T>
          {/* Blocks saved without a reason get this English default from the database. */}
          {b.service_name === 'Blocked' ? t('Blocked') : b.service_name}
          {b.barbers ? ` · ${b.barbers.name}` : ''}
        </T>
        <Badge label={t('Blocked')} />
      </View>
      {onRemove ? <IconButton icon="trash-outline" label={t('Remove block')} variant="ghost" onPress={onRemove} /> : null}
    </View>
  );
}

/** A booking that is done, a no-show or cancelled: one short line that still has WhatsApp and a way back. */
function FinishedRow({
  booking: b,
  tz,
  showBarber,
  held,
  onRestore,
  onWhatsApp,
}: {
  booking: ShopBooking;
  tz: string;
  showBarber: boolean;
  held: Held;
  onRestore: () => void;
  onWhatsApp: () => void;
}) {
  const theme = useTheme();
  const [more, setMore] = useState(false);
  const who = whoFor(b);
  const phone = phoneOf(b);
  const marked = b.status === 'completed' || b.status === 'no_show';
  return (
    <View style={styles.list}>
      <View style={styles.compactRow}>
        <View style={styles.timeCol}>
          <StartTime at={b.starts_at} tz={tz} variant="label" />
        </View>
        <View style={styles.info}>
          <T variant="label" numberOfLines={1}>
            {who}
          </T>
          <Row style={styles.badges}>
            <BookingStatusBadge booking={b} forShop />
            {showBarber && b.barbers ? <Badge label={b.barbers.name} /> : null}
          </Row>
        </View>
        {phone ? (
          <IconButton
            icon="logo-whatsapp"
            label={t('WhatsApp {name}', { name: who })}
            variant="ghost"
            color={theme.success}
            onPress={onWhatsApp}
          />
        ) : null}
        {marked ? (
          <IconButton
            icon={more ? 'chevron-up' : 'ellipsis-horizontal'}
            label={more ? t('Hide actions for {name}', { name: who }) : t('More actions for {name}', { name: who })}
            variant="ghost"
            onPress={() => setMore(!more)}
          />
        ) : null}
      </View>
      {more && marked ? (
        <Row>
          <Button
            title={t('Undo “{status}”', { status: b.status === 'completed' ? t('Done') : t('No-show') })}
            variant="secondary"
            {...held}
            onPress={onRestore}
          />
          {phone ? <Button title={t('Call')} variant="secondary" onPress={() => call(phone)} /> : null}
        </Row>
      ) : null}
    </View>
  );
}

/** The shape of a few bookings, while a day with nothing kept from before loads. */
function DaySkeleton() {
  return (
    <Skeleton label={t('Loading bookings')} style={styles.list}>
      {[0, 1, 2].map((i) => (
        <Card key={i}>
          <View style={styles.cardRow}>
            <View style={[styles.timeCol, styles.list]}>
              <Bone width={72} height={20} />
              <Bone width={48} height={12} />
            </View>
            <View style={[styles.info, styles.list]}>
              <Bone width="55%" />
              <Bone width="80%" />
            </View>
          </View>
          <Bone height={48} style={{ borderRadius: Radius.md }} />
        </Card>
      ))}
    </Skeleton>
  );
}

const styles = StyleSheet.create({
  list: { gap: Spacing.sm },
  dayHeader: { gap: Spacing.xs },
  // The switch goes under the date when both don't fit (in Malay on a small phone), rather than breaking the date.
  dayTitle: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: Spacing.sm },
  dayName: { flexGrow: 1, flexShrink: 1 },
  noWrap: { flexWrap: 'nowrap' },
  badges: { gap: Spacing.xs },
  cardRow: { flexDirection: 'row', gap: Spacing.sm },
  compactRow: { flexDirection: 'row', alignItems: 'center', gap: Spacing.sm, minHeight: 48 },
  compactCard: { paddingVertical: Spacing.sm },
  newsHeading: { paddingTop: Spacing.xs },
  newsLine: { flexDirection: 'row', alignItems: 'center', gap: Spacing.sm, minHeight: 48 },
  newsText: { flex: 1 },
  newsFooter: { flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', gap: Spacing.sm },
  // Fixed, so the start times line up down the day.
  timeCol: { width: 92 },
  time: { fontSize: 16, lineHeight: 22 },
  // A Malay period under the clock: smaller, so "tengah hari" fits the column on one line.
  period: { fontSize: 13, lineHeight: 18, fontWeight: '600' },
  info: { flex: 1, gap: 2 },
  fold: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', minHeight: 48 },
  overlay: { position: 'absolute', left: 0, right: 0, bottom: 0, pointerEvents: 'box-none' },
  overlayInner: {
    width: '100%',
    maxWidth: MaxContentWidth,
    alignSelf: 'center',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: Spacing.sm,
    padding: Spacing.lg,
    pointerEvents: 'box-none',
  },
  // A long message ("Booking cancelled. Let Encik Rosli know.") puts the button on a line of its own.
  undoBar: {
    flex: 1,
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'flex-end',
    columnGap: Spacing.sm,
    borderWidth: 1,
    borderRadius: Radius.md,
    paddingVertical: Spacing.xs,
    paddingLeft: Spacing.lg,
    paddingRight: Spacing.xs,
    boxShadow: '0 4px 12px rgba(0, 0, 0, 0.2)',
  },
  noticeText: { flexGrow: 1, flexShrink: 1, flexBasis: 'auto', paddingVertical: Spacing.sm },
  noticeActions: { flexDirection: 'row', alignItems: 'center', marginLeft: 'auto' },
  fab: { borderRadius: Radius.md, boxShadow: '0 2px 8px rgba(0, 0, 0, 0.25)' },
  panelWrap: { width: '100%', maxWidth: MaxContentWidth, alignSelf: 'center', paddingHorizontal: Spacing.lg },
});
