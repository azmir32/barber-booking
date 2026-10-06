import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { View } from 'react-native';

import { Button, Chip, ErrorText, Field, Loading, Row, Screen, T } from '@/components/ui';
import { Spacing } from '@/constants/theme';
import { t } from '@/lib/lang';
import { errorMessage, supabase } from '@/lib/supabase';
import { dayPlanFrom, rangesFromPlan, WEEK_ORDER, type DayPlan } from '@/lib/hours';
import { WEEKDAYS, type WorkingHours } from '@/lib/types';

export default function Hours() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const [name, setName] = useState('');
  const [week, setWeek] = useState<DayPlan[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      const { data, error } = await supabase.from('barbers').select('name, working_hours(*)').eq('id', id).single();
      if (error) return setError(errorMessage(error));
      const hours = (data.working_hours ?? []) as WorkingHours[];
      setName(data.name);
      setWeek(WEEKDAYS.map((_, weekday) => dayPlanFrom(hours.filter((h) => h.weekday === weekday))));
    })();
  }, [id]);

  function update(weekday: number, patch: Partial<DayPlan>) {
    setWeek((w) => w && w.map((d, i) => (i === weekday ? { ...d, ...patch } : d)));
  }

  // Most barbers keep the same hours all week: copy Monday (and its break)
  // to every open day.
  function copyMondayToAll() {
    setWeek((w) => w && w.map((d, weekday) => (weekday === 1 || !d.open ? d : { ...w[1] })));
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
      {week[1].open ? (
        <Button title={t('Copy Monday’s hours to all open days')} variant="secondary" onPress={copyMondayToAll} />
      ) : null}
      {WEEK_ORDER.map((weekday) => {
        const d = week[weekday];
        return (
          <View key={weekday} style={{ gap: Spacing.sm }}>
            <Row style={{ justifyContent: 'space-between' }}>
              <T variant="label">{t(WEEKDAYS[weekday])}</T>
              <Row>
                <Chip label={t('Open')} selected={d.open} onPress={() => update(weekday, { open: true })} />
                <Chip label={t('Off')} selected={!d.open} onPress={() => update(weekday, { open: false })} />
              </Row>
            </Row>
            {d.open ? (
              <Row style={{ flexWrap: 'nowrap' }}>
                <View style={{ flex: 1 }}>
                  <Field label={t('From')} value={d.opens} onChangeText={(v) => update(weekday, { opens: v })} placeholder="10:00" />
                </View>
                <View style={{ flex: 1 }}>
                  <Field label={t('To')} value={d.closes} onChangeText={(v) => update(weekday, { closes: v })} placeholder="20:00" />
                </View>
              </Row>
            ) : null}
            {d.open && d.hasBreak ? (
              <Row style={{ flexWrap: 'nowrap', alignItems: 'flex-end' }}>
                <View style={{ flex: 1 }}>
                  <Field label={t('Break from')} value={d.breakFrom} onChangeText={(v) => update(weekday, { breakFrom: v })} placeholder="13:00" />
                </View>
                <View style={{ flex: 1 }}>
                  <Field label={t('Break to')} value={d.breakTo} onChangeText={(v) => update(weekday, { breakTo: v })} placeholder="14:00" />
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
      <T variant="small">{t('Use 24-hour time, e.g. 21:30 for 9:30pm.')}</T>
      <ErrorText message={error} />
      <Button title={t('Save hours')} onPress={save} loading={busy} disabled={!name.trim()} />
      <Button title={t('Cancel')} variant="ghost" onPress={() => router.back()} />
    </Screen>
  );
}
