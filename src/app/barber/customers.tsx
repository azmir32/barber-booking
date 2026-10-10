import AsyncStorage from '@react-native-async-storage/async-storage';
import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Linking, StyleSheet, View } from 'react-native';

import { Badge, Button, Card, Empty, Field, IconButton, Screen, Section, T } from '@/components/ui';
import { bookingLink } from '@/constants/brand';
import { Spacing } from '@/constants/theme';
import { useNow } from '@/hooks/use-now';
import { useTheme } from '@/hooks/use-theme';
import {
  customerCounts,
  daysSince,
  inviteMessage,
  lastCutLabel,
  noShowsLabel,
  timeSpan,
  usualGapLabel,
  visitsLabel,
  type ShopCustomer,
} from '@/lib/customers';
import { t } from '@/lib/lang';
import { useMyShop } from '@/lib/my-shop';
import { whatsappUrl } from '@/lib/phone';
import { errorMessage, supabase } from '@/lib/supabase';
import { formatDay, formatTime } from '@/lib/time';

/** Customers per page. One more is asked for, to know whether there are more. */
const PAGE = 30;
/** When this phone last sent each customer an invite, so nobody gets asked twice by mistake. */
const INVITED_KEY = 'potongku.invited';
const INVITE_MEMORY_MS = 90 * 86_400_000;

const call = (phone: string) => Linking.openURL(`tel:${phone.replace(/[^\d+]/g, '')}`).catch(() => {});

