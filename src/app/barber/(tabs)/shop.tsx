import * as Clipboard from 'expo-clipboard';
import { router, useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { Share, type ViewStyle } from 'react-native';

import { AccountPanel } from '@/components/account-panel';
import { ClosedDaysCard } from '@/components/closed-days-card';
import { ShopForm } from '@/components/shop-form';
import { Badge, Button, Card, ErrorText, Row, Screen, Section, T } from '@/components/ui';
import { bookingLink } from '@/constants/brand';
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
  return { label: t('Trial ended, customers can no longer book'), tone: 'danger' };
}

export default function MyShop() {
  const { shop, reload } = useMyShop();
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
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
          <T variant="heading">{shop.is_published ? t('You are live') : t('Not live yet')}</T>
          <Badge label={billing.label} tone={billing.tone} />
        </Row>
        <T variant="muted">
          {shop.is_published
            ? t('Customers can find you and book. Share your link everywhere.')
            : needsService
              ? t('Add a service before you go live, so customers have something to book.')
              : t('Go live when your services and hours are ready.')}
        </T>
        {shop.subscription_status === 'trialing' ? (
          <T variant="small">
            {t('Your free month ends on {day}.', { day: formatDay(shop.trial_ends_at, shop.time_zone) })}
          </T>
        ) : null}
        <ErrorText message={error} />
        {needsService ? (
          <Button title={t('Add a service')} onPress={() => router.push('/barber/services')} />
        ) : (
          <Button
            title={shop.is_published ? t('Pause bookings') : t('Go live')}
            variant={shop.is_published ? 'secondary' : 'primary'}
            onPress={togglePublished}
            loading={busy}
          />
        )}
      </Card>

      <ClosedDaysCard shop={shop} />

      <Card>
        <T variant="heading">{t('Your booking link')}</T>
        <T selectable>{link}</T>
        <T variant="small">{t('Put it in your Instagram bio, WhatsApp status and on a poster at the shop.')}</T>
        <Row>
          <Button
            title={t('Share')}
            style={linkAction}
            onPress={() =>
              // Browsers without a share sheet get the link copied instead.
              Share.share({ message: t('Book your next cut at {shop}: {link}', { shop: shop.name, link }) }).catch(() =>
                copyLink(link),
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
        <ShopForm
          key={shop.id}
          shop={shop}
          onSaved={() => {
            setSaved(true);
            reload();
          }}
        />
        {saved ? <T variant="small">{t('Saved.')}</T> : null}
      </Section>

      <Section title={t('Account')}>
        <AccountPanel />
      </Section>
    </Screen>
  );
}
