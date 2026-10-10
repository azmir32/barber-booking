import Ionicons from '@expo/vector-icons/Ionicons';
import { router, useFocusEffect } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import { Linking, Platform, StyleSheet, View } from 'react-native';

import { DayPicker } from '@/components/day-picker';
import { Button, Card, Chip, ErrorText, Field, IconButton, Row, Screen, Section, T } from '@/components/ui';
import { Spacing } from '@/constants/theme';
import { useNow } from '@/hooks/use-now';
import { useTheme } from '@/hooks/use-theme';
import { dateRange } from '@/lib/closures';
import { confirmAction } from '@/lib/confirm';
import { WALK_IN } from '@/lib/customers';
import { t } from '@/lib/lang';
import { useMyShop } from '@/lib/my-shop';
import { whatsappUrl } from '@/lib/phone';
import { errorMessage, supabase } from '@/lib/supabase';
import {
  addDays,
  dayBounds,
  DEFAULT_TIME_ZONE,
  formatDay,
  formatTime,
  localDateString,
  upcomingDays,
} from '@/lib/time';
import type { Booking } from '@/lib/types';

const LENGTHS = [1, 2, 3, 4, 5, 7, 10, 14];
// Customers can book 60 days ahead, so there is no point closing further out.
const DAYS_SHOWN = 60;

/** A customer still to come, as this screen lists them. */
type ToCome = Pick<Booking, 'id' | 'starts_at' | 'ends_at' | 'service_name' | 'guest_name' | 'guest_phone'> & {
  barbers: { name: string } | null;
  customer: { full_name: string; phone: string | null } | null;
};

const whoFor = (b: ToCome) =>
  b.customer?.full_name || (b.guest_name === WALK_IN ? t('Walk-in') : b.guest_name) || t('Customer');
const phoneOf = (b: ToCome) => b.customer?.phone ?? b.guest_phone;
const openWhatsApp = (phone: string, message: string) => Linking.openURL(whatsappUrl(phone, message)).catch(() => {});

/** The database's refusal names how many bookings are in the way and the first day; this says it in the app's words. */
function closeError(error: { message?: string }): string {
  const m = /^There are bookings on those days \((\d+), the first on (\d{4}-\d{2}-\d{2})\)/.exec(error.message ?? '');
  if (!m) return errorMessage(error);
  const day = dateRange(m[2], m[2]);
  return m[1] === '1'
    ? t('There is a booking on {day}. Cancel it first, then close the shop.', { day })
    : t('There are {count} bookings on those days, the first on {day}. Cancel them first, then close the shop.', {
        count: m[1],
        day,
      });
}

