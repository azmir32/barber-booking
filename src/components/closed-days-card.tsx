import { router } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';

import { Button, Card, ErrorText, Row, T } from '@/components/ui';
import { Spacing } from '@/constants/theme';
import { dateRange, groupClosures, type ClosedDay, type Closure } from '@/lib/closures';
import { confirmAction } from '@/lib/confirm';
import { t } from '@/lib/lang';
import { errorMessage, supabase } from '@/lib/supabase';

/**
 * Upcoming days the whole shop is closed (Hari Raya and the like), with a way
 * to add or undo them. The days come with My shop's other cards (see
 * useShopCards), asked for again on coming back from closing some.
 */
export function ClosedDaysCard({
  days,
  loadError,
  savedAt,
  reload,
}: {
  /** The days closed from today to 60 days ahead; undefined while not known. */
  days?: ClosedDay[];
  /** Why they couldn't be had, when asking failed. */
  loadError: string | null;
  /** When the server last answered for them. */
  savedAt: number;
  /** Asks for them again; resolves to why that failed, or null. */
  reload: () => Promise<string | null>;
}) {
  // Only days the shop was closed: barbers' own days off are changed on the Bookings tab.
  const closures = groupClosures(days ?? []);
  // What went wrong reopening, until the server next answers with the days as they are.
  const [failed, setFailed] = useState<{ message: string; savedAt: number } | null>(null);
  const error = failed?.savedAt === savedAt ? failed.message : null;
  const [busy, setBusy] = useState<string | null>(null);

  async function reopen(c: Closure) {
    const range = dateRange(c.from, c.to);
    const ok = await confirmAction(
      t('Reopen {days}?', { days: range }),
      t('Customers will be able to book again.'),
      t('Reopen'),
    );
    if (!ok) return;
    setBusy(c.from);
    const { error } = await supabase.rpc('reopen_shop_days', { p_from: c.from, p_days: c.days });
    if (error) {
      setBusy(null);
      return setFailed({ message: errorMessage(error), savedAt });
    }
    setFailed(null);
    // Busy until the days are asked for again, so the reopened ones go as the spinner stops.
    // If that fails they are still listed, so say why here and not only at the top of My shop.
    const refresh = await reload();
    if (refresh) setFailed({ message: refresh, savedAt });
    setBusy(null);
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
                <T variant="small">{c.reason ?? t('Closed')}</T>
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
      {/* Days kept from an earlier visit stay, and the note at the top of My shop says they may be old. */}
      <ErrorText message={error ?? (days ? null : loadError)} />
      <Button title={t('Close for a few days')} variant="secondary" onPress={() => router.push('/barber/close-days')} />
    </Card>
  );
}
