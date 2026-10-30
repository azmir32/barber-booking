import { router } from 'expo-router';

import { LinkCard } from '@/components/ui';
import { t } from '@/lib/lang';
import { weekLine, type Summary } from '@/lib/summary';

/** This week's takings in one line on My shop (see useShopCards), opening the full summary. */
export function TakingsCard({ totals }: { totals?: Summary['totals'] }) {
  return (
    <LinkCard
      icon="stats-chart"
      title={t('Takings')}
      // Without the numbers the card still opens the summary, which says what went wrong.
      summary={totals ? weekLine(totals) : t('See your takings, busiest days and top services.')}
      onPress={() => router.push('/barber/summary')}
    />
  );
}
