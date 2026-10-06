import { router, useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';

import { Button, Card, Empty, ErrorText, Field, Row, Screen, Section, T } from '@/components/ui';
import { summarizeWeek } from '@/lib/hours';
import { t } from '@/lib/lang';
import { addBarber, useMyShop } from '@/lib/my-shop';
import { errorMessage, supabase } from '@/lib/supabase';
import type { Barber, WorkingHours } from '@/lib/types';

type BarberWithHours = Barber & { working_hours: WorkingHours[] };

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
      <T variant="title">{t('Barbers')}</T>
      <T variant="muted">{t('One per chair. Customers can pick a barber or take whoever is free.')}</T>

      <Section title={t('Your team')}>
        {barbers.length === 0 ? (
          <Empty title={t('No barbers yet')} body={t('Add yourself and anyone who cuts in your shop.')} />
        ) : null}
        {barbers.map((b) => (
          <Card key={b.id} style={b.is_active ? undefined : { opacity: 0.6 }}>
            <T variant="label">{b.name}</T>
            <T variant="small">{b.is_active ? summarizeWeek(b.working_hours) : t('Away, not taking bookings')}</T>
            <Row>
              <Button
                title={t('Hours')}
                variant="secondary"
                onPress={() => router.push({ pathname: '/barber/hours/[id]', params: { id: b.id } })}
              />
              <Button title={b.is_active ? t('Mark away') : t('Back at work')} variant="ghost" onPress={() => toggle(b)} />
            </Row>
          </Card>
        ))}
      </Section>

      <Section title={t('Add a barber')}>
        <Field
          label={t('Name')}
          value={name}
          onChangeText={setName}
          placeholder={t('e.g. Danial')}
          onSubmitEditing={add}
          maxLength={40}
        />
        <T variant="small">{t('New barbers start with 10am–8pm, Monday to Saturday. Tap Hours to change.')}</T>
        <ErrorText message={error} />
        <Button title={t('Add barber')} onPress={add} loading={busy} disabled={!name.trim()} />
      </Section>
    </Screen>
  );
}
