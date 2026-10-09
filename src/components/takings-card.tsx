import Ionicons from '@expo/vector-icons/Ionicons';
import { router, useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { Card, T } from '@/components/ui';
import { Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { t } from '@/lib/lang';
import { periodDays, weekLine, type Summary } from '@/lib/summary';
import { supabase } from '@/lib/supabase';
import type { Shop } from '@/lib/types';

/** This week's takings in one line on My shop, opening the full summary. */
export function TakingsCard({ shop }: { shop: Shop }) {
  const theme = useTheme();
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

  const line = totals ? weekLine(totals) : t('See your takings, busiest days and top services.');
  return (
    <Card
      role="link"
      style={styles.card}
      onPress={() => router.push('/barber/summary')}
      accessibilityLabel={`${t('Takings')}: ${line}`}>
      <View style={styles.row}>
        <Ionicons name="stats-chart" size={22} color={theme.tint} />
        <View style={styles.info}>
          <T variant="label">{t('Takings')}</T>
          <T variant="small">{line}</T>
        </View>
        <Ionicons name="chevron-forward" size={22} color={theme.textSecondary} />
      </View>
    </Card>
  );
}

const styles = StyleSheet.create({
  card: { paddingVertical: Spacing.sm },
  row: { flexDirection: 'row', alignItems: 'center', gap: Spacing.md, minHeight: 48 },
  info: { flex: 1, gap: 2 },
});
