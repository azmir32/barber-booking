import AsyncStorage from '@react-native-async-storage/async-storage';
import { router, useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useEffectEvent, useRef, useState } from 'react';
import { Linking, Platform, RefreshControl, ScrollView, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Distance } from '@/components/distance';
import { RatingSummary } from '@/components/reviews';
import { ReturningCards } from '@/components/returning-cards';
import { Button, Card, Chip, Empty, Field, Row, T } from '@/components/ui';
import { APP_NAME } from '@/constants/brand';
import { MaxContentWidth, Spacing } from '@/constants/theme';
import { useNow } from '@/hooks/use-now';
import { useTheme } from '@/hooks/use-theme';
import { useAuth } from '@/lib/auth';
import type { LatLng } from '@/lib/distance';
import { nextFreeLine, openStatus } from '@/lib/hours';
import { t } from '@/lib/lang';
import type { MyShops } from '@/lib/my-shops';
import {
  locate,
  nearMePosition,
  nearMeWasOn,
  rememberNearMe,
  setNearMePosition,
  type LocateProblem,
} from '@/lib/near-me';
import { errorMessage, supabase } from '@/lib/supabase';
import { formatPrice, localDateString } from '@/lib/time';
import type { Shop } from '@/lib/types';

type ShopListing = Pick<Shop, 'id' | 'name' | 'slug' | 'area' | 'address' | 'about'> & {
  from_price: number | null;
  barber_count: number;
  /** Today's first opening and last closing time, e.g. "10:00:00"; null when nobody works today. */
  opens_today: string | null;
  closes_today: string | null;
  /** The earliest free start for the shortest service, today or else tomorrow; null when neither has one. */
  next_free_at: string | null;
  rating_count: number;
  /** Average stars to one decimal; null with no reviews. */
  rating_avg: number | null;
  /** How far the shop is with Near me on; null without it, or when the shop hasn't set its location. */
  distance_km: number | null;
};
type Area = { area: string; shops: number };
/**
 * Near me: off; asking the phone where it is (the list stays as it was
 * until it answers); or on, with the list nearest first. Near me and an
 * area are one choice or the other. A search still filters with Near me
 * on, and what it finds stays nearest first.
 */
type Near = 'off' | 'finding' | 'on';

/** Shops per page. One more is asked for, to know whether there are more. */
const PAGE = 20;
/** The area a customer picked last time, so they land on their own area. */
const AREA_KEY = 'potongku.area';

