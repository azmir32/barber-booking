import { Badge } from '@/components/ui';
import { useNow } from '@/hooks/use-now';
import type { Booking } from '@/lib/types';

export function BookingStatusBadge({ booking }: { booking: Pick<Booking, 'status' | 'ends_at'> }) {
  const now = useNow();
  switch (booking.status) {
    case 'completed':
      return <Badge label="Done" tone="success" />;
    case 'cancelled':
      return <Badge label="Cancelled" />;
    case 'no_show':
      return <Badge label="No-show" tone="danger" />;
    default:
      return new Date(booking.ends_at).getTime() < now ? (
        <Badge label="Past" />
      ) : (
        <Badge label="Confirmed" tone="success" />
      );
  }
}
