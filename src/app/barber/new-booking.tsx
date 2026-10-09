import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { View } from 'react-native';

import { TimeField } from '@/components/time-field';
import { Button, Chip, ErrorText, Field, Row, Screen, Section, T } from '@/components/ui';
import { Spacing } from '@/constants/theme';
import { confirmAction } from '@/lib/confirm';
import { WALK_IN } from '@/lib/customers';
import { formatClock } from '@/lib/hours';
import { t } from '@/lib/lang';
import { useMyShop } from '@/lib/my-shop';
import { errorMessage, supabase } from '@/lib/supabase';
import {
  formatDay,
  formatDuration,
  formatPrice,
  formatTime,
  groupByPartOfDay,
  localClock,
  localDateString,
  type PartOfDay,
} from '@/lib/time';
import type { Barber, Service, Slot, WorkingHours } from '@/lib/types';

type Kind = 'booking' | 'block';
type BarberWithHours = Barber & { working_hours: Pick<WorkingHours, 'weekday' | 'opens_at' | 'closes_at'>[] };
const WHOLE_DAY = 24 * 60;
const BLOCK_LENGTHS = [15, 30, 60, 90, 120, 240, WHOLE_DAY];
// "Now" is read when saving, so filling in the name doesn't move the start back.
const NOW = 'now';

/** The barber's hours that day ("10:00 am–8:00 pm") when `clock` falls outside them, else null. */
function hoursIfOutside(barber: BarberWithHours, day: string, clock: string): string | null {
  const weekday = new Date(`${day}T00:00:00Z`).getUTCDay();
  const ranges = barber.working_hours
    .filter((h) => h.weekday === weekday)
    .sort((a, b) => a.opens_at.localeCompare(b.opens_at));
  if (ranges.some((h) => clock >= h.opens_at.slice(0, 5) && clock < h.closes_at.slice(0, 5))) return null;
  if (ranges.length === 0) return t('not working this day');
  return ranges.map((h) => `${formatClock(h.opens_at)}–${formatClock(h.closes_at)}`).join(', ');
}