export default function Explore() {
  const theme = useTheme();
  const uid = useAuth().session?.user.id;
  // Keeps "Open now" and "Free now" right while the list stays on screen.
  const now = useNow();
  const [shops, setShops] = useState<ShopListing[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [areas, setAreas] = useState<Area[]>([]);
  const [area, setArea] = useState<string | null>(null);
  const [areaRestored, setAreaRestored] = useState(false);
  // An area picked on this visit, rather than the one remembered from the last.
  const [areaPicked, setAreaPicked] = useState(false);
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Only the newest search fills the list; slower answers to older ones are dropped.
  const latest = useRef(0);
  // Today's hours come with the list, so after midnight it is fetched again.
  const today = localDateString(new Date(now));
  const [listedOn, setListedOn] = useState(today);
  const chipsRef = useRef<ScrollView>(null);
  // A saved area's chip can sit past the right edge of a small phone; it is scrolled into view once.
  const revealSavedArea = useRef(false);
  // A returning customer's next cut and their barbers, and whose they are.
  const [mine, setMine] = useState<(MyShops & { uid: string }) | null>(null);
  const latestMine = useRef(0);
  const mineSent = useRef(false);
  const [near, setNear] = useState<Near>('off');
  // Where the customer is, to about 100 m, while Near me is on. Never saved.
  const [here, setHere] = useState<LatLng | null>(null);
  const [nearProblem, setNearProblem] = useState<LocateProblem | null>(null);
  // Near me tapped on this visit, rather than kept on from the last.
  const [nearPicked, setNearPicked] = useState(false);
  // Only the newest tap of Near me counts; turning it off drops a position still on its way.
  const latestFind = useRef(0);

  async function findMe(picked: boolean) {
    const request = ++latestFind.current;
    setNear('finding');
    setNearProblem(null);
    const found = await locate();
    if (request !== latestFind.current) return;
    if ('problem' in found) {
      setNear('off');
      setNearProblem(found.problem);
      setNearMePosition(null);
      rememberNearMe(false);
      return;
    }
    setNearMePosition(found.position);
    setHere(nearMePosition());
    setNear('on');
    setNearPicked(picked);
    rememberNearMe(true);
    // Nearest first across every area, so the area filter goes.
    setArea(null);
    setAreaPicked(false);
    AsyncStorage.removeItem(AREA_KEY).catch(() => {});
  }

  function stopNearMe() {
    latestFind.current++;
    setNear('off');
    setHere(null);
    setNearPicked(false);
    setNearMePosition(null);
    rememberNearMe(false);
  }

  const loadMine = useCallback(async () => {
    const request = ++latestMine.current;
    // Asked of the client rather than taken from the screen's state, so the
    // session arriving after the first load doesn't send the list again.
    const who = (await supabase.auth.getSession()).data.session?.user.id;
    if (!who) return setMine(null);
    const { data, error } = await supabase.rpc('my_shops');
    // Nothing to say on failure: the list below is what matters, and the cards come back on the next load.
    if (request !== latestMine.current || error || !data) return;
    setMine({ ...(data as MyShops), uid: who });
  }, []);

  const restore = useEffectEvent(async (saved: string | null, wasNear: boolean) => {
    if (wasNear) {
      // Their next cut and barbers don't need the position, so they don't wait for it.
      mineSent.current = true;
      loadMine();
      // They may have moved since, so it asks for where they are now. The
      // list waits a moment for it rather than jumping, but not for long.
      const release = setTimeout(() => setAreaRestored(true), 4000);
      await findMe(false);
      clearTimeout(release);
    } else if (saved) {
      revealSavedArea.current = true;
      setArea(saved);
    }
    setAreaRestored(true);
  });

  useEffect(() => {
    Promise.all([AsyncStorage.getItem(AREA_KEY).catch(() => null), nearMeWasOn()]).then(([saved, wasNear]) =>
      restore(saved, wasNear),
    );
  }, []);

  const at = near === 'on' ? here : null;
  const fetchPage = useCallback(
    (offset: number) =>
      supabase.rpc('find_shops', {
        p_search: query.trim() || null,
        p_area: area,
        p_limit: PAGE + 1,
        p_offset: offset,
        // Sent in the request's body, never its address, so it stays out of server logs.
        ...(at ? { p_lat: at.latitude, p_lng: at.longitude } : null),
      }),
    [query, area, at],
  );

  const load = useCallback(async () => {
    const request = ++latest.current;
    setLoading(true);
    // then() sends the list's request now, so the cards' one goes alongside it, never ahead.
    const page = fetchPage(0).then((res) => res);
    // Searching, picking an area or tapping Near me hides the cards, so they wait until those are cleared.
    // On opening with Near me kept they were sent already, while the list waited for the position.
    if (mineSent.current) mineSent.current = false;
    else if (!query.trim() && !areaPicked && !nearPicked) loadMine();
    const { data, error } = await page;
    if (request !== latest.current) return;
    setLoading(false);
    if (error) return setError(errorMessage(error));
    setError(null);
    const rows = (data ?? []) as ShopListing[];
    setShops(rows.slice(0, PAGE));
    setHasMore(rows.length > PAGE);
    setListedOn(localDateString(new Date()));
  }, [fetchPage, loadMine, query, areaPicked, nearPicked]);

  async function loadMore() {
    const request = latest.current;
    setLoadingMore(true);
    const { data, error } = await fetchPage(shops.length);
    setLoadingMore(false);
    if (request !== latest.current) return;
    if (error) return setError(errorMessage(error));
    const rows = (data ?? []) as ShopListing[];
    setShops((prev) => [...prev, ...rows.slice(0, PAGE).filter((r) => !prev.some((p) => p.id === r.id))]);
    setHasMore(rows.length > PAGE);
  }

  const loadAreas = useCallback(async () => {
    const { data } = await supabase.rpc('shop_areas');
    // The busiest areas only; search finds the rest.
    if (data) setAreas((data as Area[]).slice(0, 12));
  }, []);

  // Typing waits for a short pause before searching; everything else loads at once.
  useFocusEffect(
    useCallback(() => {
      if (!areaRestored) return;
      const timer = setTimeout(load, query.trim() ? 300 : 0);
      return () => clearTimeout(timer);
    }, [areaRestored, load, query]),
  );
  useFocusEffect(
    useCallback(() => {
      loadAreas();
    }, [loadAreas]),
  );

  useEffect(() => {
    if (!areaRestored || listedOn === today) return;
    const timer = setTimeout(load, 0);
    return () => clearTimeout(timer);
  }, [areaRestored, listedOn, today, load]);

  function pickArea(next: string | null) {
    if (near !== 'off') stopNearMe();
    setNearProblem(null);
    setArea(next);
    setAreaPicked(next !== null);
    (next ? AsyncStorage.setItem(AREA_KEY, next) : AsyncStorage.removeItem(AREA_KEY)).catch(() => {});
  }

  /** Back to every area, with "All areas" in view again. */
  function showAllAreas() {
    pickArea(null);
    chipsRef.current?.scrollTo({ x: 0, animated: true });
  }

  function tapNearMe() {
    setNearProblem(null);
    if (near === 'off') findMe(true);
    else stopNearMe();
  }

  const searching = query.trim() !== '';
  // Only the signed-in customer's own, and out of the way while they look for something else.
  // The area or Near me remembered from last time still sorts the list, but they came back for their barber.
  const returning = !searching && !areaPicked && !nearPicked && mine && mine.uid === uid ? mine : null;
  // While Near me looks for the customer the area still filters the list, but its chip is no longer the one picked.
  const areaShown = near === 'off' ? area : null;
  // The saved area may have no live shops any more; keep its chip so it can be cleared.
  const areaChips =
    area && areas.length && !areas.some((a) => a.area.toLowerCase() === area.toLowerCase())
      ? [...areas, { area, shops: 0 }]
      : areas;

  return (
    <SafeAreaView edges={['top']} style={{ flex: 1, backgroundColor: theme.background }}>
      <ScrollView
        contentContainerStyle={{
          padding: Spacing.lg,
          gap: Spacing.lg,
          width: '100%',
          maxWidth: MaxContentWidth,
          alignSelf: 'center',
        }}
        keyboardShouldPersistTaps="handled"
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            tintColor={theme.tint}
            colors={[theme.tint]}
            onRefresh={async () => {
              setRefreshing(true);
              await Promise.all([load(), loadAreas()]);
              setRefreshing(false);
            }}
          />
        }>
        <T variant="title">{t('Find a barber')}</T>
        <Field
          label={t('Search')}
          value={query}
          onChangeText={setQuery}
          placeholder={t('Shop name or area, e.g. Sungai Chua')}
          returnKeyType="search"
          autoCorrect={false}
          clearButtonMode="while-editing"
        />
        {areas.length ? (
          <ScrollView
            ref={chipsRef}
            horizontal
            showsHorizontalScrollIndicator={false}
            accessibilityLabel={t('Area')}
            contentContainerStyle={{ gap: Spacing.sm, paddingHorizontal: Spacing.lg }}
            style={{ marginHorizontal: -Spacing.lg, flexGrow: 0 }}>
            <Chip label={t('Near me')} icon="navigate-outline" selected={near !== 'off'} onPress={tapNearMe} />
            {areaChips.length > 1 ? (
              <Chip label={t('All areas')} selected={near === 'off' && !area} onPress={() => pickArea(null)} />
            ) : null}
            {(areaChips.length > 1 ? areaChips : []).map((a) => {
              const selected = areaShown?.toLowerCase() === a.area.toLowerCase();
              return (
                <View
                  key={a.area}
                  onLayout={
                    selected
                      ? (e) => {
                          if (!revealSavedArea.current) return;
                          revealSavedArea.current = false;
                          const x = e.nativeEvent.layout.x - Spacing.lg;
                          chipsRef.current?.scrollTo({ x: Math.max(0, x), animated: false });
                        }
                      : undefined
                  }>
                  <Chip label={a.area} selected={selected} onPress={() => pickArea(selected ? null : a.area)} />
                </View>
              );
            })}
          </ScrollView>
        ) : null}
        {/* The filter is remembered between visits, so say it is on even when its chip is off screen. */}
        {areaShown ? (
          <Row style={{ flexWrap: 'nowrap', marginVertical: -Spacing.sm }}>
            <T variant="small" style={{ flex: 1 }}>
              {t('Showing barbers in {area}', { area: areaShown })}
            </T>
            <Button title={t('Show all')} variant="ghost" onPress={showAllAreas} />
          </Row>
        ) : null}
        {near === 'finding' ? (
          <T variant="small" role="status" accessibilityLiveRegion="polite">
            {t('Finding where you are…')}
          </T>
        ) : nearProblem ? (
          <NearMeProblem problem={nearProblem} />
        ) : null}
        {returning ? (
          <ReturningCards
            mine={returning}
            now={now}
            listTitle={
              near !== 'off'
                ? t('Barbers near you')
                : areaShown
                  ? t('Barbers in {area}', { area: areaShown })
                  : t('All barbers')
            }
          />
        ) : null}
        {error ? (
          <Empty title={t('Couldn’t load barbers')} body={t('Check your connection and try again.')}>
            <Button title={t('Try again')} variant="secondary" onPress={load} />
          </Empty>
        ) : null}
        {loading && shops.length === 0 && !error ? <T variant="muted">{t('Loading barbers…')}</T> : null}
        {!loading && !error && shops.length === 0 ? (
          searching || area ? (
            <Empty title={t('No matches')} body={t('Try another name or area.')}>
              {/* A search inside one area can miss a shop in the next; one tap looks everywhere. */}
              {searching && area ? (
                <Button title={t('Search all areas')} variant="secondary" onPress={showAllAreas} />
              ) : (
                <Button
                  title={t('Show all barbers')}
                  variant="secondary"
                  onPress={() => {
                    setQuery('');
                    // With Near me on, every barber is still nearest first.
                    if (near === 'off') showAllAreas();
                  }}
                />
              )}
            </Empty>
          ) : (
            <Empty title={t('No barbers yet')} body={t('Barbers in your area are joining soon. Check back shortly.')} />
          )
        ) : null}
        {shops.map((shop) => {
          // The list doesn't send each shop's zone: every shop is in Malaysia, on Kuala Lumpur time.
          const openNow = listedOn === today ? openStatus(shop.opens_today, shop.closes_today, now) : null;
          const nextFree = openNow ? nextFreeLine(shop.next_free_at, openNow.state, now, undefined, shop.opens_today) : null;
          return (
            <Card
              key={shop.id}
              role="link"
              onPress={() => router.push({ pathname: '/shop/[slug]', params: { slug: shop.slug, name: shop.name } })}>
              <Row style={{ flexWrap: 'nowrap', alignItems: 'flex-start' }}>
                <T variant="heading" style={{ flex: 1 }}>
                  {shop.name}
                </T>
                {/* Level with the name's first line. */}
                {shop.distance_km != null ? <Distance km={Number(shop.distance_km)} style={{ marginTop: 3 }} /> : null}
              </Row>
              <T variant="muted">{shop.address || shop.area}</T>
              {shop.about ? (
                <T numberOfLines={2} variant="small">
                  {shop.about}
                </T>
              ) : null}
              <Row>
                <RatingSummary average={shop.rating_avg == null ? null : Number(shop.rating_avg)} count={shop.rating_count} />
                {shop.from_price != null ? (
                  <T variant="label">{t('From {price}', { price: formatPrice(Number(shop.from_price)) })}</T>
                ) : null}
                {shop.barber_count ? (
                  <T variant="small">
                    {shop.barber_count === 1 ? t('1 barber') : t('{count} barbers', { count: shop.barber_count })}
                  </T>
                ) : null}
              </Row>
              {openNow ? (
                <T variant="label" style={{ color: openNow.state === 'open' ? theme.success : theme.textSecondary }}>
                  {openNow.label}
                </T>
              ) : null}
              {nextFree ? (
                <T variant="small" style={nextFree.soon ? { color: theme.success } : undefined}>
                  {nextFree.label}
                </T>
              ) : null}
            </Card>
          );
        })}
        {hasMore && !error ? (
          <Button title={t('Show more barbers')} variant="secondary" loading={loadingMore} onPress={loadMore} />
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}

/** Why Near me couldn't turn on, and how to let it: one line, with the phone's Settings a tap away. */
function NearMeProblem({ problem }: { problem: LocateProblem }) {
  const settings = problem === 'denied' && Platform.OS !== 'web';
  return (
    <Row style={{ flexWrap: 'nowrap', marginVertical: settings ? -Spacing.sm : 0 }}>
      <T variant="small" role="alert" accessibilityLiveRegion="polite" style={{ flex: 1 }}>
        {problem === 'blocked'
          ? t('Location isn’t available on this page. Pick your area instead.')
          : problem === 'unavailable'
            ? t('Couldn’t find where you are. Check that location is on, then tap Near me again.')
            : Platform.OS === 'web'
              ? t('Your browser is blocking location. Allow it for this site, then tap Near me again.')
              : t('Location is off for {app}. Allow it in Settings to see barbers near you.', { app: APP_NAME })}
      </T>
      {settings ? <Button title={t('Settings')} variant="ghost" onPress={() => Linking.openSettings()} /> : null}
    </Row>
  );
}
