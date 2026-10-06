import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { View } from 'react-native';

import { Button, Chip, ErrorText, Field, Row, Screen, Section, T } from '@/components/ui';
import { Spacing } from '@/constants/theme';
import { t } from '@/lib/lang';
import { useMyShop } from '@/lib/my-shop';
import { errorMessage, supabase } from '@/lib/supabase';
import { formatDay, formatDuration, formatPrice, localDateString, normalizeTime } from '@/lib/time';
import type { Barber, Service } from '@/lib/types';

type Kind = 'booking' | 'block';
const WHOLE_DAY = 24 * 60;
const BLOCK_LENGTHS = [15, 30, 60, 90, 120, 240, WHOLE_DAY];

/** Barber adds a walk-in / WhatsApp / phone booking, or blocks time. */
export default function NewBooking() {
  const { shop } = useMyShop();
  const params = useLocalSearchParams<{ day?: string }>();
  const tz = shop!.time_zone;
  const day = params.day ?? localDateString(new Date(), tz);

  const [barbers, setBarbers] = useState<Barber[]>([]);
  const [services, setServices] = useState<Service[]>([]);
  const [kind, setKind] = useState<Kind>('booking');
  const [barberId, setBarberId] = useState<string | null>(null);
  const [serviceId, setServiceId] = useState<string | null>(null);
  const [blockMinutes, setBlockMinutes] = useState(60);
  const [time, setTime] = useState('');
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!shop) return;
    Promise.all([
      supabase.from('barbers').select('*').eq('shop_id', shop.id).eq('is_active', true).order('sort_order').order('name'),
      supabase.from('services').select('*').eq('shop_id', shop.id).eq('is_active', true).order('sort_order').order('name'),
    ]).then(([b, s]) => {
      const list = (b.data ?? []) as Barber[];
      setBarbers(list);
      setServices((s.data ?? []) as Service[]);
      if (list.length) setBarberId((current) => current ?? list[0].id);
    });
  }, [shop]);

  const wholeDay = kind === 'block' && blockMinutes === WHOLE_DAY;

  async function save() {
    const clock = wholeDay ? '00:00' : normalizeTime(time);
    if (!barberId) return setError(t('Pick a barber.'));
    if (!clock) return setError(t('Enter the start time, e.g. 14:30.'));
    if (kind === 'booking' && !serviceId) return setError(t('Pick a service.'));
    if (kind === 'booking' && !name.trim()) return setError(t('Add the customer’s name.'));
    setBusy(true);
    setError(null);
    const { error } = await supabase.rpc('add_shop_booking', {
      p_barber_id: barberId,
      p_day: day,
      p_time: clock,
      p_duration_min: kind === 'block' ? blockMinutes : null,
      p_service_id: kind === 'booking' ? serviceId : null,
      p_guest_name: kind === 'booking' ? name : null,
      p_guest_phone: kind === 'booking' ? phone : null,
      p_note: note,
      p_is_block: kind === 'block',
    });
    setBusy(false);
    if (error && wholeDay && error.code === 'P0001') {
      return setError(
        t('There are bookings on this day. Cancel them first (and let the customers know), then block the day.'),
      );
    }
    if (error) return setError(errorMessage(error));
    router.back();
  }

  return (
    <Screen edges={[]}>
      <T variant="heading">{formatDay(`${day}T12:00:00Z`, 'UTC')}</T>

      <Row>
        <Chip label={t('Customer booking')} selected={kind === 'booking'} onPress={() => setKind('booking')} />
        <Chip label={t('Block time')} selected={kind === 'block'} onPress={() => setKind('block')} />
      </Row>
      <T variant="small">
        {kind === 'booking'
          ? t('For walk-ins and bookings that came by WhatsApp or phone. Online customers can no longer take this time.')
          : t('For breaks, errands or a day off. Online customers can’t book this time.')}
      </T>

      {barbers.length > 1 ? (
        <Section title={t('Barber')}>
          <Row>
            {barbers.map((b) => (
              <Chip key={b.id} label={b.name} selected={barberId === b.id} onPress={() => setBarberId(b.id)} />
            ))}
          </Row>
        </Section>
      ) : null}

      {kind === 'booking' ? (
        <Section title={t('Service')}>
          <Row>
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
          <Row>
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

      {wholeDay ? null : (
        <Field label={t('Start time')} value={time} onChangeText={setTime} placeholder="14:30" hint={t('24-hour time.')} />
      )}

      {kind === 'booking' ? (
        <View style={{ gap: Spacing.lg }}>
          <Field
            label={t('Customer name')}
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

      <ErrorText message={error} />
      <Button
        title={kind === 'booking' ? t('Add booking') : wholeDay ? t('Block the day') : t('Block time')}
        onPress={save}
        loading={busy}
      />
    </Screen>
  );
}
