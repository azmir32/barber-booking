// The walk-in queue on a shop's page while it is open: how many wait,
// joining, and the customer's place once in, asked again every 30 seconds
// while they wait.

import { router, useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useEffectEvent, useRef, useState } from 'react';
import { Linking, View } from 'react-native';

import { Bone, Button, Card, Chip, ErrorText, Row, Skeleton, T } from '@/components/ui';
import { Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { useAuth } from '@/lib/auth';
import { confirmAction } from '@/lib/confirm';
import { t } from '@/lib/lang';
import { directionsUrl } from '@/lib/maps';
import {
  barbersInNow,
  placeLine,
  QUEUE_POLL_MS,
  queuedFor,
  queueLine,
  type MyPlace,
  type QueueStatus,
} from '@/lib/queue';
import { errorMessage, supabase } from '@/lib/supabase';
import { formatDuration, formatPrice } from '@/lib/time';
import type { Barber, Service, Shop, WorkingHours } from '@/lib/types';

type QueueBarber = Pick<Barber, 'id' | 'name' | 'is_active'> & {
  working_hours: Pick<WorkingHours, 'weekday' | 'opens_at' | 'closes_at'>[];
};

/**
 * Above the booking steps on a queue shop's page: while it is open, how many
 * wait and about how long, and Join the queue (a service, and a barber in
 * now or any). Once in, the customer's place and Leave; once called, that it
 * is their turn. Nothing while the shop is closed or its queue is off.
 */
export function ShopQueueCard({
  shop,
  services,
  barbers,
  serviceId,
  likelyOpen,
  now,
}: {
  shop: Pick<Shop, 'id' | 'name' | 'slug' | 'time_zone' | 'queue_enabled' | 'address' | 'area' | 'latitude' | 'longitude'>;
  services: Service[];
  barbers: QueueBarber[];
  /** The service picked further down, to start from. */
  serviceId: string | null;
  /** Today's hours say the shop is open, so a place for the card is kept while it loads. */
  likelyOpen: boolean;
  now: number;
}) {
  const theme = useTheme();
  const { session } = useAuth();
  const uid = session?.user.id ?? null;
  const [status, setStatus] = useState<{ uid: string | null; value: QueueStatus } | null>(null);
  const [picking, setPicking] = useState(false);
  const [pickedService, setPickedService] = useState<string | null>(null);
  const [pickedBarber, setPickedBarber] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Set while a guest signs up to join; once they are back and signed in, they join.
  const pendingJoin = useRef(false);

  const load = useCallback(async () => {
    if (!shop.queue_enabled) return;
    const { data, error: failed } = await supabase.rpc('queue_status', { p_shop_id: shop.id });
    // A failed refresh keeps the last answer: the next one is half a minute away.
    if (!failed && data) setStatus({ uid, value: data as QueueStatus });
  }, [shop.id, shop.queue_enabled, uid]);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );
  // An answer from before signing in or out says nothing about this customer's place.
  const value = status && status.uid === uid ? status.value : null;
  const mine = value?.mine ?? null;
  const waiting = Boolean(mine);
  // One small request every 30 seconds while they wait, and only while the page is in front.
  useFocusEffect(
    useCallback(() => {
      if (!waiting) return;
      const id = setInterval(load, QUEUE_POLL_MS);
      return () => clearInterval(id);
    }, [waiting, load]),
  );

  const service = services.find((s) => s.id === (pickedService ?? serviceId));
  const inNow = barbersInNow(barbers, [], now, shop.time_zone);
  const barber = inNow.find((b) => b.id === pickedBarber) ?? null;

  async function join() {
    if (!service) return;
    if (!session) {
      // Sign-up comes back to this page with the picks intact, then the effect below joins.
      pendingJoin.current = true;
      const what = barber
        ? t('{service} with {barber} at {shop}', { service: service.name, barber: barber.name, shop: shop.name })
        : t('{service} at {shop}', { service: service.name, shop: shop.name });
      router.push({
        pathname: '/sign-up',
        params: { next: `/shop/${shop.slug}`, role: 'customer', wait: 'queue', summary: what },
      });
      return;
    }
    setBusy(true);
    setError(null);
    const { error: failed } = await supabase.rpc('join_queue', { p_service_id: service.id, p_barber_id: barber?.id ?? null });
    if (failed) setError(errorMessage(failed));
    else setPicking(false);
    await load();
    setBusy(false);
  }

  async function leave(place: MyPlace) {
    const ok = await confirmAction(t('Leave the queue?'), t('If you join again, you go to the end of it.'), t('Leave'));
    if (!ok) return;
    setBusy(true);
    setError(null);
    const { error: failed } = await supabase.rpc('leave_queue', { p_id: place.id });
    if (failed) setError(errorMessage(failed));
    await load();
    setBusy(false);
  }

  const joinAfterSignUp = useEffectEvent(() => {
    if (!pendingJoin.current) return;
    pendingJoin.current = false;
    join();
  });
  useEffect(() => {
    if (session) joinAfterSignUp();
  }, [session]);
  // Back here still signed out means they left sign-up, so a later sign-in must not join on its own.
  useFocusEffect(
    useCallback(() => {
      if (!session) pendingJoin.current = false;
    }, [session]),
  );

  if (!shop.queue_enabled) return null;
  if (!value) {
    return likelyOpen ? (
      <Skeleton label={t('Loading the queue')}>
        <Card>
          <Bone width="40%" height={20} />
          <Bone width="65%" />
          <Bone height={48} />
        </Card>
      </Skeleton>
    ) : null;
  }

  if (mine?.state === 'called') {
    return (
      <Card style={{ borderColor: theme.success, borderWidth: 2 }}>
        <T variant="heading">{t('Walk-in queue')}</T>
        <T variant="label" role="status" accessibilityLiveRegion="polite" style={{ color: theme.success }}>
          {t('It’s your turn. Head to the shop now.')}
        </T>
        <Row>
          <Button title={t('Directions')} variant="secondary" onPress={() => Linking.openURL(directionsUrl(shop))} />
          <Button
            title={t('Leave')}
            accessibilityLabel={t('Leave the queue')}
            variant="secondary"
            tone="danger"
            loading={busy}
            onPress={() => leave(mine)}
          />
        </Row>
        <ErrorText message={error} />
      </Card>
    );
  }

  if (mine) {
    const asked = services.find((s) => s.id === mine.service_id);
    const askedBarber = barbers.find((b) => b.id === mine.barber_id);
    return (
      <Card>
        <T variant="heading">{t('Walk-in queue')}</T>
        {/* Read out when it changes, as the place moves up while the page is open. */}
        <T variant="label" role="status" accessibilityLiveRegion="polite">
          {placeLine(mine)}
        </T>
        {asked ? (
          <T variant="small">{queuedFor({ service_name: asked.name, barber_name: askedBarber?.name ?? null })}</T>
        ) : null}
        <T variant="small">{t('Stay close by. This page and My bookings say when it’s your turn.')}</T>
        <Button
          title={t('Leave')}
          accessibilityLabel={t('Leave the queue')}
          variant="secondary"
          tone="danger"
          loading={busy}
          onPress={() => leave(mine)}
        />
        <ErrorText message={error} />
      </Card>
    );
  }

  if (!value.open) return null;
  return (
    <Card>
      <T variant="heading">{t('Walk-in queue')}</T>
      <T variant="label" role="status" accessibilityLiveRegion="polite">
        {queueLine(value)}
      </T>
      {picking ? (
        <View style={{ gap: Spacing.md }}>
          <View style={{ gap: Spacing.sm }}>
            <T variant="label">{t('Service')}</T>
            <Row role="radiogroup" accessibilityLabel={t('Service')}>
              {services.map((s) => (
                <Chip
                  key={s.id}
                  label={s.name}
                  sublabel={`${formatDuration(s.duration_min)} · ${formatPrice(s.price)}`}
                  selected={s.id === service?.id}
                  onPress={() => setPickedService(s.id)}
                />
              ))}
            </Row>
          </View>
          {inNow.length > 1 ? (
            <View style={{ gap: Spacing.sm }}>
              <T variant="label">{t('Barber')}</T>
              <Row role="radiogroup" accessibilityLabel={t('Barber')}>
                <Chip label={t('Any barber')} selected={barber === null} onPress={() => setPickedBarber(null)} />
                {inNow.map((b) => (
                  <Chip key={b.id} label={b.name} selected={barber?.id === b.id} onPress={() => setPickedBarber(b.id)} />
                ))}
              </Row>
            </View>
          ) : null}
          <Button
            title={session ? t('Join the queue') : t('Continue to join')}
            disabled={!service}
            loading={busy}
            onPress={join}
          />
          <Button title={t('Not now')} variant="ghost" onPress={() => setPicking(false)} />
        </View>
      ) : (
        <>
          <T variant="small">{t('No time needed. Join now and come in when it’s your turn.')}</T>
          <Button title={t('Join the queue')} variant="secondary" onPress={() => setPicking(true)} />
        </>
      )}
      <ErrorText message={error} />
    </Card>
  );
}
