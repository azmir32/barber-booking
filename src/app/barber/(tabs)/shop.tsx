import Ionicons from '@expo/vector-icons/Ionicons';
import * as Clipboard from 'expo-clipboard';
import { router, useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { Share, View, type ViewStyle } from 'react-native';

import { AccountPanel } from '@/components/account-panel';
import { ClosedDaysCard } from '@/components/closed-days-card';
import { CustomersCard } from '@/components/customers-card';
import { KeepLiveButton } from '@/components/keep-live-button';
import { ShopForm } from '@/components/shop-form';
import { TakingsCard } from '@/components/takings-card';
import { Badge, Button, Card, ErrorText, Row, Screen, Section, T } from '@/components/ui';
import { bookingLink } from '@/constants/brand';
import { Spacing } from '@/constants/theme';
import { useNow } from '@/hooks/use-now';
import { useTheme } from '@/hooks/use-theme';
import { confirmAction } from '@/lib/confirm';
import { t } from '@/lib/lang';
import { useMyShop } from '@/lib/my-shop';
import { errorMessage, supabase } from '@/lib/supabase';
import { formatDay } from '@/lib/time';
import type { Shop } from '@/lib/types';

// The booking link's buttons go two to a line, so four fit a phone without one left on its own.
const linkAction: ViewStyle = { flexGrow: 1, flexBasis: '40%' };

function billingText(shop: Shop): { label: string; tone: 'success' | 'warning' | 'danger' } {
  if (shop.subscription_status === 'active') return { label: t('Subscription active'), tone: 'success' };
  const left = Math.ceil((new Date(shop.trial_ends_at).getTime() - Date.now()) / 86400000);
  if (shop.subscription_status === 'trialing' && left > 0) {
    return {
      label: left === 1 ? t('Free trial: 1 day left') : t('Free trial: {count} days left', { count: left }),
      tone: left <= 5 ? 'warning' : 'success',
    };
  }
  // Short, as the heading and the lines under it say what it means.
  return {
    label: shop.subscription_status === 'trialing' ? t('Trial ended') : t('Subscription not active'),
    tone: 'danger',
  };
}

export default function MyShop() {
  const { shop, reload } = useMyShop();
  const theme = useTheme();
  const now = useNow();
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Whether customers have anything to book; null until known (or if it can't be loaded).
  const [hasServices, setHasServices] = useState<boolean | null>(null);
  const shopId = shop?.id;

  // On focus, so adding a service on the Services tab shows Go live here right away.
  useFocusEffect(
    useCallback(() => {
      if (!shopId) return;
      supabase
        .from('services')
        .select('id')
        .eq('shop_id', shopId)
        .eq('is_active', true)
        .limit(1)
        .then(({ data }) => setHasServices(data ? data.length > 0 : null));
    }, [shopId]),
  );

  if (!shop) return null;
  const link = bookingLink(shop.slug);
  const billing = billingText(shop);
  // Published but not paid up (the free month ended): customers can't find or book the shop.
  const unpaid = shop.is_published && billing.tone === 'danger';
  // Customers can book from the link: as the database decides (shop_is_live).
  const bookable = shop.is_published && billing.tone !== 'danger';
  // Five days or fewer of the free month left, or none: time to subscribe.
  const needsPlan = billing.tone !== 'success';
  // Live before and paused since, as opposed to a new shop that has never been live.
  const paused = !shop.is_published && shop.published_at != null;
  const trialOver = new Date(shop.trial_ends_at).getTime() <= now;
  const needsService = !shop.is_published && hasServices === false;

  async function togglePublished() {
    // Pausing hides the whole shop, which is too much for a day off or a
    // break, so say what it does and point to Block time.
    if (shop!.is_published) {
      const ok = await confirmAction(
        t('Pause online bookings?'),
        t(
          'Customers can’t find your shop or book from your link until you go live again. Bookings already made are not cancelled. For a holiday, use Close for a few days below instead.',
        ),
        t('Pause bookings'),
        t('Keep bookings open'),
      );
      if (!ok) return;
    }
    setBusy(true);
    const { error } = await supabase.from('shops').update({ is_published: !shop!.is_published }).eq('id', shop!.id);
    setBusy(false);
    if (error) return setError(errorMessage(error));
    setError(null);
    reload();
  }

  async function copyLink(text: string) {
    try {
      await Clipboard.setStringAsync(text);
      setCopied(true);
    } catch {
      // The link is on screen to copy by hand.
    }
  }

  return (
    <Screen>
      <T variant="title">{t('My shop')}</T>

      <Card>
        <Row style={{ justifyContent: 'space-between' }}>
          <T variant="heading">
            {unpaid
              ? t('Hidden from customers')
              : shop.is_published
                ? t('You are live')
                : paused
                  ? t('Bookings paused')
                  : t('Not live yet')}
          </T>
          <Badge label={billing.label} tone={billing.tone} />
        </Row>
        <T variant="muted">
          {unpaid
            ? t('Customers can’t find your shop or book from your link until you subscribe.')
            : shop.is_published
              ? t('Customers can find you and book. Share your link everywhere.')
              : needsService
                ? t('Add a service before you go live, so customers have something to book.')
                : paused
                  ? t('Customers can’t find you or book from your link. Bookings already made still stand.')
                  : t('Go live when your services and hours are ready.')}
        </T>
        {shop.subscription_status === 'trialing' ? (
          <T variant="small">
            {trialOver
              ? t('Your free month ended on {day}.', { day: formatDay(shop.trial_ends_at, shop.time_zone) })
              : t('Your free month ends on {day}.', { day: formatDay(shop.trial_ends_at, shop.time_zone) })}
          </T>
        ) : null}
        {needsPlan ? <T variant="small">{t('We’ll reply on WhatsApp with the monthly price and how to pay.')}</T> : null}
        <ErrorText message={error} />
        {needsPlan ? <KeepLiveButton shop={shop} /> : null}
        {needsService ? (
          <Button
            title={t('Add a service')}
            variant={needsPlan ? 'secondary' : 'primary'}
            onPress={() => router.push('/barber/services')}
          />
        ) : unpaid ? null : (
          // Pausing a shop that is hidden anyway would change nothing for customers.
          <Button
            title={shop.is_published ? t('Pause bookings') : paused ? t('Turn bookings back on') : t('Go live')}
            variant={shop.is_published || needsPlan ? 'secondary' : 'primary'}
            onPress={togglePublished}
            loading={busy}
          />
        )}
      </Card>

      <TakingsCard shop={shop} />

      <CustomersCard />

      <ClosedDaysCard shop={shop} />

      <Card>
        <T variant="heading">{t('Your booking link')}</T>
        <T selectable>{link}</T>
        {bookable ? (
          <T variant="small">{t('Put it in your Instagram bio, WhatsApp status and on a poster at the shop.')}</T>
        ) : (
          <View style={{ flexDirection: 'row', gap: Spacing.sm }}>
            <Ionicons name="warning-outline" size={18} color={theme.warning} style={{ marginTop: 1 }} />
            <T variant="label" style={{ flex: 1 }}>
              {billing.tone === 'danger'
                ? t('Customers can’t book from this link until you subscribe.')
                : t('Customers can’t book from this link until you go live.')}
            </T>
          </View>
        )}
        <Row>
          <Button
            title={t('Share')}
            // While the link can't take bookings, the status card's action is the one to do first.
            variant={bookable ? 'primary' : 'secondary'}
            style={linkAction}
            onPress={() =>
              // Browsers without a share sheet get the link copied instead; closing the sheet is not one of those.
              Share.share({ message: t('Book your next cut at {shop}: {link}', { shop: shop.name, link }) }).catch(
                (e: { name?: string } | null) => {
                  if (e?.name !== 'AbortError') copyLink(link);
                },
              )
            }
          />
          <Button
            title={copied ? t('Copied') : t('Copy')}
            variant="secondary"
            style={linkAction}
            onPress={() => copyLink(link)}
          />
          <Button
            title={t('Print poster')}
            variant="secondary"
            style={linkAction}
            onPress={() => router.push('/barber/poster')}
          />
          <Button
            title={t('Preview')}
            variant="ghost"
            style={linkAction}
            onPress={() => router.push(`/shop/${shop.slug}`)}
          />
        </Row>
      </Card>

      <Section title={t('Shop details')}>
        <ShopForm key={shop.id} shop={shop} onSaved={reload} />
      </Section>

      <Section title={t('Account')}>
        <AccountPanel />
      </Section>
    </Screen>
  );
}
