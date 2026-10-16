import { Badge } from '@/components/ui';
import { useNow } from '@/hooks/use-now';
import { t } from '@/lib/lang';
import type { Booking } from '@/lib/types';

export function BookingStatusBadge({
  booking,
  forShop,
}: {
  booking: Pick<Booking, 'status' | 'ends_at'>;
  /** The shop's view: a past booking nobody has marked still needs Done or No-show. */
  forShop?: boolean;
}) {
  const now = useNow();
  switch (booking.status) {
    case 'completed':
      return <Badge label={t('Done')} tone="success" />;
    case 'cancelled':
      return <Badge label={t('Cancelled')} />;
    case 'no_show':
      return <Badge label={t('No-show')} tone="danger" />;
    default:
      if (new Date(booking.ends_at).getTime() >= now) return <Badge label={t('Confirmed')} tone="success" />;
      return forShop ? <Badge label={t('Mark done?')} tone="warning" /> : <Badge label={t('Past')} />;
  }
}
