import Ionicons from '@expo/vector-icons/Ionicons';
import * as Clipboard from 'expo-clipboard';
import { router, useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Share, View, type ScrollView, type ViewStyle } from 'react-native';

import { AccountPanel } from '@/components/account-panel';
import { ClosedDaysCard } from '@/components/closed-days-card';
import { CustomersCard } from '@/components/customers-card';
import { KeepLiveButton } from '@/components/keep-live-button';
import { ReadyCard } from '@/components/ready-card';
import { ReviewsCard } from '@/components/reviews-card';
import { ShopForm } from '@/components/shop-form';
import { TakingsCard } from '@/components/takings-card';
import { Badge, Button, Card, ErrorText, Row, Screen, ScreenTitle, Section, StaleNote, T } from '@/components/ui';
import { bookingLink } from '@/constants/brand';
import { Spacing } from '@/constants/theme';
import { useNow } from '@/hooks/use-now';
import { useTheme } from '@/hooks/use-theme';
import { confirmAction } from '@/lib/confirm';
import { t } from '@/lib/lang';
import { useMyShop } from '@/lib/my-shop';
import { barberWithoutHours, goLiveGap, type GoLiveGap, type ShopSetup, type StepId } from '@/lib/ready';
import { useShopCards } from '@/lib/shop-cards';
import { useShopReady } from '@/lib/shop-ready';
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
  const { shop, fresh, staleSince: shopStaleSince, reload } = useMyShop();
  // Takings, customers and reviews: last time's numbers at once, then the server's.
  const cards = useShopCards(shop);
  // A new shop's steps to its first booking, and what Go live still needs.
  const ready = useShopReady(shop);
  // The shop itself is asked for once when the app opens. If that failed, last visit's
  // status and details stay, so it is asked for again on coming here and with Try again.
  const [askingShop, setAskingShop] = useState(false);
  const askShop = useCallback(async () => {
    setAskingShop(true);
    await reload();
    setAskingShop(false);
  }, [reload]);
  // Read on focus, so a retry that fails doesn't send another straight away.
  const shopKeptOnly = useRef(false);
  useEffect(() => {
    shopKeptOnly.current = shopStaleSince != null;
  }, [shopStaleSince]);
  useFocusEffect(
    useCallback(() => {
      if (shopKeptOnly.current) askShop();
    }, [askShop]),
  );
  // Any part kept from last visit and not refreshed: said once, with the oldest time.
  const stale = [cards.staleSince, shopStaleSince, ready.staleSince].filter((at): at is number => at != null);
  const staleSince = stale.length ? Math.min(...stale) : null;
  const theme = useTheme();
  const now = useNow();
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Where the parts the ready card's steps scroll to sit on this screen.
  const scroll = useRef<ScrollView>(null);
  const placed = useRef({ status: 0, link: 0, details: 0, location: 0 });

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
  // What customers would be missing if it went live now, as far as is known.
  const gap = !shop.is_published && ready.setup ? goLiveGap(ready.setup) : null;

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
    if (!shop!.is_published) {
      // Asked afresh, as a service may have gone on another phone. Without an
      // answer the database still checks, and its message says what is missing.
      const latest = await ready.reload();
      const missing = latest && goLiveGap(latest);
      if (latest && missing) {
        setBusy(false);
        setError(null);
        return notReady(missing, latest);
      }
    }
    const { error } = await supabase.from('shops').update({ is_published: !shop!.is_published }).eq('id', shop!.id);
    setBusy(false);
    if (error) return setError(errorMessage(error));
    setError(null);
    reload();
  }

  /** Instead of putting live a shop customers can't book: what is missing, and a way there. */
  async function notReady(missing: Exclude<GoLiveGap, null>, setup: ShopSetup) {
    const waiting = barberWithoutHours(setup);
    const [message, action, step]: [string, string, StepId] =
      missing === 'services'
        ? [t('Customers would have nothing to book. Add a service first.'), t('Add a service'), 'services']
        : missing === 'both'
          ? [
              t('Customers would have nothing to book yet. Add a service and set your working hours first.'),
              t('Add a service'),
              'services',
            ]
          : waiting
            ? [
                t('Customers would have no times to pick. Set {name}’s working hours first.', { name: waiting.name }),
                t('Set hours'),
                'barbers',
              ]
            : [
                t('Customers would have nobody to book. Add a barber with working hours first.'),
                t('Add a barber'),
                'barbers',
              ];
    const ok = await confirmAction(t('Not ready to go live yet'), message, action, t('Not now'), false);
    if (ok) openStep(step, setup);
  }

  /** Where each of the ready card's steps is done: another tab, a barber's hours, or further down here. */
  function openStep(id: StepId, setup = ready.setup) {
    const scrollTo = (y: number) => scroll.current?.scrollTo({ y: Math.max(0, y - Spacing.lg), animated: true });
    switch (id) {
      case 'services':
        return router.push('/barber/services');
      case 'barbers': {
        const waiting = setup && barberWithoutHours(setup);
        return waiting
          ? router.push({ pathname: '/barber/hours/[id]', params: { id: waiting.id } })
          : router.push('/barber/team');
      }
      case 'location':
        return scrollTo(placed.current.details + placed.current.location);
      case 'live':
        return scrollTo(placed.current.status);
      case 'share':
        return scrollTo(placed.current.link);
    }
  }

  async function copyLink(text: string) {
    try {
      await Clipboard.setStringAsync(text);
      setCopied(true);
      ready.markShared();
    } catch {
      // The link is on screen to copy by hand.
    }
  }

  return (
    <Screen scrollRef={scroll}>
      <ScreenTitle title={t('My shop')} refreshing={cards.refreshing || askingShop || ready.refreshing} />
      {staleSince ? (
        <StaleNote
          savedAt={staleSince}
          onRetry={() => {
            cards.reload();
            if (shopStaleSince != null) askShop();
            if (ready.staleSince != null) ready.reload();
          }}
          retrying={cards.loading || askingShop || ready.loading}
          timeZone={shop.time_zone}
        />
      ) : null}

      {ready.showsCard && ready.memory ? (
        <ReadyCard
          shop={shop}
          setup={ready.setup}
          memory={ready.memory}
          saidReady={ready.saidReady}
          failed={ready.failed}
          retrying={ready.loading}
          onRetry={ready.reload}
          onStep={(id) => openStep(id)}
          onHide={ready.hide}
        />
      ) : null}

      <View
        onLayout={(e) => {
          placed.current.status = e.nativeEvent.layout.y;
        }}>
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
                : gap === 'services'
                  ? t('Add a service before you go live, so customers have something to book.')
                  : gap === 'hours'
                    ? t('Set your barbers’ working hours before you go live, so customers can pick a time.')
                    : gap === 'both'
                      ? t('Add your services and working hours before you go live, so customers can book.')
                      : billing.tone === 'danger' && !paused
                        ? t('You can go live once you subscribe.')
                        : paused
                          ? t('Customers can’t find you or book from your link. Bookings already made still stand.')
                          : ready.setup
                            ? t('Your services and hours are set. Go live when you’re ready.')
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
          {billing.tone === 'danger' ? null : (
            // While the shop is unpaid, pausing or going live changes nothing for customers.
            <Button
              title={shop.is_published ? t('Pause bookings') : paused ? t('Turn bookings back on') : t('Go live')}
              variant={shop.is_published || needsPlan ? 'secondary' : 'primary'}
              onPress={togglePublished}
              loading={busy}
            />
          )}
        </Card>
      </View>

      <TakingsCard totals={cards.takings} />

      <CustomersCard counts={cards.customers} />

      <ReviewsCard reviews={cards.reviews} />

      <ClosedDaysCard shop={shop} />

      <View
        onLayout={(e) => {
          placed.current.link = e.nativeEvent.layout.y;
        }}>
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
                  : paused
                    ? t('Customers can’t book from this link until you turn bookings back on.')
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
                Share.share({ message: t('Book your next cut at {shop}: {link}', { shop: shop.name, link }) }).then(
                  (result) => {
                    // A browser's sheet answers nothing; an iPhone's says when it was closed without sharing.
                    if (result?.action !== Share.dismissedAction) ready.markShared();
                  },
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
              onPress={() => {
                ready.markShared();
                router.push('/barber/poster');
              }}
            />
            <Button
              title={t('Preview')}
              variant="ghost"
              style={linkAction}
              onPress={() => router.push(`/shop/${shop.slug}`)}
            />
          </Row>
        </Card>
      </View>

      <View
        onLayout={(e) => {
          placed.current.details = e.nativeEvent.layout.y;
        }}>
        <Section title={t('Shop details')}>
          {/* Starts again from the server's details once they arrive, so saving never puts back last visit's. */}
          <ShopForm
            key={fresh ? shop.id : `${shop.id}-kept`}
            shop={shop}
            onSaved={reload}
            onLocationLayout={(y) => {
              placed.current.location = y;
            }}
          />
        </Section>
      </View>

      <Section title={t('Account')}>
        <AccountPanel />
      </Section>
    </Screen>
  );
}
