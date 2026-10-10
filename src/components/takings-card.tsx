import { router, useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';

import { LinkCard } from '@/components/ui';
import { t } from '@/lib/lang';
import { periodDays, weekLine, type Summary } from '@/lib/summary';
import { supabase } from '@/lib/supabase';
import type { Shop } from '@/lib/types';

/** This week's takings in one line on My shop, opening the full summary. */
export function TakingsCard({ shop }: { shop: Shop }) {
  const [totals, setTotals] = useState<Summary['totals'] | null>(null);

  // On focus, so cuts marked done on the Bookings tab show when coming back.
  useFocusEffect(
    useCallback(() => {
      let active = true;
      const { from, to } = periodDays('week', Date.now(), shop.time_zone);
      supabase.rpc('shop_summary', { p_from: from, p_to: to }).then(({ data, error }) => {
        // Without the numbers the card still opens the summary, which says what went wrong.
        if (active && !error && data) setTotals((data as Summary).totals);
      });
      return () => {
        active = false;
      };
    }, [shop.time_zone]),
  );

  return (
    <LinkCard
      icon="stats-chart"
      title={t('Takings')}
      summary={totals ? weekLine(totals) : t('See your takings, busiest days and top services.')}
      onPress={() => router.push('/barber/summary')}
    />
  );
}
