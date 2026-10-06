import { Badge } from '@/components/ui';
import { useNow } from '@/hooks/use-now';
import { t } from '@/lib/lang';
import type { Booking } from '@/lib/types';

export function BookingStatusBadge({ booking }: { booking: Pick<Booking, 'status' | 'ends_at'> }) {
  const now = useNow();
  switch (booking.status) {
    case 'completed':
      return <Badge label={t('Done')} tone="success" />;
    case 'cancelled':
      return <Badge label={t('Cancelled')} />;
    case 'no_show':
      return <Badge label={t('No-show')} tone="danger" />;
    default:
      return new Date(booking.ends_at).getTime() < now ? (
        <Badge label={t('Past')} />
      ) : (
        <Badge label={t('Confirmed')} tone="success" />
      );
  }
}
