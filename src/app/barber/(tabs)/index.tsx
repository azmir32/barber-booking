import Ionicons from '@expo/vector-icons/Ionicons';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { router, useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Linking, Platform, Pressable, StyleSheet, View } from 'react-native';

import { BookingStatusBadge } from '@/components/booking-status';
import { DayPicker } from '@/components/day-picker';
import { Badge, Button, Card, Chip, Empty, ErrorText, IconButton, Row, Screen, Section, T } from '@/components/ui';
import { MaxContentWidth, Radius, Spacing } from '@/constants/theme';
import { useNow } from '@/hooks/use-now';
import { useTheme } from '@/hooks/use-theme';
import { confirmAction } from '@/lib/confirm';
import { summarizeWeek } from '@/lib/hours';
import { t } from '@/lib/lang';
import { useMyShop } from '@/lib/my-shop';
import { whatsappUrl } from '@/lib/phone';
import { errorMessage, supabase } from '@/lib/supabase';
import {
  dayBounds,
  formatDay,
  formatDuration,
  formatPrice,
  formatTime,
  localDateString,
  upcomingDays,
} from '@/lib/time';
import type { Barber, Booking, BookingStatus, WorkingHours } from '@/lib/types';

type ShopBooking = Booking & {
  barbers: { name: string } | null;
  customer: { full_name: string; phone: string | null } | null;
};

type BarberWithHours = Barber & { working_hours: WorkingHours[] };

/** The bar at the bottom: what just happened and one thing to do about it (undo, or message the customer). */
type Notice = { message: string; actionLabel: string; onAction: () => void };

/** How long the bar stays up: long enough to notice a slip with wet hands. */
const NOTICE_MS = 8000;
/** Whose bookings this phone shows, so each barber's phone opens on their own queue. */
const filterKey = (shopId: string) => `potongku.barberFilter.${shopId}`;
/** Set once the owner has looked at the hours every new barber starts with. */
const hoursCheckedKey = (shopId: string) => `potongku.hoursChecked.${shopId}`;