/** Close the whole shop for a run of days, e.g. Hari Raya: every barber gets the days off. */
export default function CloseDays() {
  const { shop } = useMyShop();
  const theme = useTheme();
  const now = useNow();
  const tz = shop?.time_zone ?? DEFAULT_TIME_ZONE;
  const days = useMemo(() => upcomingDays(DAYS_SHOWN, tz), [tz]);
  const [from, setFrom] = useState<string | null>(null);
  const [count, setCount] = useState(1);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Customers still to come over the days on show, so the days with bookings say so.
  const [toCome, setToCome] = useState<ToCome[]>([]);
  // Cancelled here, so their customers can still be told after.
  const [cancelled, setCancelled] = useState<ToCome[]>([]);
  const [cancelling, setCancelling] = useState<string | null>(null);
  const shopId = shop?.id;

  const load = useCallback(async () => {
    if (!shopId) return;
    const today = localDateString(new Date(), tz);
    const { data, error } = await supabase
      .from('bookings')
      .select(
        'id, starts_at, ends_at, service_name, guest_name, guest_phone, barbers(name), customer:profiles!bookings_customer_id_fkey(full_name, phone)',
      )
      .eq('shop_id', shopId)
      .eq('status', 'confirmed')
      .eq('is_block', false)
      .gt('ends_at', new Date().toISOString())
      .lt('starts_at', dayBounds(addDays(today, DAYS_SHOWN + LENGTHS[LENGTHS.length - 1]), tz).start.toISOString())
      .order('starts_at');
    // Without the list, closing still works: the database refuses over a booking and says so.
    if (error) return;
    // The client can't tell that the customer is one profile rather than a list.
    setToCome((data ?? []) as unknown as ToCome[]);
  }, [shopId, tz]);

  // On focus, so bookings cancelled on the Bookings tab drop off when coming back.
  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  const booked = useMemo(() => {
    const perDay: Record<string, number> = {};
    for (const b of toCome) {
      const day = localDateString(new Date(b.starts_at), tz);
      perDay[day] = (perDay[day] ?? 0) + 1;
    }
    return Object.fromEntries(
      Object.entries(perDay).map(([day, n]) => [day, n === 1 ? t('1 booked') : t('{count} booked', { count: n })]),
    );
  }, [toCome, tz]);

  if (!shop) return null;
  const daysText = (n: number) => (n === 1 ? t('1 day') : t('{count} days', { count: n }));
  // As the database counts them: anyone still to come who overlaps the days.
  const range = from
    ? { start: dayBounds(from, tz).start.getTime(), end: dayBounds(addDays(from, count), tz).start.getTime() }
    : null;
  const inRange = (b: ToCome) =>
    range != null && Date.parse(b.starts_at) < range.end && Date.parse(b.ends_at) > range.start;
  const inTheWay = toCome.filter((b) => inRange(b) && Date.parse(b.ends_at) > now);
  const told = cancelled.filter(inRange);

  const sorry = (b: ToCome) => {
    const phone = phoneOf(b);
    if (!phone) return;
    openWhatsApp(
      phone,
      t(
        'Hi {who}, sorry, {shop} has to cancel your {service} on {day} at {time}. Reply here and we will find you another time.',
        {
          who: whoFor(b),
          shop: shop.name,
          service: b.service_name,
          day: formatDay(b.starts_at, tz),
          time: formatTime(b.starts_at, tz),
        },
      ),
    );
  };

  async function cancel(b: ToCome) {
    const phone = phoneOf(b);
    const when = { who: whoFor(b), service: b.service_name, day: formatDay(b.starts_at, tz), time: formatTime(b.starts_at, tz) };
    const ok = await confirmAction(
      t('Cancel this booking?'),
      phone
        ? t('{who} · {service} on {day} at {time}. Let them know on WhatsApp.', when)
        : t('{who} · {service} on {day} at {time}.', when),
      phone ? t('Cancel and WhatsApp') : t('Cancel booking'),
    );
    if (!ok) return;
    setCancelling(b.id);
    const { error } = await supabase.rpc('set_booking_status', { p_booking_id: b.id, p_status: 'cancelled' });
    setCancelling(null);
    if (error) {
      setError(errorMessage(error));
      return load();
    }
    setError(null);
    setToCome((all) => all.filter((x) => x.id !== b.id));
    setCancelled((all) => [...all, b]);
    // Browsers block a new tab that isn't opened by a tap, and the cancel took a round trip,
    // so on the web the row's WhatsApp button does it.
    if (Platform.OS !== 'web') sorry(b);
  }

  async function save() {
    if (!from) return;
    setBusy(true);
    setError(null);
    const { error } = await supabase.rpc('close_shop_days', { p_from: from, p_days: count, p_reason: reason });
    setBusy(false);
    if (error) {
      setError(closeError(error));
      // Someone booked meanwhile: show who.
      return load();
    }
    router.back();
  }

  const closing = from ? dateRange(from, addDays(from, count - 1)) : null;

  return (
    <Screen
      edges={[]}
      onRefresh={load}
      footer={
        <>
          {closing ? (
            inTheWay.length > 0 ? (
              <T variant="label" style={{ color: theme.warning }}>
                {inTheWay.length === 1
                  ? t('Cancel the booking on these days first.')
                  : t('Cancel the {count} bookings on these days first.', { count: inTheWay.length })}
              </T>
            ) : (
              <T variant="label">{t('You’ll be closed {days}', { days: closing })}</T>
            )
          ) : null}
          <ErrorText message={error} />
          <Button
            title={!from ? t('Pick the first day') : count === 1 ? t('Close for 1 day') : t('Close for {count} days', { count })}
            onPress={save}
            loading={busy}
            disabled={!from || inTheWay.length > 0}
          />
        </>
      }>
      <T variant="muted">
        {t('Every barber gets these days off, and customers see them as closed. Cancel any bookings on them first.')}
      </T>
      <Section title={t('First day')}>
        <DayPicker days={days} selected={from} onSelect={setFrom} notes={booked} />
      </Section>
      <Section title={t('How many days')}>
        <Row role="radiogroup" accessibilityLabel={t('How many days')}>
          {LENGTHS.map((n) => (
            <Chip key={n} label={daysText(n)} selected={count === n} onPress={() => setCount(n)} />
          ))}
        </Row>
      </Section>

      {inTheWay.length > 0 || told.length > 0 ? (
        <Card style={{ borderColor: theme.warning }}>
          <View style={styles.titleRow}>
            <Ionicons name="warning-outline" size={22} color={theme.warning} />
            <T variant="heading" style={styles.grow}>
              {inTheWay.length === 0
                ? t('Bookings cancelled')
                : inTheWay.length === 1
                  ? t('1 booking on these days')
                  : t('{count} bookings on these days', { count: inTheWay.length })}
            </T>
          </View>
          <T variant="muted">
            {inTheWay.length > 0
              ? t('Cancel them and let each customer know on WhatsApp, then close the shop.')
              : t('Let each customer know on WhatsApp if you haven’t yet.')}
          </T>
          {inTheWay.map((b) => {
            const who = whoFor(b);
            const phone = phoneOf(b);
            return (
              <View key={b.id} style={[styles.booking, { borderColor: theme.border }]}>
                <View style={styles.bookingTop}>
                  <BookingInfo booking={b} tz={tz} who={who} />
                  {phone ? (
                    <IconButton
                      icon="logo-whatsapp"
                      label={t('WhatsApp {name}', { name: who })}
                      variant="ghost"
                      color={theme.success}
                      onPress={() =>
                        openWhatsApp(
                          phone,
                          t('Hi {who}, this is {shop} about your {service} on {day} at {time}.', {
                            who,
                            shop: shop.name,
                            service: b.service_name,
                            day: formatDay(b.starts_at, tz),
                            time: formatTime(b.starts_at, tz),
                          }),
                        )
                      }
                    />
                  ) : null}
                </View>
                <Button
                  title={t('Cancel booking')}
                  accessibilityLabel={t('Cancel {name}’s booking on {day}', { name: who, day: formatDay(b.starts_at, tz) })}
                  variant="secondary"
                  tone="danger"
                  loading={cancelling === b.id}
                  onPress={() => cancel(b)}
                  style={styles.rowAction}
                />
              </View>
            );
          })}
          {told.map((b) => {
            const who = whoFor(b);
            return (
              <View key={b.id} style={[styles.booking, { borderColor: theme.border }]}>
                <BookingInfo booking={b} tz={tz} who={who} cancelled />
                {phoneOf(b) ? (
                  <Button
                    title={t('Let them know')}
                    accessibilityLabel={t('WhatsApp {name}', { name: who })}
                    icon="logo-whatsapp"
                    iconColor={theme.success}
                    variant="secondary"
                    onPress={() => sorry(b)}
                    style={styles.rowAction}
                  />
                ) : null}
              </View>
            );
          })}
        </Card>
      ) : null}

      <Field
        label={t('Reason (optional)')}
        value={reason}
        onChangeText={setReason}
        placeholder={t('e.g. Hari Raya, day off')}
        maxLength={80}
      />
      <T variant="small">{t('Only you see the reason.')}</T>
    </Screen>
  );
}

/** When, who, what and with which barber. */
function BookingInfo({ booking: b, tz, who, cancelled }: { booking: ToCome; tz: string; who: string; cancelled?: boolean }) {
  return (
    <View style={styles.grow}>
      <T variant="label">
        {/* Non-breaking spaces, so "pm" never wraps onto a line of its own. */}
        {formatDay(b.starts_at, tz)} · {formatTime(b.starts_at, tz).replace(/ /g, '\u00a0')}
      </T>
      <T variant="small">
        {[who, b.service_name, b.barbers?.name, cancelled ? t('Cancelled') : null].filter(Boolean).join(' · ')}
      </T>
    </View>
  );
}

const styles = StyleSheet.create({
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: Spacing.sm },
  grow: { flex: 1 },
  booking: { gap: Spacing.xs, borderTopWidth: StyleSheet.hairlineWidth, paddingTop: Spacing.sm },
  bookingTop: { flexDirection: 'row', alignItems: 'center', gap: Spacing.sm },
  rowAction: { alignSelf: 'flex-start' },
});
