import { router } from 'expo-router';

import { LinkCard } from '@/components/ui';
import { customerCounts } from '@/lib/customers';
import { t } from '@/lib/lang';

/** My shop's way into the customer list (see useShopCards), with how many are due for a cut. */
export function CustomersCard({ counts }: { counts?: { total: number; due: number } }) {
  const summary = !counts
    ? t('See who comes in, and who is due for a cut.')
    : counts.total
      ? customerCounts(counts.total, counts.due)
      : t('No customers yet');
  return <LinkCard icon="people" title={t('Customers')} summary={summary} onPress={() => router.push('/barber/customers')} />;
}
