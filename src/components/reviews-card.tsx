import Ionicons from '@expo/vector-icons/Ionicons';
import { router, useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { Card, T } from '@/components/ui';
import { Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { t } from '@/lib/lang';
import { averageText, ratingAverage, ratingLabel, reviewCount } from '@/lib/reviews';
import { supabase } from '@/lib/supabase';

type Newest = { rating: number; comment: string; first_name: string };

/** My shop's way into the reviews: the average, how many, and what the newest comment says. */
export function ReviewsCard({ shopId }: { shopId: string }) {
  const theme = useTheme();
  const [totals, setTotals] = useState<{ count: number; sum: number } | null>(null);
  const [newest, setNewest] = useState<Newest | null>(null);

  // The shop row keeps the count and total, and the newest comment comes
  // with it, so this is one small answer. On focus, so a reply or a new
  // review shows when coming back.
  useFocusEffect(
    useCallback(() => {
      let active = true;
      supabase
        .from('shops')
        .select('rating_count, rating_sum, reviews(rating, comment, first_name)')
        .eq('id', shopId)
        .not('reviews.comment', 'is', null)
        .order('created_at', { referencedTable: 'reviews', ascending: false })
        .limit(1, { referencedTable: 'reviews' })
        .maybeSingle()
        .then(({ data, error }) => {
          // Without the numbers the card still opens the list, which says what went wrong.
          if (!active || error || !data) return;
          setTotals({ count: data.rating_count, sum: data.rating_sum });
          setNewest(((data.reviews ?? []) as Newest[])[0] ?? null);
        });
      return () => {
        active = false;
      };
    }, [shopId]),
  );

  const average = totals ? ratingAverage(totals.sum, totals.count) : null;
  const summary =
    totals == null
      ? t('See what customers say about their cuts.')
      : average == null
        ? t('No reviews yet')
        : `${averageText(average)} ★ · ${reviewCount(totals.count)}`;
  // The name first, so a long comment cut short still says who wrote it.
  const quote = newest ? `${newest.first_name}: “${newest.comment}”` : null;
  // The star said in words, as "black star" helps nobody.
  const spoken = totals && average != null ? ratingLabel(average, totals.count) : summary;
  return (
    <Card
      role="link"
      onPress={() => router.push('/barber/reviews')}
      accessibilityLabel={[`${t('Reviews')}: ${spoken}`, quote].filter(Boolean).join('. ')}>
      <View style={styles.row}>
        <Ionicons name="star" size={24} color={theme.tint} />
        <View style={styles.info}>
          <T variant="heading">{t('Reviews')}</T>
          <T variant="muted">{summary}</T>
          {quote ? (
            <T variant="small" numberOfLines={2}>
              {quote}
            </T>
          ) : null}
        </View>
        <Ionicons name="chevron-forward" size={22} color={theme.textSecondary} />
      </View>
    </Card>
  );
}

// The same layout as LinkCard, with room for the newest comment.
const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: Spacing.md },
  info: { flex: 1, gap: 2 },
});
