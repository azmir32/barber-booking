import AsyncStorage from '@react-native-async-storage/async-storage';
import { router, useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { RefreshControl, ScrollView } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Button, Card, Chip, Empty, Field, Row, T } from '@/components/ui';
import { MaxContentWidth, Spacing } from '@/constants/theme';
import { useNow } from '@/hooks/use-now';
import { useTheme } from '@/hooks/use-theme';
import { openStatus } from '@/lib/hours';
import { t } from '@/lib/lang';
import { errorMessage, supabase } from '@/lib/supabase';
import { formatPrice, localDateString } from '@/lib/time';
import type { Shop } from '@/lib/types';

type ShopListing = Pick<Shop, 'id' | 'name' | 'slug' | 'area' | 'address' | 'about'> & {
  from_price: number | null;
  barber_count: number;
  /** Today's first opening and last closing time, e.g. "10:00:00"; null when nobody works today. */
  opens_today: string | null;
  closes_today: string | null;
};
type Area = { area: string; shops: number };

/** Shops per page. One more is asked for, to know whether there are more. */
const PAGE = 20;
/** The area a customer picked last time, so they land on their own area. */
const AREA_KEY = 'potongku.area';

export default function Explore() {
  const theme = useTheme();
  // Keeps "Open now" right while the list stays on screen.
  const now = useNow();
  const [shops, setShops] = useState<ShopListing[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [areas, setAreas] = useState<Area[]>([]);
  const [area, setArea] = useState<string | null>(null);
  const [areaRestored, setAreaRestored] = useState(false);
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

  useEffect(() => {
    AsyncStorage.getItem(AREA_KEY)
      .then((saved) => saved && setArea(saved))
      .catch(() => {})
      .finally(() => setAreaRestored(true));
  }, []);

  const fetchPage = useCallback(
    (offset: number) =>
      supabase.rpc('find_shops', { p_search: query.trim() || null, p_area: area, p_limit: PAGE + 1, p_offset: offset }),
    [query, area],
  );

  const load = useCallback(async () => {
    const request = ++latest.current;
    setLoading(true);
    const { data, error } = await fetchPage(0);
    if (request !== latest.current) return;
    setLoading(false);
    if (error) return setError(errorMessage(error));
    setError(null);
    const rows = (data ?? []) as ShopListing[];
    setShops(rows.slice(0, PAGE));
    setHasMore(rows.length > PAGE);
    setListedOn(localDateString(new Date()));
  }, [fetchPage]);

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
    (next ? AsyncStorage.setItem(AREA_KEY, next) : AsyncStorage.removeItem(AREA_KEY)).catch(() => {});
  }

  const searching = query.trim() !== '';
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
            horizontal
            showsHorizontalScrollIndicator={false}
            accessibilityLabel={t('Area')}
            contentContainerStyle={{ gap: Spacing.sm, paddingHorizontal: Spacing.lg }}
            style={{ marginHorizontal: -Spacing.lg, flexGrow: 0 }}>
            <Chip label={t('All areas')} selected={!area} onPress={() => pickArea(null)} />
            {areaChips.map((a) => (
              <Chip
                key={a.area}
                label={a.area}
                selected={area?.toLowerCase() === a.area.toLowerCase()}
                onPress={() => pickArea(area?.toLowerCase() === a.area.toLowerCase() ? null : a.area)}
              />
            ))}
          </ScrollView>
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
              <Button
                title={t('Show all barbers')}
                variant="secondary"
                onPress={() => {
                  setQuery('');
                  pickArea(null);
                }}
              />
            </Empty>
          ) : (
            <Empty title={t('No barbers yet')} body={t('Barbers in your area are joining soon. Check back shortly.')} />
          )
        ) : null}
        {shops.map((shop) => {
          // The list doesn't send each shop's zone: every shop is in Malaysia, on Kuala Lumpur time.
          const openNow = listedOn === today ? openStatus(shop.opens_today, shop.closes_today, now) : null;
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
