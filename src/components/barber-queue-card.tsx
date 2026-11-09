// Today's walk-in queue on the barber's Bookings tab: who is waiting in
// order, calling them, starting their cut as a booking, and taking off
// someone who didn't come.

import { router } from 'expo-router';
import { useState } from 'react';
import { Linking, StyleSheet, View } from 'react-native';

import { Badge, Button, Card, Chip, ErrorText, Row, T } from '@/components/ui';
import { Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { confirmAction } from '@/lib/confirm';
import { t } from '@/lib/lang';
import { whatsappUrl } from '@/lib/phone';
import {
  barbersInNow,
  callMessage,
  clashFor,
  firstFree,
  freeText,
  nextInToday,
  queuedFor,
  queuedStatus,
  startError,
  type Queued,
} from '@/lib/queue';
import { errorMessage, supabase } from '@/lib/supabase';
import { useBigText } from '@/lib/text-size-provider';
import { formatDuration, formatPrice, noBreak } from '@/lib/time';
import type { Barber, Booking, Service, WorkingHours } from '@/lib/types';

type DayBarber = Pick<Barber, 'id' | 'name' | 'is_active'> & {
  working_hours: Pick<WorkingHours, 'weekday' | 'opens_at' | 'closes_at'>[];
};
type DayBooking = Pick<Booking, 'barber_id' | 'starts_at' | 'ends_at' | 'status' | 'is_block'>;
type MenuItem = Pick<Service, 'id' | 'name' | 'duration_min' | 'price'>;
/** Start's choices for one person, open under their row. */
type Picking = { id: string; barberId: string | null; serviceId: string | null };

export function BarberQueueCard({
  shop,
  list,
  shown,
  barbers,
  bookings,
  closed,
  tz,
  now,
  held,
  reload,
  onNotice,
}: {
  shop: { id: string; name: string; queue_enabled: boolean };
  /** The whole queue in order, for each one's place. */
  list: Queued[];
  /** The ones this phone shows: asked for the barber it shows, or any barber. */
  shown: Queued[];
  barbers: DayBarber[];
  /** Today's bookings, for who is in now and who is free. */
  bookings: DayBooking[];
  closed: boolean;
  tz: string;
  now: number;
  /** Set while the day on screen is last visit's: nothing changes until the server's arrives. */
  held: { disabled: boolean } | null;
  reload: () => Promise<unknown>;
  onNotice: (message: string) => void;
}) {
  const theme = useTheme();
  const big = useBigText();
  const [picking, setPicking] = useState<Picking | null>(null);
  const [menu, setMenu] = useState<MenuItem[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<{ id: string | null; message: string } | null>(null);
  const inNow = barbersInNow(barbers, bookings, now, tz, closed);
  // Start can take anyone working today: those in now come first, and past
  // closing (or with everyone on a break) the rest serve who is left.
  const today = barbersInNow(barbers, bookings, now, tz, closed, true);
  const pool = inNow.length ? inNow : today;

  const nameOf = (q: Queued) => q.name || t('Customer');

  /** WhatsApp first, while the tap still counts (browsers block a new tab after a round trip). */
  async function call(q: Queued) {
    if (q.phone) Linking.openURL(whatsappUrl(q.phone, callMessage(q.name, shop.name))).catch(() => {});
    setBusy(q.id);
    setError(null);
    const { error: failed } = await supabase.rpc('call_from_queue', { p_id: q.id });
    await reload();
    setBusy(null);
    if (failed) return setError({ id: q.id, message: errorMessage(failed) });
    if (!q.phone) {
      onNotice(
        q.online
          ? t('Called {name}. Their phone now says it’s their turn.', { name: nameOf(q) })
          : t('Called {name}.', { name: nameOf(q) }),
      );
    }
  }

  function openStart(q: Queued) {
    if (picking?.id === q.id) return setPicking(null);
    setError(null);
    // Someone added without a service needs one picked, from the shop's menu.
    if (!q.service_id && !menu) {
      supabase
        .from('services')
        .select('id, name, duration_min, price')
        .eq('shop_id', shop.id)
        .eq('is_active', true)
        .order('sort_order')
        .order('name')
        .then(({ data, error: failed }) => {
          if (failed) setError({ id: q.id, message: errorMessage(failed) });
          else setMenu((data ?? []) as MenuItem[]);
        });
    }
    const minutes = q.duration_min ?? 30;
    setPicking({ id: q.id, barberId: firstFree(pool, q.barber_id, minutes, bookings, now)?.id ?? null, serviceId: null });
  }

  async function start(q: Queued, pick: Picking) {
    const barber = today.find((b) => b.id === pick.barberId);
    if (!barber) return;
    setBusy(q.id);
    setError(null);
    const { error: failed } = await supabase.rpc('start_from_queue', {
      p_id: q.id,
      p_barber_id: barber.id,
      p_service_id: q.service_id ? null : pick.serviceId,
    });
    await reload();
    setBusy(null);
    if (failed) return setError({ id: q.id, message: startError(failed, tz) ?? errorMessage(failed) });
    setPicking(null);
    onNotice(t('{name} is in {barber}’s chair.', { name: nameOf(q), barber: barber.name }));
  }

  async function remove(q: Queued) {
    const ok = await confirmAction(
      t('Take {name} off the queue?', { name: nameOf(q) }),
      t('If they come back, they join at the end.'),
      t('Not here'),
    );
    if (!ok) return;
    setBusy(q.id);
    setError(null);
    const { error: failed } = await supabase.rpc('remove_from_queue', { p_id: q.id });
    await reload();
    setBusy(null);
    if (failed) setError({ id: q.id, message: errorMessage(failed) });
  }

  return (
    <Card style={styles.card}>
      <T variant="heading" style={styles.heading}>
        {t('Queue ({count})', { count: shown.length })}
      </T>
      {!shop.queue_enabled ? (
        <T variant="small">{t('The queue is off, so nobody new can join. Turn it on in My shop.')}</T>
      ) : shown.length === 0 ? (
        <T variant="small">
          {list.length > 0
            ? t('Nobody waiting for this barber.')
            : t('Nobody waiting. Customers join from your shop’s page while you’re open.')}
        </T>
      ) : null}

      {shown.map((q) => {
        const place = list.findIndex((x) => x.id === q.id) + 1;
        const name = nameOf(q);
        const open = picking?.id === q.id ? picking : null;
        const service = q.service_id ? null : (menu?.find((s) => s.id === open?.serviceId) ?? null);
        const minutes = q.duration_min ?? service?.duration_min ?? 30;
        const called = q.state === 'called';
        // The next thing to do stands out: calling the first in line, or starting someone called.
        const callFirst = !called && place === 1;
        const rowError = error && error.id === q.id ? error.message : null;
        const notHere = (
          <Button
            title={t('Not here')}
            accessibilityLabel={t('Take {name} off the queue', { name })}
            variant="ghost"
            tone="danger"
            style={big ? styles.action : undefined}
            onPress={() => remove(q)}
          />
        );
        return (
          <View key={q.id} style={[styles.row, { borderTopColor: theme.border }]}>
            <View style={styles.head}>
              <View style={styles.info}>
                <View style={styles.nameLine}>
                  {/* One line keeps a row short; with big text the whole name comes first. */}
                  <T variant="label" numberOfLines={big ? undefined : 1} style={styles.name}>
                    {`${place}. ${name}`}
                  </T>
                  {q.online ? <Badge label={t('Joined online')} /> : null}
                </View>
                <T variant="small">{queuedFor(q)}</T>
                <T variant="small" style={called ? { color: theme.success } : undefined}>
                  {queuedStatus(q, now, tz)}
                </T>
              </View>
              {/* Beside the name, so Call in and Start keep a line of their own; with big text it goes under them. */}
              {big ? null : notHere}
            </View>
            <Row>
              <Button
                title={called ? t('Call again') : t('Call in')}
                accessibilityLabel={called ? t('Call {name} again', { name }) : t('Call {name} in', { name })}
                // Their number is there, so it opens WhatsApp too.
                icon={q.phone ? 'logo-whatsapp' : undefined}
                iconColor={callFirst ? undefined : theme.success}
                variant={callFirst ? 'primary' : 'secondary'}
                style={styles.action}
                loading={busy === q.id && !open}
                {...held}
                onPress={() => call(q)}
              />
              <Button
                title={t('Start')}
                accessibilityLabel={t('Start {name}’s cut', { name })}
                variant={called ? 'primary' : 'secondary'}
                style={styles.action}
                {...held}
                onPress={() => openStart(q)}
              />
              {big ? notHere : null}
            </Row>

            {open ? (
              <View style={styles.picker}>
                {q.service_id ? null : (
                  <View style={styles.pickGroup}>
                    <T variant="label">{t('Service')}</T>
                    {menu ? (
                      <Row role="radiogroup" accessibilityLabel={t('Service')}>
                        {menu.map((s) => (
                          <Chip
                            key={s.id}
                            label={s.name}
                            sublabel={`${formatDuration(s.duration_min)} · ${formatPrice(s.price)}`}
                            selected={open.serviceId === s.id}
                            onPress={() =>
                              setPicking({
                                ...open,
                                serviceId: s.id,
                                // A longer cut may no longer fit the barber picked first.
                                barberId: firstFree(pool, q.barber_id, s.duration_min, bookings, now)?.id ?? null,
                              })
                            }
                          />
                        ))}
                      </Row>
                    ) : null}
                  </View>
                )}
                <View style={styles.pickGroup}>
                  <T variant="label">{t('Barber')}</T>
                  {today.length ? (
                    <Row role="radiogroup" accessibilityLabel={t('Barber')}>
                      {today.map((b) => {
                        // Someone on a break or not started yet says when they are in.
                        const back = inNow.includes(b) ? null : nextInToday([b], now, tz);
                        return (
                          <Chip
                            key={b.id}
                            label={b.name}
                            sublabel={
                              back
                                ? t('In from {time}', { time: noBreak(back.time) })
                                : freeText(clashFor(b.id, minutes, bookings, now), now, tz)
                            }
                            selected={open.barberId === b.id}
                            onPress={() => setPicking({ ...open, barberId: b.id })}
                          />
                        );
                      })}
                    </Row>
                  ) : (
                    <T variant="small">{t('Nobody is working today.')}</T>
                  )}
                </View>
                <ErrorText message={rowError} />
                <Row>
                  <Button
                    title={t('Start the cut')}
                    disabled={!open.barberId || (!q.service_id && !open.serviceId)}
                    loading={busy === q.id}
                    style={styles.action}
                    {...held}
                    onPress={() => start(q, open)}
                  />
                  <Button title={t('Not now')} variant="ghost" style={styles.action} onPress={() => setPicking(null)} />
                </Row>
              </View>
            ) : (
              <ErrorText message={rowError} />
            )}
          </View>
        );
      })}

      {shop.queue_enabled ? (
        <Button title={t('+ Add walk-in')} variant="secondary" onPress={() => router.push('/barber/add-walk-in')} />
      ) : null}
    </Card>
  );
}

const styles = StyleSheet.create({
  card: { gap: Spacing.sm },
  heading: { paddingTop: Spacing.xs },
  row: { gap: Spacing.sm, paddingTop: Spacing.sm, borderTopWidth: StyleSheet.hairlineWidth },
  head: { flexDirection: 'row', alignItems: 'flex-start', gap: Spacing.sm },
  info: { flex: 1, gap: 2 },
  // Wrapping, so with big text the badge goes under a long name rather than squeezing it.
  nameLine: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: Spacing.sm, rowGap: 2 },
  name: { flexShrink: 1 },
  // Call in and Start share the line evenly, and each takes the whole line once they wrap.
  action: { flexGrow: 1 },
  picker: { gap: Spacing.md, paddingTop: Spacing.sm },
  pickGroup: { gap: Spacing.sm },
});
