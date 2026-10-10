import { router, useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';

import { LinkCard } from '@/components/ui';
import { customerCounts, type ShopCustomer } from '@/lib/customers';
import { t } from '@/lib/lang';
import { supabase } from '@/lib/supabase';

/** My shop's way into the customer list, with how many are due for a cut. */
export function CustomersCard() {
  const [summary, setSummary] = useState<string | null>(null);

  // A single row carries the counts for everyone, so this stays a small answer.
  // On focus, so inviting or booking someone shows when coming back.
  useFocusEffect(
    useCallback(() => {
      let active = true;
      supabase.rpc('shop_customers', { p_search: null, p_limit: 1, p_offset: 0 }).then(({ data, error }) => {
        if (!active || error) return;
        const [first] = (data ?? []) as ShopCustomer[];
        setSummary(first ? customerCounts(first.total_count, first.due_count) : t('No customers yet'));
      });
      return () => {
        active = false;
      };
    }, []),
  );

  return (
    <LinkCard
      icon="people"
      title={t('Customers')}
      summary={summary ?? t('See who comes in, and who is due for a cut.')}
      onPress={() => router.push('/barber/customers')}
    />
  );
}
