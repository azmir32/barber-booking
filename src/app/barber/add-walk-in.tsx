import { router } from 'expo-router';
import { useEffect, useState } from 'react';

import { Button, Chip, ErrorText, Field, Row, Screen, Section, T } from '@/components/ui';
import { t } from '@/lib/lang';
import { useMyShop } from '@/lib/my-shop';
import { errorMessage, supabase } from '@/lib/supabase';
import { formatDuration, formatPrice } from '@/lib/time';
import type { Barber, Service } from '@/lib/types';

/**
 * Someone who walked in joins the end of today's queue: a name to call out,
 * their number for a WhatsApp when it's their turn, and what they want if
 * they said. Start asks for a service later when none was picked.
 */
export default function AddWalkIn() {
  const { shop } = useMyShop();
  const [barbers, setBarbers] = useState<Pick<Barber, 'id' | 'name'>[]>([]);
  const [services, setServices] = useState<Service[]>([]);
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [serviceId, setServiceId] = useState<string | null>(null);
  const [barberId, setBarberId] = useState<string | null>(null);
  const [nameError, setNameError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!shop) return;
    Promise.all([
      supabase.from('barbers').select('id, name').eq('shop_id', shop.id).eq('is_active', true).order('sort_order').order('name'),
      supabase.from('services').select('*').eq('shop_id', shop.id).eq('is_active', true).order('sort_order').order('name'),
    ]).then(([b, s]) => {
      // Both are optional, so the form still works without them.
      if (b.error || s.error) return setError(errorMessage(b.error ?? s.error));
      setBarbers(b.data ?? []);
      setServices((s.data ?? []) as Service[]);
    });
  }, [shop]);

  async function save() {
    if (!name.trim()) return setNameError(t('Add the customer’s name.'));
    setNameError(null);
    setBusy(true);
    setError(null);
    const { error: failed } = await supabase.rpc('add_to_queue', {
      p_name: name.trim(),
      p_phone: phone.trim() || null,
      p_service_id: serviceId,
      p_barber_id: barberId,
    });
    setBusy(false);
    if (failed) return setError(errorMessage(failed));
    router.back();
  }

  return (
    <Screen
      edges={[]}
      footer={
        <>
          <ErrorText message={error} />
          <Button title={t('Add to the queue')} onPress={save} loading={busy} />
        </>
      }>
      <T variant="small">{t('They go to the end of today’s queue. Call them from Bookings when it’s their turn.')}</T>
      <Field
        label={t('Customer name')}
        value={name}
        onChangeText={(text) => {
          setName(text);
          if (nameError && text.trim()) setNameError(null);
        }}
        placeholder={t('e.g. Pak Abu')}
        maxLength={80}
        autoFocus
        error={nameError}
      />
      <Field
        label={t('Customer phone (optional)')}
        hint={t('For a WhatsApp when it’s their turn.')}
        value={phone}
        onChangeText={setPhone}
        keyboardType="phone-pad"
        maxLength={20}
      />

      {services.length ? (
        <Section title={t('Service')}>
          <Row role="radiogroup" accessibilityLabel={t('Service')}>
            <Chip label={t('Not sure yet')} selected={serviceId === null} onPress={() => setServiceId(null)} />
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
      ) : null}

      {barbers.length > 1 ? (
        <Section title={t('Barber')}>
          <Row role="radiogroup" accessibilityLabel={t('Barber')}>
            <Chip label={t('Any barber')} selected={barberId === null} onPress={() => setBarberId(null)} />
            {barbers.map((b) => (
              <Chip key={b.id} label={b.name} selected={barberId === b.id} onPress={() => setBarberId(b.id)} />
            ))}
          </Row>
        </Section>
      ) : null}
    </Screen>
  );
}
