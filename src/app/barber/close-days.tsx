import { router } from 'expo-router';
import { useMemo, useState } from 'react';

import { DayPicker } from '@/components/day-picker';
import { Button, Chip, ErrorText, Field, Row, Screen, Section, T } from '@/components/ui';
import { dateRange } from '@/lib/closures';
import { t } from '@/lib/lang';
import { useMyShop } from '@/lib/my-shop';
import { errorMessage, supabase } from '@/lib/supabase';
import { addDays, upcomingDays } from '@/lib/time';

const LENGTHS = [1, 2, 3, 4, 5, 7, 10, 14];
// Customers can book 60 days ahead, so there is no point closing further out.
const DAYS_SHOWN = 60;

/** Close the whole shop for a run of days, e.g. Hari Raya: every barber gets the days off. */
export default function CloseDays() {
  const { shop } = useMyShop();
  const days = useMemo(() => upcomingDays(DAYS_SHOWN, shop?.time_zone), [shop?.time_zone]);
  const [from, setFrom] = useState<string | null>(null);
  const [count, setCount] = useState(1);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const daysText = (n: number) => (n === 1 ? t('1 day') : t('{count} days', { count: n }));

  async function save() {
    if (!from) return setError(t('Pick the first day.'));
    setBusy(true);
    setError(null);
    const { error } = await supabase.rpc('close_shop_days', { p_from: from, p_days: count, p_reason: reason });
    setBusy(false);
    if (error) return setError(errorMessage(error));
    router.back();
  }

  return (
    <Screen
      edges={[]}
      footer={
        <>
          {from ? <T variant="label">{t('Closed {days}', { days: dateRange(from, addDays(from, count - 1)) })}</T> : null}
          <ErrorText message={error} />
          <Button
            title={count === 1 ? t('Close for 1 day') : t('Close for {count} days', { count })}
            onPress={save}
            loading={busy}
          />
        </>
      }>
      <T variant="muted">
        {t('Every barber gets these days off, and customers see them as closed. Cancel any bookings on them first.')}
      </T>
      <Section title={t('First day')}>
        <DayPicker days={days} selected={from} onSelect={setFrom} />
      </Section>
      <Section title={t('How many days')}>
        <Row role="radiogroup" accessibilityLabel={t('How many days')}>
          {LENGTHS.map((n) => (
            <Chip key={n} label={daysText(n)} selected={count === n} onPress={() => setCount(n)} />
          ))}
        </Row>
      </Section>
      <Field
        label={t('Reason (optional)')}
        value={reason}
        onChangeText={setReason}
        placeholder={t('e.g. Hari Raya, day off')}
        maxLength={80}
      />
      <T variant="small">{t('Only you see the reason.')}</T>
    </Screen>
  );
}