export default function BarberBookings() {
  const { shop } = useMyShop();
  const theme = useTheme();
  const now = useNow();
  const tz = shop!.time_zone;
  // Yesterday is included so last-minute no-shows can still be marked.
  const days = useMemo(() => upcomingDays(15, tz, new Date(), -1), [tz]);
  const [day, setDay] = useState(days[1].date);
  const [bookings, setBookings] = useState<ShopBooking[]>([]);
  const [barbers, setBarbers] = useState<BarberWithHours[]>([]);
  const [services, setServices] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [barberId, setBarberId] = useState<string | null>(null);
  const [hoursChecked, setHoursChecked] = useState(false);
  const [hoursOpen, setHoursOpen] = useState(false);
  const [showFinished, setShowFinished] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const noticeTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const latest = useRef(0);
  const shopId = shop?.id;

  useEffect(() => {
    if (!shopId) return;
    AsyncStorage.getItem(filterKey(shopId))
      .then((saved) => setBarberId(saved || null))
      .catch(() => {});
    AsyncStorage.getItem(hoursCheckedKey(shopId))
      .then((saved) => setHoursChecked(saved === '1'))
      .catch(() => {});
  }, [shopId]);

  useEffect(() => () => clearTimeout(noticeTimer.current), []);

  const load = useCallback(async () => {
    if (!shop) return;
    // Only the newest load fills the screen, so a slow answer for the day before can't replace it.
    const request = ++latest.current;
    const { start, end } = dayBounds(day, tz);
    const [list, active, team] = await Promise.all([
      supabase
        .from('bookings')
        .select('*, barbers(name), customer:profiles!bookings_customer_id_fkey(full_name, phone)')
        .eq('shop_id', shop.id)
        .gte('starts_at', start.toISOString())
        .lt('starts_at', end.toISOString())
        .order('starts_at'),
      supabase.from('services').select('id', { count: 'exact', head: true }).eq('shop_id', shop.id).eq('is_active', true),
      supabase.from('barbers').select('*, working_hours(*)').eq('shop_id', shop.id).order('sort_order').order('created_at'),
    ]);
    if (request !== latest.current) return;
    if (list.error) return setError(errorMessage(list.error));
    setError(null);
    setBookings((list.data ?? []) as ShopBooking[]);
    setServices(active.count ?? 0);
    if (!team.error) setBarbers((team.data ?? []) as BarberWithHours[]);
  }, [shop, day, tz]);

  // Reloads after a status change use the day on screen by then, not the day the button was tapped on.
  const loadRef = useRef(load);
  useEffect(() => {
    loadRef.current = load;
  }, [load]);

  useFocusEffect(
    useCallback(() => {
      load();
      // New online bookings show up while the screen stays open at the counter.
      const timer = setInterval(load, 60_000);
      return () => clearInterval(timer);
    }, [load]),
  );

  if (!shop) return null;

  const showNotice = (next: Notice | null) => {
    clearTimeout(noticeTimer.current);
    setNotice(next);
    if (next) noticeTimer.current = setTimeout(() => setNotice(null), NOTICE_MS);
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
    if (phone) openWhatsApp(phone, t('Hi {who}, this is {shop} about your {service} on {day} at {time}.', messageVars(b)));
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
    // Tell the customer straight away, with a sorry and an offer of another time.
    const sorry = () =>
      openWhatsApp(
        phone,
        t(
          'Hi {who}, sorry, {shop} has to cancel your {service} on {day} at {time}. Reply here and we will find you another time.',
          messageVars(b),
        ),
      );
    // Browsers block a new tab that isn't opened by a tap, and the cancel took a round trip,
    // so on the web the barber taps once more in the bar.
    if (Platform.OS === 'web') {
      showNotice({
        message: t('Booking cancelled. Let {name} know.', { name: whoFor(b) }),
        actionLabel: t('WhatsApp {name}', { name: whoFor(b) }),
        onAction: sorry,
      });
    } else {
      sorry();
    }
  };

  const pickBarber = (id: string | null) => {
    setBarberId(id);
    AsyncStorage.setItem(filterKey(shop.id), id ?? '').catch(() => {});
  };

  const confirmHours = () => {
    setHoursChecked(true);
    AsyncStorage.setItem(hoursCheckedKey(shop.id), '1').catch(() => {});
  };

  const addBooking = () => router.push({ pathname: '/barber/new-booking', params: { day } });

  // Setup -------------------------------------------------------------------
  const activeBarbers = barbers.filter((b) => b.is_active);
  const hasHours = activeBarbers.some((b) => b.working_hours.length > 0);
  // Every new barber starts with default hours, so the step only ticks once the owner has seen them.
  const hoursDone = activeBarbers.length > 0 && hasHours && hoursChecked;
  const ready = services !== null && services > 0 && activeBarbers.length > 0 && hasHours && shop.is_published;

  // The day's list ---------------------------------------------------------
  // A saved choice for a barber who has left or is away shows everyone.
  const filterId = activeBarbers.length > 1 && activeBarbers.some((b) => b.id === barberId) ? barberId : null;
  // A removed block is gone from the barber's point of view.
  const kept = bookings.filter((b) => !(b.is_block && b.status === 'cancelled'));
  const shown = filterId ? kept.filter((b) => b.barber_id === filterId) : kept;
  const showBarber = barbers.length > 1 && !filterId;
  const isToday = day === localDateString(new Date(now), tz);
  const started = (b: Booking) => new Date(b.starts_at).getTime() <= now;
  const ended = (b: Booking) => new Date(b.ends_at).getTime() <= now;
  // Blocks are never marked, so they count as finished once their time is over.
  const finished = shown.filter((b) => b.status !== 'confirmed' || (b.is_block && ended(b)));
  const open = shown.filter((b) => !finished.includes(b));
  const needsMarking = open.filter(ended);
  const inChair = open.filter((b) => started(b) && !ended(b));
  const upcoming = open.filter((b) => !started(b));
  const onlyFinished = finished.length === shown.length;
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

  const renderOpen = (b: ShopBooking) =>
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
        showBarber={showBarber}
        onMark={(status) => mark([b], status)}
        onCancel={() => cancel(b)}
        onWhatsApp={() => whatsapp(b)}
      />
    );

  return (
    <Screen
      onRefresh={load}
      overlay={
        <View style={styles.overlay}>
          <View style={styles.overlayInner}>
            {notice ? (
              <View
                role="status"
                accessibilityLiveRegion="polite"
                style={[styles.undoBar, { backgroundColor: theme.card, borderColor: theme.border }]}>
                <T style={{ flex: 1 }}>{notice.message}</T>
                <Button
                  title={notice.actionLabel}
                  variant="secondary"
                  onPress={() => {
                    showNotice(null);
                    notice.onAction();
                  }}
                />
              </View>
            ) : null}
            {/* Adding a walk-in works from anywhere in a long day. */}
            <View style={styles.fab}>
              <IconButton icon="add" label={t('Add booking or block time')} variant="primary" onPress={addBooking} />
            </View>
          </View>
        </View>
      }>
      <T variant="title">{t('Bookings')}</T>

      {services !== null && !ready ? (
        <Card>
          <T variant="heading">{t('Get ready for bookings')}</T>
          <SetupStep
            done={services > 0}
            label={t('Add your services and prices')}
            onPress={() => router.push('/barber/services')}
          />
          <SetupStep
            done={hoursDone}
            label={t('Check your barbers and working hours')}
            onPress={() => (activeBarbers.length ? setHoursOpen(true) : router.push('/barber/team'))}>
            {/* Opens by itself once it is the next step, so new owners see one thing at a time. */}
            {activeBarbers.length > 0 && (hoursOpen || services > 0) ? (
              <HoursCheck barbers={activeBarbers} onConfirm={confirmHours} />
            ) : null}
          </SetupStep>
          <SetupStep
            done={shop.is_published}
            label={t('Go live and share your booking link')}
            onPress={() => router.push('/barber/shop')}
          />
        </Card>
      ) : null}

      <DayPicker days={days} selected={day} onSelect={setDay} />

      {activeBarbers.length > 1 ? (
        <Row role="radiogroup" accessibilityLabel={t('Show bookings for')}>
          <Chip label={t('Everyone')} selected={!filterId} onPress={() => pickBarber(null)} />
          {activeBarbers.map((b) => (
            <Chip key={b.id} label={b.name} selected={filterId === b.id} onPress={() => pickBarber(b.id)} />
          ))}
        </Row>
      ) : null}

      <ErrorText message={error} />

      <View style={styles.dayHeader}>
        <T variant="heading">{formatDay(dayBounds(day, tz).start, tz)}</T>
        {counted.length ? <T variant="muted">{summary}</T> : null}
      </View>
      <Button title={t('+ Add booking or block time')} variant="secondary" onPress={addBooking} />

      {shown.length === 0 ? (
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
              <Button title={t('Mark all as done')} variant="secondary" onPress={() => mark(needsMarking, 'completed')} />
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
              {finished.map((b) =>
                b.is_block ? (
                  <BlockRow key={b.id} booking={b} tz={tz} />
                ) : (
                  <FinishedRow
                    key={b.id}
                    booking={b}
                    tz={tz}
                    showBarber={showBarber}
                    onRestore={() => restore([b])}
                    onWhatsApp={() => whatsapp(b)}
                  />
                ),
              )}
            </Card>
          ) : null}
        </View>
      ) : null}

      {/* Room for the add button, so it never covers the last card's buttons. */}
      <View style={styles.fabSpace} />
    </Screen>
  );
}

