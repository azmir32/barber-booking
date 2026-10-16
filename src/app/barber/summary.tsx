import Ionicons from '@expo/vector-icons/Ionicons';
import { useFocusEffect } from 'expo-router';
import { useCallback, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { BarChart } from '@/components/bar-chart';
import { Button, Card, Chip, Empty, ErrorText, Row, Screen, T } from '@/components/ui';
import { Spacing } from '@/constants/theme';
import { useNow } from '@/hooks/use-now';
import { useTheme } from '@/hooks/use-theme';
import { t } from '@/lib/lang';
import { useMyShop } from '@/lib/my-shop';
import {
  busiest,
  busiestDays,
  byWeekday,
  canCompare,
  countChange,
  hasBookings,
  hourLabel,
  hourMark,
  hourRange,
  joinAnd,
  moneyChange,
  noComparison,
  peakRanges,
  periodDays,
  periodTitle,
  weekdayName,
  type Change,
  type Period,
  type Summary,
} from '@/lib/summary';
import { errorMessage, supabase } from '@/lib/supabase';
import { DEFAULT_TIME_ZONE, formatCount, formatPrice, localDateString } from '@/lib/time';
import { WEEKDAYS } from '@/lib/types';

const PERIODS: Period[] = ['week', 'last-week', 'month'];
const MONDAY_FIRST = [...WEEKDAYS.slice(1), WEEKDAYS[0]];

function periodLabel(period: Period): string {
  if (period === 'week') return t('This week');
  if (period === 'last-week') return t('Last week');
  return t('This month');
}

function emptyTitle(period: Period): string {
  if (period === 'week') return t('No bookings this week yet');
  if (period === 'last-week') return t('No bookings last week');
  return t('No bookings this month yet');
}

/** Last week is mostly past marking (the Bookings tab goes back to yesterday), so it only says what counts. */
function emptyBody(period: Period): string {
  if (period === 'last-week') return t('Cuts marked Done show up here.');
  return t('Mark cuts as Done on the Bookings tab and your takings add up here.');
}

const cuts = (count: number) => (count === 1 ? t('1 cut') : t('{count} cuts', { count: formatCount(count) }));
const noShows = (count: number) =>
  count === 1 ? t('1 no-show') : t('{count} no-shows', { count: formatCount(count) });
/** Walk-ins added without a service are booked as "Appointment". */
const serviceName = (name: string) => (name === 'Appointment' ? t('Appointment') : name);

/** The owner's takings for this week, last week or this month, against the period before. */
export default function Takings() {
  const { shop } = useMyShop();
  const now = useNow();
  const [period, setPeriod] = useState<Period>('week');
  // Each with the period it is for, so a switch never shows last week's numbers,
  // or last week's failure, under This week while it loads.
  const [loaded, setLoaded] = useState<{ period: Period; summary: Summary } | null>(null);
  const [failed, setFailed] = useState<{ period: Period; message: string } | null>(null);
  const [loading, setLoading] = useState(false);
  const latest = useRef(0);
  const tz = shop?.time_zone ?? DEFAULT_TIME_ZONE;

  const load = useCallback(async () => {
    // Only the newest load fills the screen, so a slow answer for the last period picked can't replace it.
    const request = ++latest.current;
    setLoading(true);
    setFailed((f) => (f?.period === period ? f : null));
    const { from, to } = periodDays(period, Date.now(), tz);
    const { data, error } = await supabase.rpc('shop_summary', { p_from: from, p_to: to });
    if (request !== latest.current) return;
    setLoading(false);
    if (error) return setFailed({ period, message: errorMessage(error) });
    setFailed(null);
    setLoaded({ period, summary: data as Summary });
  }, [period, tz]);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  if (!shop) return null;
  const summary = loaded?.period === period ? loaded.summary : null;
  const error = failed?.period === period ? failed.message : null;
  const { from, to } = summary ?? periodDays(period, now, tz);

  return (
    <Screen edges={[]} onRefresh={load}>
      {/* One row that shares the width, so a longer language never pushes a period onto a line of its own. */}
      <Row role="radiogroup" accessibilityLabel={t('Show takings for')} style={styles.periods}>
        {PERIODS.map((p) => (
          <Chip
            key={p}
            label={periodLabel(p)}
            selected={p === period}
            onPress={() => setPeriod(p)}
            style={styles.period}
          />
        ))}
      </Row>
      <T variant="heading">{periodTitle(period, from, to)}</T>

      {error && !summary ? (
        <Empty title={t('Couldn’t load your takings')} body={error}>
          {/* Spins while it tries again, so a second failure doesn't look like a dead button. */}
          <Button title={t('Try again')} variant="secondary" loading={loading} onPress={load} />
        </Empty>
      ) : !summary ? (
        <T variant="muted" role="status">
          {t('Loading your takings…')}
        </T>
      ) : !hasBookings(summary) ? (
        <Empty title={emptyTitle(period)} body={emptyBody(period)} />
      ) : (
        <>
          <ErrorText message={error} />
          <Report
            summary={summary}
            period={period}
            today={localDateString(new Date(now), tz)}
            comparable={canCompare(summary.previous.from, shop.created_at, tz)}
          />
        </>
      )}
    </Screen>
  );
}

function Report({
  summary,
  period,
  today,
  comparable,
}: {
  summary: Summary;
  period: Period;
  /** On the shop's clock. */
  today: string;
  /** False while the period before is from before the shop joined. */
  comparable: boolean;
}) {
  const { totals, previous } = summary;
  const weekdays = byWeekday(summary.days, today);
  const peakDays = busiestDays(weekdays);
  const hours = hourRange(summary.hours);
  const peakHours = busiest(hours.map((h) => h.bookings));
  const peakTimes = peakRanges(hours).map(([from, to]) => ({ from: hourLabel(from), to: hourLabel(to % 24) }));

  return (
    <>
      <Card>
        <View style={styles.stats}>
          <Stat
            label={t('Money in')}
            value={formatPrice(totals.takings)}
            change={comparable ? moneyChange(totals.takings, previous.takings, period) : noComparison()}
          />
          <Stat
            label={t('Cuts done')}
            value={formatCount(totals.done)}
            change={comparable ? countChange(totals.done, previous.done, period) : noComparison()}
          />
        </View>
      </Card>

      <Card>
        {totals.to_come > 0 ? (
          <Line
            label={t('Still to come')}
            note={t('{money} if they all come', { money: formatPrice(totals.to_come_value) })}
            value={formatCount(totals.to_come)}
          />
        ) : null}
        <Line
          label={t('No-shows')}
          note={totals.no_shows > 0 ? t('{money} missed', { money: formatPrice(totals.no_show_value) }) : undefined}
          value={formatCount(totals.no_shows)}
        />
        <Line label={t('Cancelled')} value={formatCount(totals.cancelled)} />
        {/* Not "yet": days before the Bookings tab's yesterday can't be marked any more. */}
        {totals.unmarked > 0 ? (
          <Line
            label={t('Not marked')}
            note={t('Neither Done nor No-show, so not counted in your takings.')}
            value={formatCount(totals.unmarked)}
          />
        ) : null}
      </Card>

      <Card>
        <T variant="heading">{t('Busiest days')}</T>
        {/* A tie of more than three says little; the chart shows it. None until every weekday has come round. */}
        {peakDays.length === 1 ? (
          <T variant="muted">{t('{day} is your busiest day', { day: weekdayName(peakDays[0]) })}</T>
        ) : peakDays.length > 1 && peakDays.length <= 3 ? (
          <T variant="muted">{t('{days} are your busiest days', { days: joinAnd(peakDays.map(weekdayName)) })}</T>
        ) : null}
        <BarChart
          values={weekdays}
          labels={MONDAY_FIRST.map((d) => t(d))}
          highlight={peakDays}
          label={t('Average bookings a day: {list}', {
            list: weekdays.flatMap((n, i) => (n === null ? [] : [`${weekdayName(i)}: ${formatCount(n)}`])).join(', '),
          })}
        />
        <T variant="small">{t('Average bookings on each day of the week, not counting cancelled ones.')}</T>
      </Card>

      {hours.length > 0 ? (
        <Card>
          <T variant="heading">{t('Busiest times')}</T>
          {/* Busiest hours side by side read as one stretch: "5:00 pm to 8:00 pm". */}
          {peakTimes.length === 1 ? (
            <T variant="muted">{t('{from} to {to} is your busiest time', peakTimes[0])}</T>
          ) : peakTimes.length === 2 ? (
            <T variant="muted">
              {t('{times} are your busiest times', {
                times: joinAnd(peakTimes.map((range) => t('{from} to {to}', range))),
              })}
            </T>
          ) : null}
          <BarChart
            values={hours.map((h) => h.bookings)}
            labels={hours.map((h) => hourMark(h.hour))}
            highlight={peakHours}
            valuesShown="highlight"
            label={t('Bookings by hour: {list}', {
              list: hours.map((h) => `${hourLabel(h.hour)}: ${formatCount(h.bookings)}`).join(', '),
            })}
          />
          <T variant="small">{t('Bookings by the hour they start.')}</T>
        </Card>
      ) : null}

      {summary.barbers.length > 1 ? (
        <Card>
          <T variant="heading">{t('Barbers')}</T>
          {summary.barbers.map((b) => (
            <Line
              key={b.barber_id}
              label={b.name}
              note={[cuts(b.done), ...(b.no_shows > 0 ? [noShows(b.no_shows)] : [])].join(' · ')}
              value={formatPrice(b.takings)}
            />
          ))}
        </Card>
      ) : null}

      {summary.services.length > 0 ? (
        <Card>
          <T variant="heading">{t('Top services')}</T>
          {summary.services.map((s) => (
            <Line
              key={s.name}
              label={serviceName(s.name)}
              note={t('{count} done', { count: formatCount(s.done) })}
              value={formatPrice(s.takings)}
            />
          ))}
        </Card>
      ) : null}
    </>
  );
}

/** A headline number with how it compares. */
function Stat({ label, value, change }: { label: string; value: string; change: Change }) {
  return (
    <View style={styles.stat} accessible accessibilityLabel={`${label}: ${value}. ${change.label}`}>
      <T variant="label">{label}</T>
      <T style={styles.big}>{value}</T>
      <ChangeLine change={change} />
    </View>
  );
}

function ChangeLine({ change }: { change: Change }) {
  const theme = useTheme();
  const look =
    change.direction === 'up'
      ? { icon: 'arrow-up' as const, color: theme.success }
      : change.direction === 'down'
        ? { icon: 'arrow-down' as const, color: theme.warning }
        : { icon: 'remove' as const, color: theme.textSecondary };
  return (
    <View style={styles.change}>
      <Ionicons name={look.icon} size={16} color={look.color} style={styles.changeIcon} />
      <T variant="small" style={styles.grow}>
        {change.label}
      </T>
    </View>
  );
}

/** A count or amount on the right, with what it is on the left. */
function Line({ label, note, value }: { label: string; note?: string; value: string | number }) {
  return (
    <View style={styles.line} accessible accessibilityLabel={[`${label}: ${value}`, note].filter(Boolean).join('. ')}>
      <View style={styles.grow}>
        <T>{label}</T>
        {note ? <T variant="small">{note}</T> : null}
      </View>
      <T style={styles.lineValue}>{value}</T>
    </View>
  );
}

const styles = StyleSheet.create({
  periods: { flexWrap: 'nowrap', alignItems: 'stretch' },
  period: { flex: 1, minWidth: 0, paddingHorizontal: Spacing.xs },
  // Side by side on a tablet, one above the other on a phone so a month's takings never squeeze.
  stats: { flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.lg },
  stat: { flexGrow: 1, flexBasis: 220, gap: Spacing.xs },
  big: { fontSize: 36, lineHeight: 42, fontWeight: '700', fontVariant: ['tabular-nums'] },
  change: { flexDirection: 'row', alignItems: 'flex-start', gap: Spacing.xs },
  changeIcon: { marginTop: 1 },
  grow: { flex: 1 },
  line: { flexDirection: 'row', alignItems: 'center', gap: Spacing.md, minHeight: 44 },
  lineValue: { fontWeight: '700', fontVariant: ['tabular-nums'] },
});
