import * as Clipboard from 'expo-clipboard';
import { router } from 'expo-router';
import { useState } from 'react';
import { Share } from 'react-native';

import { AccountPanel } from '@/components/account-panel';
import { ShopForm } from '@/components/shop-form';
import { Badge, Button, Card, ErrorText, Row, Screen, Section, T } from '@/components/ui';
import { bookingLink } from '@/constants/brand';
import { useMyShop } from '@/lib/my-shop';
import { errorMessage, supabase } from '@/lib/supabase';
import { formatDay } from '@/lib/time';
import type { Shop } from '@/lib/types';

function billingText(shop: Shop): { label: string; tone: 'success' | 'warning' | 'danger' } {
  if (shop.subscription_status === 'active') return { label: 'Subscription active', tone: 'success' };
  const left = Math.ceil((new Date(shop.trial_ends_at).getTime() - Date.now()) / 86400000);
  if (shop.subscription_status === 'trialing' && left > 0) {
    return { label: `Free trial: ${left} ${left === 1 ? 'day' : 'days'} left`, tone: left <= 5 ? 'warning' : 'success' };
  }
  return { label: 'Trial ended, customers can no longer book', tone: 'danger' };
}

export default function MyShop() {
  const { shop, reload } = useMyShop();
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  if (!shop) return null;
  const link = bookingLink(shop.slug);
  const billing = billingText(shop);

  async function togglePublished() {
    setBusy(true);
    const { error } = await supabase.from('shops').update({ is_published: !shop!.is_published }).eq('id', shop!.id);
    setBusy(false);
    if (error) return setError(errorMessage(error));
    setError(null);
    reload();
  }

  return (
    <Screen>
      <T variant="title">My shop</T>

      <Card>
        <Row style={{ justifyContent: 'space-between' }}>
          <T variant="heading">{shop.is_published ? 'You are live' : 'Not live yet'}</T>
          <Badge label={billing.label} tone={billing.tone} />
        </Row>
        <T variant="muted">
          {shop.is_published
            ? 'Customers can find you and book. Share your link everywhere.'
            : 'Go live when your services and hours are ready.'}
        </T>
        {shop.subscription_status === 'trialing' ? (
          <T variant="small">Your free month ends on {formatDay(shop.trial_ends_at, shop.time_zone)}.</T>
        ) : null}
        <ErrorText message={error} />
        <Button
          title={shop.is_published ? 'Pause bookings' : 'Go live'}
          variant={shop.is_published ? 'secondary' : 'primary'}
          onPress={togglePublished}
          loading={busy}
        />
      </Card>

      <Card>
        <T variant="heading">Your booking link</T>
        <T selectable>{link}</T>
        <T variant="small">Put it in your Instagram bio, WhatsApp status and on a poster at the shop.</T>
        <Row>
          <Button
            title="Share"
            onPress={() => Share.share({ message: `Book your next cut at ${shop.name}: ${link}` })}
          />
          <Button
            title={copied ? 'Copied' : 'Copy'}
            variant="secondary"
            onPress={async () => {
              await Clipboard.setStringAsync(link);
              setCopied(true);
            }}
          />
          <Button title="Preview" variant="ghost" onPress={() => router.push(`/shop/${shop.slug}`)} />
        </Row>
      </Card>

      <Section title="Shop details">
        <ShopForm
          key={shop.id}
          shop={shop}
          onSaved={() => {
            setSaved(true);
            reload();
          }}
        />
        {saved ? <T variant="small">Saved.</T> : null}
      </Section>

      <Section title="Account">
        <AccountPanel />
      </Section>
    </Screen>
  );
}
