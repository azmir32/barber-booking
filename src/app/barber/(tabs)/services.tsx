import { useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { View } from 'react-native';

import { Badge, Button, Card, Empty, ErrorText, Field, Row, Screen, Section, T } from '@/components/ui';
import { Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { confirmAction } from '@/lib/confirm';
import { t } from '@/lib/lang';
import { useMyShop } from '@/lib/my-shop';
import { ms } from '@/lib/strings-ms';
import { errorMessage, supabase } from '@/lib/supabase';
import { formatDuration, formatPrice } from '@/lib/time';
import type { Service } from '@/lib/types';

const SUGGESTIONS = [
  { name: 'Haircut', duration_min: 30, price: 20 },
  { name: 'Fade', duration_min: 45, price: 30 },
  { name: 'Beard trim', duration_min: 15, price: 10 },
  { name: 'Kids cut', duration_min: 20, price: 15 },
];

/**
 * Quick add is for starting a menu: once it has as many services as there are
 * suggestions, the menu is the shop's own and suggestions are only noise.
 */
const QUICK_ADD_UNTIL = SUGGESTIONS.length;

/** Words only, lower case and space-separated: "Kids cut (under 12)" -> "kids cut under 12". */
const words = (name: string) => name.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/**
 * Whether the menu already has the suggestion, under its English or its Malay
 * name, alone or with more words: "Kids cut (under 12)" has Kids cut, and
 * "Haircut" is Potong rambut.
 */
function onMenu(suggestion: string, menu: Service[]): boolean {
  const names = [suggestion, ms[suggestion] ?? suggestion].map(words);
  return menu.some((s) => names.some((n) => ` ${words(s.name)} `.includes(` ${n} `)));
}

/** Name, minutes and price of `service`, or of a new service when there is none. */
function ServiceForm({
  service,
  shopId,
  sortOrder,
  onSaved,
  onCancel,
}: {
  service?: Service;
  shopId: string;
  sortOrder: number;
  onSaved: () => void;
  onCancel?: () => void;
}) {
  const [name, setName] = useState(service?.name ?? '');
  const [duration, setDuration] = useState(String(service?.duration_min ?? 30));
  const [price, setPrice] = useState(service ? String(service.price) : '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    const durationMin = parseInt(duration, 10);
    const priceNum = Number(price);
    if (!name.trim()) return setError(t('Give the service a name.'));
    if (!(durationMin >= 5 && durationMin <= 480)) return setError(t('Time should be between 5 and 480 minutes.'));
    if (!(priceNum >= 0) || price.trim() === '') return setError(t('Enter a price in RM.'));
    setBusy(true);
    const fields = { name: name.trim(), duration_min: durationMin, price: priceNum };
    const { error } = service
      ? await supabase.from('services').update(fields).eq('id', service.id)
      : await supabase.from('services').insert({ ...fields, shop_id: shopId, sort_order: sortOrder });
    setBusy(false);
    if (error) return setError(errorMessage(error));
    setError(null);
    if (!service) {
      // Ready for the next one.
      setName('');
      setDuration('30');
      setPrice('');
    }
    onSaved();
  }

  return (
    <>
      <Field label={t('Name')} value={name} onChangeText={setName} placeholder={t('e.g. Skin fade + beard')} maxLength={60} />
      <Row style={{ flexWrap: 'nowrap' }}>
        <View style={{ flex: 1 }}>
          <Field label={t('Minutes')} value={duration} onChangeText={setDuration} keyboardType="number-pad" maxLength={3} />
        </View>
        <View style={{ flex: 1 }}>
          <Field label={t('Price (RM)')} value={price} onChangeText={setPrice} keyboardType="decimal-pad" maxLength={8} />
        </View>
      </Row>
      <ErrorText message={error} />
      <Button title={service ? t('Save service') : t('Add service')} onPress={save} loading={busy} />
      {onCancel ? <Button title={t('Cancel')} variant="ghost" onPress={onCancel} /> : null}
    </>
  );
}

export default function Services() {
  const theme = useTheme();
  const { shop } = useMyShop();
  const [services, setServices] = useState<Service[]>([]);
  // Until the menu has loaded once, nothing is offered: an empty list might just be a bad signal.
  const [loaded, setLoaded] = useState(false);
  // The service being edited, in its own card, so the form opens where the barber tapped.
  const [editingId, setEditingId] = useState<string | null>(null);
  // The last quick add, which one tap takes back.
  const [added, setAdded] = useState<Service | null>(null);
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
    setError(null);
    setServices((data ?? []) as Service[]);
    setLoaded(true);
  }, [shop]);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  async function addSuggestion(s: (typeof SUGGESTIONS)[number]) {
    if (!shop) return;
    const { data, error } = await supabase
      .from('services')
      .insert({ ...s, name: t(s.name), shop_id: shop.id, sort_order: services.length })
      .select()
      .single();
    if (error) return setError(errorMessage(error));
    setAdded(data as Service);
    load();
  }

  async function undoAdd(s: Service) {
    setAdded(null);
    const { error } = await supabase.from('services').delete().eq('id', s.id);
    if (error) return setError(errorMessage(error));
    load();
  }

  async function toggle(s: Service) {
    setAdded(null);
    const { error } = await supabase.from('services').update({ is_active: !s.is_active }).eq('id', s.id);
    if (error) return setError(errorMessage(error));
    load();
  }

  async function remove(s: Service) {
    setAdded(null);
    const ok = await confirmAction(
      t('Delete {name}?', { name: s.name }),
      t('Customers will no longer see it. Past bookings keep their details. To bring it back later, use Hide instead.'),
      t('Delete'),
    );
    if (!ok) return;
    const { error } = await supabase.from('services').delete().eq('id', s.id);
    if (error) return setError(errorMessage(error));
    load();
  }

  if (!shop) return null;
  const missing =
    loaded && services.length < QUICK_ADD_UNTIL ? SUGGESTIONS.filter((s) => !onMenu(s.name, services)) : [];

  return (
    <Screen>
      <T variant="title">{t('Services')}</T>

      <Section title={t('Your menu')}>
        {!loaded ? (
          error ? (
            <>
              <ErrorText message={`${t('Couldn’t load your menu.')} ${error}`} />
              <Button title={t('Try again')} variant="secondary" onPress={load} />
            </>
          ) : null
        ) : services.length === 0 ? (
          <Empty title={t('No services yet')} body={t('Add what you offer so customers can book it.')} />
        ) : null}
        {services.map((s) =>
          s.id === editingId ? (
            <Card key={s.id} style={{ borderColor: theme.tint, borderWidth: 2 }}>
              <T variant="label">{t('Edit {name}', { name: s.name })}</T>
              <ServiceForm
                service={s}
                shopId={shop.id}
                sortOrder={s.sort_order}
                onSaved={() => {
                  setEditingId(null);
                  load();
                }}
                onCancel={() => setEditingId(null)}
              />
            </Card>
          ) : (
            <Card key={s.id}>
              <Row style={{ justifyContent: 'space-between', flexWrap: 'nowrap', alignItems: 'flex-start' }}>
                <View style={{ flex: 1, gap: Spacing.xs }}>
                  <T variant="label">{s.name}</T>
                  {s.is_active ? null : <Badge label={t('Hidden')} tone="warning" />}
                </View>
                <T variant="label">{formatPrice(s.price)}</T>
              </Row>
              <T variant="small">
                {formatDuration(s.duration_min)}
                {s.is_active ? '' : ` · ${t('hidden from customers')}`}
              </T>
              <Row>
                <Button
                  title={t('Edit')}
                  variant="secondary"
                  onPress={() => {
                    setAdded(null);
                    setEditingId(s.id);
                  }}
                />
                {/* Showing it again is the next step for a hidden service, so it stands out. */}
                <Button
                  title={s.is_active ? t('Hide') : t('Show')}
                  variant={s.is_active ? 'ghost' : 'secondary'}
                  onPress={() => toggle(s)}
                />
                <Button title={t('Delete')} variant="ghost" onPress={() => remove(s)} />
              </Row>
            </Card>
          ),
        )}
        {added && services.some((s) => s.id === added.id) ? (
          <Row style={{ flexWrap: 'nowrap' }}>
            <T variant="muted" style={{ flex: 1 }}>
              {t('Added {name} to your menu.', { name: added.name })}
            </T>
            <Button
              title={t('Undo')}
              accessibilityLabel={t('Undo adding {name}', { name: added.name })}
              variant="secondary"
              onPress={() => undoAdd(added)}
            />
          </Row>
        ) : null}
        {loaded ? <ErrorText message={error} /> : null}
      </Section>

      {missing.length && !editingId ? (
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

      {/* For new services only, so it always starts empty. */}
      {loaded ? (
        <Section title={t('Add a service')}>
          <ServiceForm
            shopId={shop.id}
            sortOrder={services.length}
            onSaved={() => {
              setAdded(null);
              load();
            }}
          />
        </Section>
      ) : null}
    </Screen>
  );
}
