import { router, useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { View } from 'react-native';

import { Button, Card, ErrorText, Row, T } from '@/components/ui';
import { Spacing } from '@/constants/theme';
import { dateRange, groupClosures, type ClosedDay, type Closure } from '@/lib/closures';
import { confirmAction } from '@/lib/confirm';
import { t } from '@/lib/lang';
import { errorMessage, supabase } from '@/lib/supabase';
import { addDays, localDateString } from '@/lib/time';
import type { Shop } from '@/lib/types';

/** Upcoming days the whole shop is closed (Hari Raya and the like), with a way to add or undo them. */
export function ClosedDaysCard({ shop }: { shop: Shop }) {
  const [closures, setClosures] = useState<Closure[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    const today = localDateString(new Date(), shop.time_zone);
    const { data, error } = await supabase.rpc('shop_closed_days', {
      p_shop_id: shop.id,
      p_from: today,
      p_to: addDays(today, 60),
    });
    if (error) return setError(errorMessage(error));
    setError(null);
    setClosures(groupClosures((data ?? []) as ClosedDay[]));
  }, [shop.id, shop.time_zone]);

  // On focus, so a closure added on the next screen shows when coming back.
  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  async function reopen(c: Closure) {
    const range = dateRange(c.from, c.to);
    const ok = await confirmAction(
      t('Reopen {days}?', { days: range }),
      t('Customers will be able to book these days again.'),
      t('Reopen'),
    );
    if (!ok) return;
    setBusy(c.from);
    const { error } = await supabase.rpc('reopen_shop_days', { p_from: c.from, p_days: c.days });
    setBusy(null);
    if (error) return setError(errorMessage(error));
    load();
  }

  return (
    <Card>
      <T variant="heading">{t('Holidays')}</T>
      {closures.length === 0 ? (
        <T variant="muted">{t('Closing for Hari Raya or a holiday? Customers will see those days as closed.')}</T>
      ) : (
        <View style={{ gap: Spacing.sm }}>
          {closures.map((c) => (
            <Row key={c.from} style={{ justifyContent: 'space-between', flexWrap: 'nowrap' }}>
              <View style={{ flex: 1 }}>
                <T variant="label">{dateRange(c.from, c.to)}</T>
                <T variant="small">{c.reason && c.reason !== 'Closed' ? c.reason : t('Closed')}</T>
              </View>
              <Button
                title={t('Reopen')}
                accessibilityLabel={t('Reopen {days}', { days: dateRange(c.from, c.to) })}
                variant="ghost"
                loading={busy === c.from}
                onPress={() => reopen(c)}
              />
            </Row>
          ))}
        </View>
      )}
      <ErrorText message={error} />
      <Button title={t('Close for a few days')} variant="secondary" onPress={() => router.push('/barber/close-days')} />
    </Card>
  );
}