const isWholeDay = (b: Booking) =>
  b.is_block && new Date(b.ends_at).getTime() - new Date(b.starts_at).getTime() >= 24 * 60 * 60 * 1000;

const minutesOf = (b: Booking) => Math.round((new Date(b.ends_at).getTime() - new Date(b.starts_at).getTime()) / 60000);

function whoFor(b: ShopBooking): string {
  return b.customer?.full_name || b.guest_name || t('Customer');
}

const phoneOf = (b: ShopBooking) => (b.is_block ? null : (b.customer?.phone ?? b.guest_phone));

const openWhatsApp = (phone: string, message: string) => Linking.openURL(whatsappUrl(phone, message)).catch(() => {});

const call = (phone: string) => Linking.openURL(`tel:${phone.replace(/[^\d+]/g, '')}`).catch(() => {});

/**
 * A booking still to come or still to mark. The time sits on the left so a
 * column of cards reads like the day; Cancel and Call wait behind "more", away
 * from Done and No-show.
 */
function LiveCard({
  booking: b,
  tz,
  now,
  showBarber,
  onMark,
  onCancel,
  onWhatsApp,
}: {
  booking: ShopBooking;
  tz: string;
  now: number;
  showBarber: boolean;
  onMark: (status: 'completed' | 'no_show') => void;
  onCancel: () => void;
  onWhatsApp: () => void;
}) {
  const theme = useTheme();
  const [more, setMore] = useState(false);
  const who = whoFor(b);
  const phone = phoneOf(b);
  // The server only takes Done or No-show once the appointment has started.
  const started = new Date(b.starts_at).getTime() <= now;
  const ended = new Date(b.ends_at).getTime() <= now;
  const barber = showBarber && b.barbers ? b.barbers.name : null;
  return (
    <Card>
      <View style={styles.cardRow}>
        <View style={styles.timeCol}>
          <T variant="heading" style={styles.time}>
            {formatTime(b.starts_at, tz)}
          </T>
          <T variant="small">{formatDuration(minutesOf(b))}</T>
        </View>
        <View style={styles.info}>
          <T variant="label">{b.customer_id ? who : t('{name} (added by you)', { name: who })}</T>
          <T>
            {b.service_name} · {formatPrice(b.price)}
          </T>
          {barber || ended ? (
            <Row style={styles.badges}>
              {barber ? <Badge label={barber} /> : null}
              {ended ? <BookingStatusBadge booking={b} forShop /> : null}
            </Row>
          ) : null}
          {b.customer_note ? (
            <T variant="muted" numberOfLines={2}>
              “{b.customer_note}”
            </T>
          ) : null}
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
      {started ? (
        <Row style={styles.noWrap}>
          <Button title={t('Done')} variant="secondary" style={{ flex: 1 }} onPress={() => onMark('completed')} />
          <Button title={t('No-show')} variant="ghost" onPress={() => onMark('no_show')} />
        </Row>
      ) : null}
      {more ? (
        <Row>
          {phone ? <Button title={t('Call')} variant="secondary" onPress={() => call(phone)} /> : null}
          <Button title={t('Cancel booking')} variant="danger" onPress={onCancel} />
        </Row>
      ) : null}
    </Card>
  );
}

