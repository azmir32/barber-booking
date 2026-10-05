import { router, useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';

import { Button, Card, Empty, ErrorText, Field, Row, Screen, Section, T } from '@/components/ui';
import { addBarber, useMyShop } from '@/lib/my-shop';
import { errorMessage, supabase } from '@/lib/supabase';
import { WEEKDAYS, type Barber, type WorkingHours } from '@/lib/types';

type BarberWithHours = Barber & { working_hours: WorkingHours[] };

/** "Mon–Sat 10:00–20:00" style summary of a barber's week. */
function summarize(hours: WorkingHours[]): string {
  if (hours.length === 0) return 'No hours set, so not bookable';
  const days = [...new Set(hours.map((h) => h.weekday))].sort();
  const ranges = [...new Set(hours.map((h) => `${h.opens_at.slice(0, 5)}–${h.closes_at.slice(0, 5)}`))];
  const consecutive = days.every((d, i) => i === 0 || d === days[i - 1] + 1);
  const dayText =
    days.length === 7
      ? 'Every day'
      : consecutive && days.length > 2
        ? `${WEEKDAYS[days[0]]}–${WEEKDAYS[days[days.length - 1]]}`
        : days.map((d) => WEEKDAYS[d]).join(', ');
  return `${dayText} · ${ranges.length === 1 ? ranges[0] : 'varied hours'}`;
}

export default function Team() {
  const { shop } = useMyShop();
  const [barbers, setBarbers] = useState<BarberWithHours[]>([]);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!shop) return;
    const { data, error } = await supabase
      .from('barbers')
      .select('*, working_hours(*)')
      .eq('shop_id', shop.id)
      .order('sort_order')
      .order('created_at');
    if (error) return setError(errorMessage(error));
    setBarbers((data ?? []) as BarberWithHours[]);
  }, [shop]);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  async function add() {
    if (!shop || !name.trim()) return;
    setBusy(true);
    const { error } = await addBarber(shop.id, name, barbers.length);
    setBusy(false);
    if (error) return setError(errorMessage(error));
    setName('');
    setError(null);
    load();
  }

  async function toggle(b: Barber) {
    const { error } = await supabase.from('barbers').update({ is_active: !b.is_active }).eq('id', b.id);
    if (error) return setError(errorMessage(error));
    load();
  }

  return (
    <Screen>
      <T variant="title">Barbers</T>
      <T variant="muted">One per chair. Customers can pick a barber or take whoever is free.</T>

      <Section title="Your team">
        {barbers.length === 0 ? <Empty title="No barbers yet" body="Add yourself and anyone who cuts in your shop." /> : null}
        {barbers.map((b) => (
          <Card key={b.id} style={b.is_active ? undefined : { opacity: 0.6 }}>
            <T variant="label">{b.name}</T>
            <T variant="small">{b.is_active ? summarize(b.working_hours) : 'Away, not taking bookings'}</T>
            <Row>
              <Button
                title="Hours"
                variant="secondary"
                onPress={() => router.push({ pathname: '/barber/hours/[id]', params: { id: b.id } })}
              />
              <Button title={b.is_active ? 'Mark away' : 'Back at work'} variant="ghost" onPress={() => toggle(b)} />
            </Row>
          </Card>
        ))}
      </Section>

      <Section title="Add a barber">
        <Field label="Name" value={name} onChangeText={setName} placeholder="e.g. Danial" onSubmitEditing={add} />
        <T variant="small">New barbers start with 10am–8pm, Monday to Saturday. Tap Hours to change.</T>
        <ErrorText message={error} />
        <Button title="Add barber" onPress={add} loading={busy} disabled={!name.trim()} />
      </Section>
    </Screen>
  );
}