/** Everyone who has been in or booked, with who is due for a cut first. */
export default function Customers() {
  const { shop } = useMyShop();
  const now = useNow();
  const [rows, setRows] = useState<ShopCustomer[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [invited, setInvited] = useState<Record<string, string>>({});
  // Only the newest search fills the list; slower answers to older ones are dropped.
  const latest = useRef(0);

  useEffect(() => {
    AsyncStorage.getItem(INVITED_KEY)
      .then((saved) => saved && setInvited(JSON.parse(saved)))
      .catch(() => {});
  }, []);

  const fetchPage = useCallback(
    (offset: number) =>
      supabase.rpc('shop_customers', { p_search: query.trim() || null, p_limit: PAGE + 1, p_offset: offset }),
    [query],
  );

  const load = useCallback(async () => {
    const request = ++latest.current;
    setLoading(true);
    const { data, error } = await fetchPage(0);
    if (request !== latest.current) return;
    setLoading(false);
    if (error) return setError(errorMessage(error));
    setError(null);
    const page = (data ?? []) as ShopCustomer[];
    setRows(page.slice(0, PAGE));
    setHasMore(page.length > PAGE);
  }, [fetchPage]);

  async function loadMore() {
    const request = latest.current;
    setLoadingMore(true);
    const { data, error } = await fetchPage(rows.length);
    setLoadingMore(false);
    if (request !== latest.current) return;
    if (error) return setError(errorMessage(error));
    const page = (data ?? []) as ShopCustomer[];
    setRows((prev) => [
      ...prev,
      ...page.slice(0, PAGE).filter((r) => !prev.some((p) => p.customer_key === r.customer_key)),
    ]);
    setHasMore(page.length > PAGE);
  }

  // On focus, so someone booked meanwhile is no longer due. Typing waits for a short pause.
  useFocusEffect(
    useCallback(() => {
      const timer = setTimeout(load, query.trim() ? 300 : 0);
      return () => clearTimeout(timer);
    }, [load, query]),
  );

  if (!shop) return null;
  const tz = shop.time_zone;

  /** Saves who was invited when (null takes one back), forgetting invites too old to matter. */
  function remember(key: string, when: string | null) {
    setInvited((prev) => {
      const next = Object.fromEntries(
        Object.entries({ ...prev, [key]: when }).filter(
          (entry): entry is [string, string] => entry[1] != null && now - Date.parse(entry[1]) < INVITE_MEMORY_MS,
        ),
      );
      AsyncStorage.setItem(INVITED_KEY, JSON.stringify(next)).catch(() => {});
      return next;
    });
  }

  function invite(c: ShopCustomer) {
    if (!c.phone || !c.last_visit_at) return;
    const message = inviteMessage(
      { name: c.name, shop: shop!.name, link: bookingLink(shop!.slug) },
      c.last_visit_at,
      now,
      tz,
    );
    Linking.openURL(whatsappUrl(c.phone, message)).catch(() => {});
    remember(c.customer_key, new Date(now).toISOString());
  }

  const searching = query.trim() !== '';
  const counts = customerCounts(rows[0]?.total_count ?? 0, rows[0]?.due_count ?? 0);
  const due = rows.filter((r) => r.is_due);
  const others = rows.filter((r) => !r.is_due);
  const card = (c: ShopCustomer) => (
    <CustomerCard
      key={c.customer_key}
      customer={c}
      tz={tz}
      now={now}
      invitedAt={invited[c.customer_key] ?? null}
      onInvite={() => invite(c)}
      // For an invite that never went out, e.g. WhatsApp was closed without sending.
      onUndoInvite={() => remember(c.customer_key, null)}
    />
  );

  return (
    <Screen edges={['bottom']} onRefresh={load}>
      <Field
        label={t('Search')}
        value={query}
        onChangeText={setQuery}
        placeholder={t('Name or phone number')}
        returnKeyType="search"
        autoCorrect={false}
        clearButtonMode="while-editing"
      />
      {rows.length > 0 ? <T variant="muted">{counts}</T> : null}

      {error ? (
        <Empty title={t('Couldn’t load your customers')} body={t('Check your connection and try again.')}>
          <Button title={t('Try again')} variant="secondary" onPress={load} />
        </Empty>
      ) : null}
      {loading && rows.length === 0 && !error ? <T variant="muted">{t('Loading customers…')}</T> : null}
      {!loading && !error && rows.length === 0 ? (
        searching ? (
          <Empty title={t('No matches')} body={t('Try another name or number.')}>
            <Button title={t('Show everyone')} variant="secondary" onPress={() => setQuery('')} />
          </Empty>
        ) : (
          <Empty
            title={t('No customers yet')}
            body={t('Everyone who books, online or added by you, shows up here with how often they come.')}
          />
        )
      ) : null}

      {due.length > 0 ? (
        <Section title={t('Due for a cut')}>
          <T variant="small">
            {t('Their usual time between cuts has passed, and nothing is booked yet. Anyone away much longer is under Everyone.')}
          </T>
          <View style={styles.list}>{due.map(card)}</View>
        </Section>
      ) : null}
      {others.length > 0 ? (
        <Section title={t('Everyone')}>
          <View style={styles.list}>{others.map(card)}</View>
        </Section>
      ) : null}
      {hasMore && !error ? (
        <Button title={t('Show more')} variant="secondary" loading={loadingMore} onPress={loadMore} />
      ) : null}
    </Screen>
  );
}

/**
 * One customer: their number, when they last came and how often, with
 * WhatsApp and Call for anyone with a number. Anyone whose usual gap has
 * passed with nothing booked also gets a ready-written invite: those due for
 * a cut, and those away so long they have dropped off that list.
 */
function CustomerCard({
  customer: c,
  tz,
  now,
  invitedAt,
  onInvite,
  onUndoInvite,
}: {
  customer: ShopCustomer;
  tz: string;
  now: number;
  invitedAt: string | null;
  onInvite: () => void;
  onUndoInvite: () => void;
}) {
  const theme = useTheme();
  const name = c.name ?? t('Customer');
  const habit = [c.visits > 0 ? visitsLabel(c.visits) : null, c.visits >= 2 ? usualGapLabel(c.usual_gap_days) : null]
    .filter(Boolean)
    .join(' · ');
  const sinceLastCut = c.last_visit_at ? daysSince(c.last_visit_at, now, tz) : null;
  const canInvite =
    Boolean(c.phone) &&
    sinceLastCut != null &&
    !c.next_booking_at &&
    (c.is_due || sinceLastCut >= c.usual_gap_days);
  // An invite from before their last cut was for that visit, not this one.
  const invitedThisTime =
    invitedAt && c.last_visit_at && Date.parse(invitedAt) > Date.parse(c.last_visit_at) ? invitedAt : null;
  const invitedDays = invitedThisTime ? daysSince(invitedThisTime, now, tz) : null;
  return (
    <Card>
      <View style={styles.cardRow}>
        <View style={styles.info}>
          <T variant="label">{name}</T>
          {c.phone ? (
            <T variant="small" selectable>
              {c.phone}
            </T>
          ) : (
            <T variant="small">{t('No phone number')}</T>
          )}
          <T variant="muted">{lastCutLabel(c.last_visit_at, now, tz)}</T>
          {habit ? <T variant="small">{habit}</T> : null}
          {c.next_booking_at ? (
            <T variant="small" style={{ color: theme.success }}>
              {t('Booked {day} at {time}', {
                day: formatDay(c.next_booking_at, tz),
                // Non-breaking spaces, so "pm" never wraps onto a line of its own.
                time: formatTime(c.next_booking_at, tz).replace(/ /g, '\u00a0'),
              })}
            </T>
          ) : null}
          {c.no_shows > 0 ? <Badge label={noShowsLabel(c.no_shows)} tone="warning" /> : null}
          {invitedDays != null ? (
            <T variant="small">
              ✓{' '}
              {invitedDays <= 0
                ? t('Invited today')
                : invitedDays === 1
                  ? t('Invited yesterday')
                  : t('Invited {time} ago', { time: timeSpan(invitedDays) })}
            </T>
          ) : null}
        </View>
        {c.phone ? (
          <View style={styles.actions}>
            <IconButton
              icon="logo-whatsapp"
              label={t('WhatsApp {name}', { name })}
              variant="ghost"
              color={theme.success}
              onPress={() => Linking.openURL(whatsappUrl(c.phone!)).catch(() => {})}
            />
            <IconButton icon="call-outline" label={t('Call {name}', { name })} variant="ghost" onPress={() => call(c.phone!)} />
          </View>
        ) : null}
      </View>
      {canInvite ? (
        <View style={styles.inviteRow}>
          <Button
            title={invitedThisTime ? t('Invite again') : t('Invite on WhatsApp')}
            accessibilityLabel={t('Invite {name} to book on WhatsApp', { name })}
            icon="logo-whatsapp"
            iconColor={theme.success}
            variant={invitedThisTime ? 'ghost' : 'secondary'}
            onPress={onInvite}
            style={styles.grow}
          />
          {/* Marked as soon as WhatsApp opens, so one that wasn't sent can be taken back the same day. */}
          {invitedDays != null && invitedDays <= 0 ? (
            <Button
              title={t('Undo')}
              accessibilityLabel={t('Undo the invite to {name}', { name })}
              variant="ghost"
              onPress={onUndoInvite}
            />
          ) : null}
        </View>
      ) : null}
    </Card>
  );
}

const styles = StyleSheet.create({
  list: { gap: Spacing.sm },
  cardRow: { flexDirection: 'row', gap: Spacing.sm },
  info: { flex: 1, gap: 2 },
  actions: { flexDirection: 'row' },
  inviteRow: { flexDirection: 'row', alignItems: 'center', gap: Spacing.sm },
  grow: { flex: 1 },
});