/** Time the barber blocked off, on one short line. */
function BlockRow({ booking: b, tz, onRemove }: { booking: ShopBooking; tz: string; onRemove?: () => void }) {
  return (
    <View style={styles.compactRow}>
      <View style={styles.timeCol}>
        <T variant="label">{isWholeDay(b) ? t('Whole day') : formatTime(b.starts_at, tz)}</T>
        {isWholeDay(b) ? null : <T variant="small">{formatDuration(minutesOf(b))}</T>}
      </View>
      <View style={styles.info}>
        <T>
          {b.service_name}
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
  onRestore,
  onWhatsApp,
}: {
  booking: ShopBooking;
  tz: string;
  showBarber: boolean;
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
          <T variant="label">{formatTime(b.starts_at, tz)}</T>
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
            onPress={onRestore}
          />
          {phone ? <Button title={t('Call')} variant="secondary" onPress={() => call(phone)} /> : null}
        </Row>
      ) : null}
    </View>
  );
}

function SetupStep({
  done,
  label,
  onPress,
  children,
}: {
  done: boolean;
  label: string;
  onPress: () => void;
  /** Shown under the step in place of its Go button while it is not done. */
  children?: ReactNode;
}) {
  const detail = done ? null : children;
  return (
    <View style={styles.list}>
      <Row style={{ justifyContent: 'space-between', flexWrap: 'nowrap' }}>
        <T style={{ flex: 1 }}>
          {done ? '✓ ' : '○ '}
          {label}
        </T>
        {done || detail ? null : <Button title={t('Go')} variant="secondary" onPress={onPress} />}
      </Row>
      {detail}
    </View>
  );
}

/** Each barber's week, so the owner checks the hours a new barber starts with instead of us ticking them. */
function HoursCheck({ barbers, onConfirm }: { barbers: BarberWithHours[]; onConfirm: () => void }) {
  return (
    <View style={styles.hoursCheck}>
      {barbers.map((b) => (
        <Row key={b.id} style={styles.noWrap}>
          <View style={{ flex: 1 }}>
            <T variant="label">{b.name}</T>
            <T variant="small">{summarizeWeek(b.working_hours)}</T>
          </View>
          <Button
            title={t('Change')}
            variant="ghost"
            onPress={() => router.push({ pathname: '/barber/hours/[id]', params: { id: b.id } })}
          />
        </Row>
      ))}
      <T variant="small">{t('Closed on some days, or a break for Friday prayers? Tap Change.')}</T>
      <Button title={t('Looks right')} variant="secondary" onPress={onConfirm} />
    </View>
  );
}

const styles = StyleSheet.create({
  list: { gap: Spacing.sm },
  dayHeader: { gap: Spacing.xs },
  noWrap: { flexWrap: 'nowrap' },
  badges: { gap: Spacing.xs },
  cardRow: { flexDirection: 'row', gap: Spacing.sm },
  compactRow: { flexDirection: 'row', alignItems: 'center', gap: Spacing.sm, minHeight: 48 },
  compactCard: { paddingVertical: Spacing.sm },
  // Fixed, so the start times line up down the day.
  timeCol: { width: 92 },
  time: { fontSize: 16, lineHeight: 22 },
  info: { flex: 1, gap: 2 },
  fold: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', minHeight: 48 },
  hoursCheck: { gap: Spacing.sm, paddingLeft: Spacing.lg },
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
  undoBar: {
    flex: 1,
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
  fab: { borderRadius: Radius.md, boxShadow: '0 2px 8px rgba(0, 0, 0, 0.25)' },
  fabSpace: { height: 48 },
});
