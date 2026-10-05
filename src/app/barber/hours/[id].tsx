import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { View } from 'react-native';

import { Button, Chip, ErrorText, Field, Loading, Row, Screen, T } from '@/components/ui';
import { Spacing } from '@/constants/theme';
import { errorMessage, supabase } from '@/lib/supabase';
import { normalizeTime } from '@/lib/time';
import { WEEKDAYS, type WorkingHours } from '@/lib/types';

type DayHours = { open: boolean; opens: string; closes: string };

// Monday first, the way most people read a week.
const ORDER = [1, 2, 3, 4, 5, 6, 0];

export default function Hours() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const [name, setName] = useState('');
  const [week, setWeek] = useState<DayHours[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      const { data, error } = await supabase.from('barbers').select('name, working_hours(*)').eq('id', id).single();
      if (error) return setError(errorMessage(error));
      const hours = (data.working_hours ?? []) as WorkingHours[];
      setName(data.name);
      setWeek(
        WEEKDAYS.map((_, weekday) => {
          const h = hours.find((x) => x.weekday === weekday);
          return h
            ? { open: true, opens: h.opens_at.slice(0, 5), closes: h.closes_at.slice(0, 5) }
            : { open: false, opens: '10:00', closes: '20:00' };
        }),
      );
    })();
  }, [id]);

  function update(weekday: number, patch: Partial<DayHours>) {
    setWeek((w) => w && w.map((d, i) => (i === weekday ? { ...d, ...patch } : d)));
  }

  async function save() {
    if (!week) return;
    const rows = [];
    for (const weekday of ORDER) {
      const d = week[weekday];
      if (!d.open) continue;
      const opens = normalizeTime(d.opens);
      const closes = normalizeTime(d.closes);
      if (!opens || !closes) return setError(`${WEEKDAYS[weekday]}: use times like 09:00 or 21:30.`);
      if (closes <= opens) return setError(`${WEEKDAYS[weekday]}: closing time must be after opening time.`);
      rows.push({ weekday, opens_at: opens, closes_at: closes });
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
      <Field label="Barber name" value={name} onChangeText={setName} />
      {ORDER.map((weekday) => {
        const d = week[weekday];
        return (
          <View key={weekday} style={{ gap: Spacing.sm }}>
            <Row style={{ justifyContent: 'space-between' }}>
              <T variant="label">{WEEKDAYS[weekday]}</T>
              <Row>
                <Chip label="Open" selected={d.open} onPress={() => update(weekday, { open: true })} />
                <Chip label="Off" selected={!d.open} onPress={() => update(weekday, { open: false })} />
              </Row>
            </Row>
            {d.open ? (
              <Row style={{ flexWrap: 'nowrap' }}>
                <View style={{ flex: 1 }}>
                  <Field label="From" value={d.opens} onChangeText={(v) => update(weekday, { opens: v })} placeholder="10:00" />
                </View>
                <View style={{ flex: 1 }}>
                  <Field label="To" value={d.closes} onChangeText={(v) => update(weekday, { closes: v })} placeholder="20:00" />
                </View>
              </Row>
            ) : null}
          </View>
        );
      })}
      <T variant="small">Use 24-hour time, e.g. 21:30 for 9:30pm.</T>
      <ErrorText message={error} />
      <Button title="Save hours" onPress={save} loading={busy} disabled={!name.trim()} />
      <Button title="Cancel" variant="ghost" onPress={() => router.back()} />
    </Screen>
  );
}
