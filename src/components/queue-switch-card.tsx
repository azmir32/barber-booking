import { useState } from 'react';

import { Card, ErrorText, SwitchRow, T } from '@/components/ui';
import { t } from '@/lib/lang';
import { errorMessage, supabase } from '@/lib/supabase';
import type { Shop } from '@/lib/types';

/**
 * My shop's on/off for the walk-in queue. Off, customers only book times;
 * on, they can also join today's queue from the shop's page while it is
 * open, and Bookings lists them in order.
 */
export function QueueSwitchCard({
  shop,
  onChanged,
}: {
  shop: Pick<Shop, 'id' | 'queue_enabled'>;
  onChanged: () => Promise<unknown>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const on = shop.queue_enabled;

  async function toggle() {
    setBusy(true);
    setError(null);
    const { error: failed } = await supabase.from('shops').update({ queue_enabled: !on }).eq('id', shop.id);
    if (!failed) await onChanged();
    setBusy(false);
    if (failed) setError(errorMessage(failed));
  }

  return (
    <Card>
      <T variant="heading">{t('Walk-in queue')}</T>
      <SwitchRow label={t('Let customers join a queue')} value={on} onChange={toggle} busy={busy} />
      <T variant="small">
        {t('While you’re open, customers join from your page and you call them in order from Bookings.')}
      </T>
      <ErrorText message={error} />
    </Card>
  );
}
