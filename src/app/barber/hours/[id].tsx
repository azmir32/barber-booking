import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { View } from 'react-native';

import { TimeField } from '@/components/time-field';
import { Button, Chip, ErrorText, Field, Loading, Row, Screen, T } from '@/components/ui';
import { Spacing } from '@/constants/theme';
import { t } from '@/lib/lang';
import { useMyShop } from '@/lib/my-shop';
import { errorMessage, supabase } from '@/lib/supabase';
import { dayPlanFrom, rangesFromPlan, WEEK_ORDER, type DayPlan } from '@/lib/hours';
import { WEEKDAYS, type Barber, type WorkingHours } from '@/lib/types';

type BarberWithHours = Pick<Barber, 'id' | 'name'> & { working_hours: WorkingHours[] };

/** A barber's saved hours as the editor's seven days, Sunday first like WEEKDAYS. */
const weekFrom = (hours: WorkingHours[]) =>
  WEEKDAYS.map((_, weekday) => dayPlanFrom(hours.filter((h) => h.weekday === weekday)));

export default function Hours() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { shop } = useMyShop();
  const shopId = shop?.id;
  const [name, setName] = useState('');
  const [week, setWeek] = useState<DayPlan[] | null>(null);
  // The shop's other barbers with hours set, to copy from.
  const [others, setOthers] = useState<BarberWithHours[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!shopId) return;
    (async () => {
      const { data, error } = await supabase
        .from('barbers')
        .select('id, name, working_hours(*)')
        .eq('shop_id', shopId)
        .order('sort_order')
        .order('created_at');
      if (error) return setError(errorMessage(error));
      const barbers = (data ?? []) as BarberWithHours[];
      const barber = barbers.find((b) => b.id === id);
      if (!barber) return setError(t('Barber not found.'));
      setName(barber.name);
      setWeek(weekFrom(barber.working_hours ?? []));
      setOthers(barbers.filter((b) => b.id !== id && b.working_hours?.length));
    })();
  }, [id, shopId]);

  function update(weekday: number, patch: Partial<DayPlan>) {
    setWeek((w) => w && w.map((d, i) => (i === weekday ? { ...d, ...patch } : d)));
  }

  // Most barbers keep the same hours all week: copy Monday's times to every
  // open day. A day's own break (like Friday prayers) is never overwritten;
  // Monday's break only goes to days without one.
  function copyMondayToAll() {
    setWeek(
      (w) =>
        w &&
        w.map((d, weekday) => {
          const mon = w[1];
          if (weekday === 1 || !d.open) return d;
          const times = { ...d, opens: mon.opens, closes: mon.closes };
          return d.hasBreak || !mon.hasBreak
            ? times
            : { ...times, hasBreak: true, breakFrom: mon.breakFrom, breakTo: mon.breakTo };
        }),
    );
  }

  async function save() {
    if (!week) return;
    const rows = [];
    for (const weekday of WEEK_ORDER) {
      const ranges = rangesFromPlan(week[weekday]);
      if (typeof ranges === 'string') return setError(`${t(WEEKDAYS[weekday])}: ${ranges}`);
      rows.push(...ranges.map((r) => ({ weekday, ...r })));
    }
    setBusy(true);
    setError(null);
    const nameUpdate = await supabase.from('barbers').update({ name: name.trim() }).eq('id', id);
    const hours = await supabase.rpc('set_barber_hours', { p_barber_id: id, p_hours: rows });
    setBusy(false);
    const failed = nameUpdate.error || hours.error;
    if (failed) return setError(errorMessage(failed));
    router.back();
  }

  if (!week) return error ? <Screen><ErrorText message={error} /></Screen> : <Loading />;

  return (
    <Screen edges={[]}>
      <Field label={t('Barber name')} value={name} onChangeText={setName} maxLength={40} />
      {others.length ? (
        // A new barber usually works the same hours as someone already set up.
        <View style={{ gap: Spacing.sm }}>
          <T variant="label">{t('Copy hours from')}</T>
          <Row>
            {others.map((b) => (
              <Chip
                key={b.id}
                label={b.name}
                accessibilityLabel={t('Copy hours from {name}', { name: b.name })}
                onPress={() => setWeek(weekFrom(b.working_hours))}
              />
            ))}
          </Row>
        </View>
      ) : null}
      {week[1].open ? (
        <View style={{ gap: Spacing.xs }}>
          <Button title={t('Copy Monday’s hours to all open days')} variant="secondary" onPress={copyMondayToAll} />
          <T variant="small">{t('Days with their own break, like Friday prayers, keep it.')}</T>
        </View>
      ) : null}
      {WEEK_ORDER.map((weekday) => {
        const d = week[weekday];
        // Break times are picked from inside the day's hours, so the list is short.
        const withinDay = d.opens < d.closes ? { from: d.opens, to: d.closes } : {};
        return (
          <View key={weekday} role="group" aria-label={t(WEEKDAYS[weekday])} style={{ gap: Spacing.sm }}>
            <Row style={{ justifyContent: 'space-between' }}>
              <T variant="label">{t(WEEKDAYS[weekday])}</T>
              <Row role="radiogroup" accessibilityLabel={t(WEEKDAYS[weekday])}>
                <Chip label={t('Open')} selected={d.open} onPress={() => update(weekday, { open: true })} />
                <Chip label={t('Off')} selected={!d.open} onPress={() => update(weekday, { open: false })} />
              </Row>
            </Row>
            {d.open ? (
              <Row style={{ flexWrap: 'nowrap' }}>
                <View style={{ flex: 1 }}>
                  <TimeField label={t('From')} value={d.opens} onChange={(v) => update(weekday, { opens: v })} />
                </View>
                <View style={{ flex: 1 }}>
                  <TimeField label={t('To')} value={d.closes} onChange={(v) => update(weekday, { closes: v })} />
                </View>
              </Row>
            ) : null}
            {d.open && d.hasBreak ? (
              <Row style={{ flexWrap: 'nowrap' }}>
                <View style={{ flex: 1 }}>
                  <TimeField
                    label={t('Break from')}
                    value={d.breakFrom}
                    onChange={(v) => update(weekday, { breakFrom: v })}
                    {...withinDay}
                  />
                </View>
                <View style={{ flex: 1 }}>
                  <TimeField
                    label={t('Break to')}
                    value={d.breakTo}
                    onChange={(v) => update(weekday, { breakTo: v })}
                    {...withinDay}
                  />
                </View>
              </Row>
            ) : null}
            {d.open ? (
              <Button
                title={
                  d.hasBreak ? t('Remove break') : weekday === 5 ? t('+ Add break (e.g. Friday prayers)') : t('+ Add break')
                }
                variant="ghost"
                style={{ alignSelf: 'flex-start' }}
                onPress={() => update(weekday, { hasBreak: !d.hasBreak })}
              />
            ) : null}
          </View>
        );
      })}
      <ErrorText message={error} />
      <Button title={t('Save hours')} onPress={save} loading={busy} disabled={!name.trim()} />
      <Button title={t('Cancel')} variant="ghost" onPress={() => router.back()} />
    </Screen>
  );
}
