import { useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { View } from 'react-native';

import { Button, Card, Empty, ErrorText, Field, Row, Screen, Section, T } from '@/components/ui';
import { confirmAction } from '@/lib/confirm';
import { t } from '@/lib/lang';
import { useMyShop } from '@/lib/my-shop';
import { errorMessage, supabase } from '@/lib/supabase';
import { formatDuration, formatPrice } from '@/lib/time';
import type { Service } from '@/lib/types';

const SUGGESTIONS = [
  { name: 'Haircut', duration_min: 30, price: 20 },
  { name: 'Fade', duration_min: 45, price: 30 },
  { name: 'Beard trim', duration_min: 15, price: 10 },
  { name: 'Kids cut', duration_min: 20, price: 15 },
];

export default function Services() {
  const { shop } = useMyShop();
  const [services, setServices] = useState<Service[]>([]);
  const [editing, setEditing] = useState<Service | null>(null);
  const [name, setName] = useState('');
  const [duration, setDuration] = useState('30');
  const [price, setPrice] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!shop) return;
    const { data, error } = await supabase
      .from('services')
      .select('*')
      .eq('shop_id', shop.id)
      .order('sort_order')
      .order('created_at');
    if (error) return setError(errorMessage(error));
    setServices((data ?? []) as Service[]);
  }, [shop]);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  function startEdit(s: Service | null) {
    setEditing(s);
    setName(s?.name ?? '');
    setDuration(String(s?.duration_min ?? 30));
    setPrice(s ? String(s.price) : '');
    setError(null);
  }

  async function save() {
    if (!shop) return;
    const durationMin = parseInt(duration, 10);
    const priceNum = Number(price);
    if (!name.trim()) return setError(t('Give the service a name.'));
    if (!(durationMin >= 5 && durationMin <= 480)) return setError(t('Time should be between 5 and 480 minutes.'));
    if (!(priceNum >= 0) || price.trim() === '') return setError(t('Enter a price in RM.'));
    setBusy(true);
    const fields = { name: name.trim(), duration_min: durationMin, price: priceNum };
    const { error } = editing
      ? await supabase.from('services').update(fields).eq('id', editing.id)
      : await supabase.from('services').insert({ ...fields, shop_id: shop.id, sort_order: services.length });
    setBusy(false);
    if (error) return setError(errorMessage(error));
    startEdit(null);
    load();
  }

  async function addSuggestion(s: (typeof SUGGESTIONS)[number]) {
    if (!shop) return;
    const { error } = await supabase
      .from('services')
      .insert({ ...s, name: t(s.name), shop_id: shop.id, sort_order: services.length });
    if (error) return setError(errorMessage(error));
    load();
  }

  async function toggle(s: Service) {
    const { error } = await supabase.from('services').update({ is_active: !s.is_active }).eq('id', s.id);
    if (error) return setError(errorMessage(error));
    load();
  }

  async function remove(s: Service) {
    const ok = await confirmAction(
      t('Delete {name}?', { name: s.name }),
      t('Customers will no longer see it. Past bookings keep their details. To bring it back later, use Hide instead.'),
      t('Delete'),
    );
    if (!ok) return;
    const { error } = await supabase.from('services').delete().eq('id', s.id);
    if (error) return setError(errorMessage(error));
    if (editing?.id === s.id) startEdit(null);
    load();
  }

  const missing = SUGGESTIONS.filter((s) => !services.some((x) => x.name.toLowerCase() === t(s.name).toLowerCase()));

  return (
    <Screen>
      <T variant="title">{t('Services')}</T>

      <Section title={t('Your menu')}>
        {services.length === 0 ? (
          <Empty title={t('No services yet')} body={t('Add what you offer so customers can book it.')} />
        ) : null}
        {services.map((s) => (
          <Card key={s.id} style={s.is_active ? undefined : { opacity: 0.6 }}>
            <Row style={{ justifyContent: 'space-between' }}>
              <T variant="label">{s.name}</T>
              <T variant="label">{formatPrice(s.price)}</T>
            </Row>
            <T variant="small">
              {formatDuration(s.duration_min)}
              {s.is_active ? '' : ` · ${t('hidden from customers')}`}
            </T>
            <Row>
              <Button title={t('Edit')} variant="secondary" onPress={() => startEdit(s)} />
              <Button title={s.is_active ? t('Hide') : t('Show')} variant="ghost" onPress={() => toggle(s)} />
              <Button title={t('Delete')} variant="ghost" onPress={() => remove(s)} />
            </Row>
          </Card>
        ))}
      </Section>

      {missing.length && !editing ? (
        <Section title={t('Quick add')}>
          <Row>
            {missing.map((s) => (
              <Button
                key={s.name}
                title={`+ ${t(s.name)} ${formatPrice(s.price)}`}
                variant="secondary"
                onPress={() => addSuggestion(s)}
              />
            ))}
          </Row>
          <T variant="small">{t('You can change the price and time after adding.')}</T>
        </Section>
      ) : null}

      <Section title={editing ? t('Edit {name}', { name: editing.name }) : t('Add a service')}>
        <Field
          label={t('Name')}
          value={name}
          onChangeText={setName}
          placeholder={t('e.g. Skin fade + beard')}
          maxLength={60}
        />
        <Row style={{ flexWrap: 'nowrap' }}>
          <View style={{ flex: 1 }}>
            <Field label={t('Minutes')} value={duration} onChangeText={setDuration} keyboardType="number-pad" maxLength={3} />
          </View>
          <View style={{ flex: 1 }}>
            <Field label={t('Price (RM)')} value={price} onChangeText={setPrice} keyboardType="decimal-pad" maxLength={8} />
          </View>
        </Row>
        <ErrorText message={error} />
        <Button title={editing ? t('Save service') : t('Add service')} onPress={save} loading={busy} />
        {editing ? <Button title={t('Cancel')} variant="ghost" onPress={() => startEdit(null)} /> : null}
      </Section>
    </Screen>
  );
}
