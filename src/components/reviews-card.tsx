import Ionicons from '@expo/vector-icons/Ionicons';
import { router } from 'expo-router';
import { StyleSheet, View } from 'react-native';

import { Card, T } from '@/components/ui';
import { Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { t } from '@/lib/lang';
import { averageText, ratingAverage, ratingLabel, reviewCount } from '@/lib/reviews';
import type { ShopCardNumbers } from '@/lib/shop-cards';

/**
 * My shop's way into the reviews (see useShopCards): the average, how many,
 * and what the newest comment says. Without the numbers it still opens the
 * list, which says what went wrong.
 */
export function ReviewsCard({ reviews }: { reviews?: ShopCardNumbers['reviews'] }) {
  const theme = useTheme();
  const totals = reviews ?? null;
  const newest = reviews?.newest ?? null;
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