/** Barber adds a walk-in / WhatsApp / phone booking, or blocks time. */
export default function NewBooking() {
  const { shop } = useMyShop();
  const params = useLocalSearchParams<{ day?: string }>();
  const tz = shop!.time_zone;
  const today = localDateString(new Date(), tz);
  const day = params.day ?? today;

  const [barbers, setBarbers] = useState<BarberWithHours[]>([]);
  const [services, setServices] = useState<Service[]>([]);
  const [kind, setKind] = useState<Kind>('booking');
  const [barberId, setBarberId] = useState<string | null>(null);
  // Blocks only: close the shop, one block per barber.
  const [everyone, setEveryone] = useState(false);
  const [serviceId, setServiceId] = useState<string | null>(null);
  const [blockMinutes, setBlockMinutes] = useState(60);
  const [time, setTime] = useState<string | null>(null); // "HH:MM" or NOW
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Barbers an "Everyone" block already went through for, so trying again only retries the rest.
  const [blocked, setBlocked] = useState<{ key: string; ids: string[] }>({ key: '', ids: [] });

  const [slots, setSlots] = useState<Slot[]>([]);
  const [slotsError, setSlotsError] = useState<string | null>(null);
  // Which request the current `slots` answer; bumping slotsVersion refetches.
  const [slotsFor, setSlotsFor] = useState<string | null>(null);
  const [slotsVersion, setSlotsVersion] = useState(0);
  const [part, setPart] = useState<PartOfDay | null>(null);

  useEffect(() => {
    if (!shop) return;
    Promise.all([
      supabase
        .from('barbers')
        .select('*, working_hours(weekday, opens_at, closes_at)')
        .eq('shop_id', shop.id)
        .eq('is_active', true)
        .order('sort_order')
        .order('name'),
      supabase.from('services').select('*').eq('shop_id', shop.id).eq('is_active', true).order('sort_order').order('name'),
    ]).then(([b, s]) => {
      if (b.error || s.error) return setError(errorMessage(b.error ?? s.error));
      const list = (b.data ?? []) as BarberWithHours[];
      const menu = (s.data ?? []) as Service[];
      setBarbers(list);
      setServices(menu);
      if (list.length) setBarberId((current) => current ?? list[0].id);
      // Most walk-ins are for the first thing on the menu.
      if (menu.length) setServiceId((current) => current ?? menu[0].id);
    });
  }, [shop]);

  // The barber's free start times, the same ones customers see.
  const slotsKey = kind === 'booking' && serviceId && barberId ? `${serviceId}|${barberId}|${slotsVersion}` : null;
  const slotsLoading = slotsKey !== null && slotsKey !== slotsFor;

  useEffect(() => {
    if (!slotsKey) return;
    let active = true;
    supabase
      .rpc('available_slots', { p_service_id: serviceId, p_day: day, p_barber_id: barberId })
      .then(({ data, error }) => {
        if (!active) return;
        setSlotsError(error ? errorMessage(error) : null);
        setSlots((data ?? []) as Slot[]);
        setSlotsFor(slotsKey);
      });
    return () => {
      active = false;
    };
  }, [slotsKey, serviceId, day, barberId]);

  const barber = barbers.find((b) => b.id === barberId);
  const wholeDay = kind === 'block' && blockMinutes === WHOLE_DAY;
  const allBarbers = kind === 'block' && everyone;
  const isToday = day === today;
  const times = slots.map((s) => s.starts_at);
  const freeClocks = times.map((at) => localClock(at, tz));
  const timeGroups = groupByPartOfDay(times, tz);
  const [shownPart, shownTimes] = timeGroups.find(([p]) => p === part) ?? timeGroups[0] ?? [null, []];
  // "Other time" shows the time only when no chip above already does.
  const otherTime = time === NOW || (kind === 'booking' && time && freeClocks.includes(time)) ? null : time;

  function pickKind(next: Kind) {
    setKind(next);
    // A booking's error means nothing on the block form, and the other way round.
    setError(null);
  }

  async function save() {
    if (!allBarbers && !barberId) return setError(t('Pick a barber.'));
    const clock = wholeDay ? '00:00' : time === NOW ? localClock(new Date(), tz, 5) : time;
    if (!clock) return setError(t('Pick a start time.'));
    if (kind === 'booking' && !serviceId) return setError(t('Pick a service.'));
    const minutes = kind === 'block' ? blockMinutes : null;
    const key = `${clock}|${minutes}`;
    const targets = allBarbers
      ? barbers.filter((b) => !(blocked.key === key && blocked.ids.includes(b.id)))
      : barbers.filter((b) => b.id === barberId);
    if (targets.length === 0) return setError(t('Pick a barber.'));

    // Catches a slip like 2:30 am for 2:30 pm, which would leave the real time open online.
    const outside = !wholeDay && !allBarbers ? hoursIfOutside(targets[0], day, clock) : null;
    if (outside) {
      const ok = await confirmAction(
        t('Outside working hours'),
        t('{time} is outside {name}’s hours ({hours}). Add it anyway?', {
          time: formatClock(clock),
          name: targets[0].name,
          hours: outside,
        }),
        t('Add anyway'),
        t('Change time'),
      );
      if (!ok) return;
    }

    setBusy(true);
    setError(null);
    const results = await Promise.all(
      targets.map((b) =>
        supabase.rpc('add_shop_booking', {
          p_barber_id: b.id,
          p_day: day,
          p_time: clock,
          p_duration_min: minutes,
          p_service_id: kind === 'booking' ? serviceId : null,
          // A walk-in's name is optional, but the day view needs something to show.
          p_guest_name: kind === 'booking' ? name.trim() || WALK_IN : null,
          p_guest_phone: kind === 'booking' ? phone : null,
          p_note: note,
          p_is_block: kind === 'block',
        }),
      ),
    );
    setBusy(false);
    const reason = (e: { code?: string }) =>
      wholeDay && e.code === 'P0001'
        ? t('There are bookings on this day. Cancel them first (and let the customers know), then block the day.')
        : errorMessage(e);
    const outcomes = targets.map((b, i) => ({ b, error: results[i].error }));
    const done = outcomes.filter((o) => !o.error).map((o) => o.b);
    const failed = outcomes.flatMap(({ b, error }) => (error ? [{ b, error }] : []));
    if (failed.length === 0) return router.back();
    if (!allBarbers) return setError(reason(failed[0].error));

    setBlocked({ key, ids: [...(blocked.key === key ? blocked.ids : []), ...done.map((b) => b.id)] });
    setError(
      [
        done.length ? t('Blocked for {names}.', { names: done.map((b) => b.name).join(', ') }) : null,
        t('Not blocked:'),
        ...failed.map(({ b, error }) => `${b.name}: ${reason(error)}`),
      ]
        .filter(Boolean)
        .join('\n'),
    );
  }

  const freeTimes = slotsLoading ? (
    <T variant="muted">{t('Checking free times…')}</T>
  ) : slotsError ? (
    <>
      <ErrorText message={`${t('Couldn’t load free times.')} ${slotsError}`} />
      <Button title={t('Try again')} variant="secondary" onPress={() => setSlotsVersion((v) => v + 1)} />
    </>
  ) : timeGroups.length === 0 ? (
    <T variant="muted">{t('{name} has no free times this day.', { name: barber?.name ?? '' })}</T>
  ) : (
    <>
      <T variant="label">{t('Free times for {name}', { name: barber?.name ?? '' })}</T>
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
      <Row role="radiogroup" accessibilityLabel={t('Free times for {name}', { name: barber?.name ?? '' })}>
        {shownTimes.map((at) => (
          <Chip
            key={at}
            label={formatTime(at, tz)}
            selected={time === localClock(at, tz)}
            onPress={() => setTime(localClock(at, tz))}
          />
        ))}
      </Row>
    </>
  );

  return (
    <Screen
      edges={[]}
      footer={
        <>
          <ErrorText message={error} />
          <Button
            title={kind === 'booking' ? t('Add booking') : wholeDay ? t('Block the day') : t('Block time')}
            onPress={save}
            loading={busy}
          />
        </>
      }>
      <T variant="heading">{formatDay(`${day}T12:00:00Z`, 'UTC')}</T>

      <Row role="radiogroup" accessibilityLabel={t('Add')}>
        <Chip label={t('Customer booking')} selected={kind === 'booking'} onPress={() => pickKind('booking')} />
        <Chip label={t('Block time')} selected={kind === 'block'} onPress={() => pickKind('block')} />
      </Row>
      <T variant="small">
        {kind === 'booking'
          ? t('For walk-ins and bookings that came by WhatsApp or phone. Online customers can no longer take this time.')
          : t('For breaks, errands or a day off. Online customers can’t book this time.')}
      </T>

      {barbers.length > 1 ? (
        <Section title={t('Barber')}>
          <Row role="radiogroup" accessibilityLabel={t('Barber')}>
            {kind === 'block' ? (
              <Chip label={t('Everyone (shop closed)')} selected={everyone} onPress={() => setEveryone(true)} />
            ) : null}
            {barbers.map((b) => (
              <Chip
                key={b.id}
                label={b.name}
                selected={!allBarbers && barberId === b.id}
                onPress={() => {
                  setEveryone(false);
                  setBarberId(b.id);
                }}
              />
            ))}
          </Row>
        </Section>
      ) : null}

      {kind === 'booking' ? (
        <Section title={t('Service')}>
          <Row role="radiogroup" accessibilityLabel={t('Service')}>
            {services.map((s) => (
              <Chip
                key={s.id}
                label={s.name}
                sublabel={`${formatDuration(s.duration_min)} · ${formatPrice(s.price)}`}
                selected={serviceId === s.id}
                onPress={() => setServiceId(s.id)}
              />
            ))}
          </Row>
        </Section>
      ) : (
        <Section title={t('How long')}>
          <Row role="radiogroup" accessibilityLabel={t('How long')}>
            {BLOCK_LENGTHS.map((m) => (
              <Chip
                key={m}
                label={m === WHOLE_DAY ? t('Whole day') : formatDuration(m)}
                selected={blockMinutes === m}
                onPress={() => setBlockMinutes(m)}
              />
            ))}
          </Row>
        </Section>
      )}

      {wholeDay ? null : kind === 'block' && !isToday ? (
        <TimeField label={t('Start time')} value={time} onChange={setTime} />
      ) : (
        <Section title={t('Start time')}>
          {isToday ? (
            <Row>
              <Chip
                label={t('Now')}
                sublabel={formatClock(localClock(new Date(), tz, 5))}
                selected={time === NOW}
                onPress={() => setTime(NOW)}
              />
            </Row>
          ) : null}
          {kind === 'booking' && serviceId && barber ? freeTimes : null}
          <TimeField label={t('Other time')} value={otherTime} onChange={setTime} />
        </Section>
      )}

      {kind === 'booking' ? (
        <View style={{ gap: Spacing.lg }}>
          <Field
            label={t('Customer name (optional)')}
            value={name}
            onChangeText={setName}
            placeholder={t('e.g. Pak Abu')}
            maxLength={80}
          />
          <Field
            label={t('Customer phone (optional)')}
            value={phone}
            onChangeText={setPhone}
            keyboardType="phone-pad"
            maxLength={20}
          />
          <Field
            label={t('Note (optional)')}
            value={note}
            onChangeText={setNote}
            placeholder={t('e.g. booked on WhatsApp')}
            maxLength={280}
          />
        </View>
      ) : (
        <Field
          label={t('Reason (optional)')}
          value={note}
          onChangeText={setNote}
          placeholder={wholeDay ? t('e.g. Hari Raya, day off') : t('e.g. lunch, errand')}
          maxLength={80}
        />
      )}
    </Screen>
  );
}
