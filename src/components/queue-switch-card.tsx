import { useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, View } from 'react-native';

import { Card, ErrorText, T } from '@/components/ui';
import { Radius, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
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
  const theme = useTheme();
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
      {/* The whole row is the switch, so it is easy to hit; the knob's side says on or off as well as its colour. */}
      <Pressable
        role="switch"
        aria-checked={on}
        aria-busy={busy}
        accessibilityState={{ checked: on, busy }}
        accessibilityLabel={t('Let customers join a queue')}
        onPress={busy ? undefined : toggle}
        style={styles.row}>
        <T variant="label" style={styles.label}>
          {t('Let customers join a queue')}
        </T>
        <View style={styles.state}>
          {busy ? <ActivityIndicator color={theme.textSecondary} /> : null}
          <View
            aria-hidden
            style={[
              styles.track,
              { backgroundColor: on ? theme.success : theme.card, borderColor: on ? theme.success : theme.inputBorder },
            ]}>
            <View
              style={[
                styles.thumb,
                { backgroundColor: on ? theme.accentText : theme.inputBorder, alignSelf: on ? 'flex-end' : 'flex-start' },
              ]}
            />
          </View>
        </View>
      </Pressable>
      <T variant="small">
        {t('While you’re open, customers join from your page and you call them in order from Bookings.')}
      </T>
      <ErrorText message={error} />
    </Card>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: Spacing.sm, minHeight: 48 },
  label: { flexGrow: 1, flexShrink: 1, flexBasis: 160 },
  state: { flexDirection: 'row', alignItems: 'center', gap: Spacing.sm, marginLeft: 'auto' },
  track: { width: 52, height: 32, borderRadius: Radius.pill, borderWidth: 2, padding: 2, justifyContent: 'center' },
  thumb: { width: 24, height: 24, borderRadius: Radius.pill },
});
