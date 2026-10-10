import Ionicons from '@expo/vector-icons/Ionicons';
import { router } from 'expo-router';
import { StyleSheet, View } from 'react-native';

import { Badge, Button, Card, Section, T } from '@/components/ui';
import { Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { nextFreeLine, openStatus } from '@/lib/hours';
import { t } from '@/lib/lang';
import { isDue, lastCutLine, whenLabel, type MyShop, type MyShops } from '@/lib/my-shops';
import { noBreak } from '@/lib/time';

/**
 * The top of Find a barber for someone who has been before: their next cut,
 * which opens My bookings, and the shops they keep going back to, each with
 * Book again set to the same service and barber. Nothing for someone new,
 * so they see the list as it always was.
 */
export function ReturningCards({ mine, now }: { mine: MyShops; now: number }) {
  // Hidden once its time comes, until the next refresh brings the one after.
  const next = mine.next && Date.parse(mine.next.starts_at) > now ? mine.next : null;
  if (!next && mine.shops.length === 0) return null;
  return (
    <>
      {next ? (
        <Section title={t('Your next cut')}>
          <NextCutCard next={next} more={mine.upcoming - 1} now={now} />
        </Section>
      ) : null}
      {mine.shops.length ? (
        <Section title={t('Your barbers')}>
          {mine.shops.map((shop) => (
            <BarberCard
              key={shop.shop_id}
              shop={shop}
              // Latest first, so the first shop has their last cut anywhere.
              due={isDue(shop, mine.shops[0].last_visit_at, mine.upcoming > 0, now)}
              now={now}
            />
          ))}
        </Section>
      ) : null}
      <T variant="heading">{t('All barbers')}</T>
    </>
  );
}

function NextCutCard({ next, more, now }: { next: NonNullable<MyShops['next']>; more: number; now: number }) {
  const theme = useTheme();
  const when = whenLabel(next.starts_at, now, next.time_zone);
  const what = next.barber_name
    ? t('{service} with {barber}', { service: next.service_name, barber: next.barber_name })
    : next.service_name;
  const andMore = more > 0 ? t('+ {count} more', { count: more }) : null;
  const label = t('Your next cut: {when}, {what} at {shop}', { when, what, shop: next.shop_name });
  return (
    <Card
      role="link"
      onPress={() => router.push('/customer/bookings')}
      accessibilityLabel={andMore ? `${label}. ${andMore}` : label}>
      <View style={styles.linkRow}>
        <Ionicons name="calendar-outline" size={24} color={theme.tint} />
        <View style={styles.info}>
          <T style={styles.strong}>{noBreak(when)}</T>
          <T variant="muted">{what}</T>
          <T variant="small">{next.shop_name}</T>
          {andMore ? (
            <T variant="small" style={{ color: theme.tint }}>
              {andMore}
            </T>
          ) : null}
        </View>
        <Ionicons name="chevron-forward" size={22} color={theme.textSecondary} />
      </View>
    </Card>
  );
}

function BarberCard({ shop, due, now }: { shop: MyShop; due: boolean; now: number }) {
  const theme = useTheme();
  const open = openStatus(shop.opens_today, shop.closes_today, now, shop.time_zone);
  // No open line here, so the opening time itself is worth saying.
  const nextFree = shop.is_live ? nextFreeLine(shop.next_free_at, open.state, now, shop.time_zone) : null;

  function bookAgain() {
    router.push({
      pathname: '/shop/[slug]',
      params: {
        slug: shop.slug,
        name: shop.name,
        barber: shop.barber_id,
        ...(shop.service_id ? { service: shop.service_id } : {}),
      },
    });
  }

  return (
    <Card>
      <View style={styles.lines}>
        <T style={styles.strong}>{shop.name}</T>
        <T variant="muted">{lastCutLine(shop, now)}</T>
        {nextFree ? (
          <T variant="small" style={nextFree.soon ? { color: theme.success } : undefined}>
            {nextFree.label}
          </T>
        ) : null}
        {!shop.is_live ? <T variant="small">{t('Not taking online bookings right now')}</T> : null}
      </View>
      {due ? <Badge label={t('Due for a cut')} tone="warning" /> : null}
      {shop.is_live ? (
        <Button
          title={t('Book again')}
          accessibilityLabel={t('Book again at {shop}', { shop: shop.name })}
          variant="secondary"
          onPress={bookAgain}
        />
      ) : null}
    </Card>
  );
}

const styles = StyleSheet.create({
  linkRow: { flexDirection: 'row', alignItems: 'center', gap: Spacing.md },
  info: { flex: 1, gap: 2 },
  lines: { gap: 2 },
  strong: { fontWeight: '600' },
});
