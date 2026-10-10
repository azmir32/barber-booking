import AsyncStorage from '@react-native-async-storage/async-storage';
import { router, useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { RefreshControl, ScrollView, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { ReturningCards } from '@/components/returning-cards';
import { Button, Card, Chip, Empty, Field, Row, T } from '@/components/ui';
import { MaxContentWidth, Spacing } from '@/constants/theme';
import { useNow } from '@/hooks/use-now';
import { useTheme } from '@/hooks/use-theme';
import { useAuth } from '@/lib/auth';
import { nextFreeLine, openStatus } from '@/lib/hours';
import { t } from '@/lib/lang';
import type { MyShops } from '@/lib/my-shops';
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
};
type Area = { area: string; shops: number };

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

  useEffect(() => {
    AsyncStorage.getItem(AREA_KEY)
      .then((saved) => {
        if (!saved) return;
        revealSavedArea.current = true;
        setArea(saved);
      })
      .catch(() => {})
      .finally(() => setAreaRestored(true));
  }, []);

  const fetchPage = useCallback(
    (offset: number) =>
      supabase.rpc('find_shops', { p_search: query.trim() || null, p_area: area, p_limit: PAGE + 1, p_offset: offset }),
    [query, area],
  );

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

  const load = useCallback(async () => {
    const request = ++latest.current;
    setLoading(true);
    // then() sends the list's request now, so the cards' one goes alongside it, never ahead.
    const page = fetchPage(0).then((res) => res);
    // Searching or picking an area hides the cards, so they wait until both are cleared.
    if (!query.trim() && !areaPicked) loadMine();
    const { data, error } = await page;
    if (request !== latest.current) return;
    setLoading(false);
    if (error) return setError(errorMessage(error));
    setError(null);
    const rows = (data ?? []) as ShopListing[];
    setShops(rows.slice(0, PAGE));
    setHasMore(rows.length > PAGE);
    setListedOn(localDateString(new Date()));
  }, [fetchPage, loadMine, query, areaPicked]);

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
    setArea(next);
    setAreaPicked(next !== null);
    (next ? AsyncStorage.setItem(AREA_KEY, next) : AsyncStorage.removeItem(AREA_KEY)).catch(() => {});
  }

  /** Back to every area, with "All areas" in view again. */
  function showAllAreas() {
    pickArea(null);
    chipsRef.current?.scrollTo({ x: 0, animated: true });
  }

  const searching = query.trim() !== '';
  // Only the signed-in customer's own, and out of the way while they look for something else.
  // The area remembered from last time still filters the list, but they came back for their barber.
  const returning = !searching && !areaPicked && mine && mine.uid === uid ? mine : null;
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
        {areaChips.length > 1 ? (
          <ScrollView
            ref={chipsRef}
            horizontal
            showsHorizontalScrollIndicator={false}
            accessibilityLabel={t('Area')}
            contentContainerStyle={{ gap: Spacing.sm, paddingHorizontal: Spacing.lg }}
            style={{ marginHorizontal: -Spacing.lg, flexGrow: 0 }}>
            <Chip label={t('All areas')} selected={!area} onPress={() => pickArea(null)} />
            {areaChips.map((a) => {
              const selected = area?.toLowerCase() === a.area.toLowerCase();
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
        {area ? (
          <Row style={{ flexWrap: 'nowrap', marginVertical: -Spacing.sm }}>
            <T variant="small" style={{ flex: 1 }}>
              {t('Showing barbers in {area}', { area })}
            </T>
            <Button title={t('Show all')} variant="ghost" onPress={showAllAreas} />
          </Row>
        ) : null}
        {returning ? (
          <ReturningCards
            mine={returning}
            now={now}
            listTitle={area ? t('Barbers in {area}', { area }) : t('All barbers')}
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
                    showAllAreas();
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
              <T variant="heading">{shop.name}</T>
              <T variant="muted">{shop.address || shop.area}</T>
              {shop.about ? (
                <T numberOfLines={2} variant="small">
                  {shop.about}
                </T>
              ) : null}
              <Row>
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
