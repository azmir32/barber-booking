import Ionicons from '@expo/vector-icons/Ionicons';
import { useEffect, useMemo, useRef, useState, type ReactNode, type Ref } from 'react';
import {
  AccessibilityInfo,
  Animated,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
  type GestureResponderEvent,
  type LayoutChangeEvent,
} from 'react-native';

import { Bone, Empty, IconButton, Skeleton, T } from '@/components/ui';
import { chairFills, type Palette } from '@/constants/colors';
import { Fonts, MaxContentWidth, Radius, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import {
  blockText,
  chairStatus,
  clockOf,
  clockText,
  gapSlots,
  isWholeDay,
  minutesInto,
  slotAt,
  statusWord,
  type Chair,
  type ChairBarber,
  type ChairBooking,
  type ChairsDay,
  type ChairStatus,
  type Slot,
  type Span,
} from '@/lib/chairs';
import { t } from '@/lib/lang';
import { clockParts, formatClockOnly, formatTime } from '@/lib/time';
import type { Booking } from '@/lib/types';

/** A quarter hour is a finger's height, so the shortest booking (drawn a quarter hour at least) or free time is easy to tap. */
const QUARTER_PX = 44;
const PER_MINUTE = QUARTER_PX / 15;
/** The row of barbers' names over the chairs, and its copy that stays at the top of the screen. */
export const NAMES_HEIGHT = 48;
const TIME_WIDTH = 56;
/** Narrower than this, a chair can't show a name and a service; two still fit on a 360-wide phone. */
const MIN_CHAIR_WIDTH = 120;
/** Above and below a block's words, small enough for two lines in a quarter hour. */
const BLOCK_PADDING = 3;
/** On a wide window the chairs spread past the page's usual width, up to this. */
const MAX_GRID_WIDTH = 1200;

type ChairsBarber = ChairBarber & { name: string };
type ChairsBooking = ChairBooking & Pick<Booking, 'service_name'>;

/** Where the row of names is, so a copy can stay at the top of the screen once it has scrolled away. */
export type ChairsFrame = {
  /** How far down the screen's content the names start: scrolled past this, they stick. */
  top: number;
  /** The sideways strip of chairs across the window: where it starts and how wide it is. */
  x: number;
  width: number;
  chairWidth: number;
};

/**
 * The day as chairs side by side: a column per barber under their name, the
 * time down the left, each booking a block as long as it is, coloured by
 * where it is in its day. Breaks, blocked time and time off are shaded;
 * free time is blank and opens Add to the day at the quarter hour tapped.
 * On a phone two chairs fit and more scroll sideways; a wide window fits
 * them all.
 */
export function Chairs<Br extends ChairsBarber, B extends ChairsBooking>({
  grid,
  day,
  tz,
  now,
  nameOf,
  selectedId,
  focus,
  focusRef,
  scrollX,
  emptyTitle,
  onOpen,
  onAdd,
  onFrame,
  openAtNow,
  onOpenAtNow,
}: {
  grid: ChairsDay<Br, B>;
  day: string;
  tz: string;
  now: number;
  /** Who a booking is for, the way the list says it. */
  nameOf: (b: B) => string;
  /** The booking whose actions are open, outlined; focus goes back to it when they close. */
  selectedId: string | null;
  /** A booking opened from "Since you last looked" (a cancelled one too): its chair scrolls into view and `focusRef` marks it. */
  focus: B | null;
  focusRef: Ref<View>;
  /** How far the chairs have scrolled sideways, shared with the names' copy at the top (ChairNames). */
  scrollX: Animated.Value;
  /** Said when nobody has a chair this day. */
  emptyTitle: string;
  onOpen: (b: B) => void;
  /** Free time tapped: that barber, at that start ("HH:MM"). */
  onAdd: (barberId: string, clock: string) => void;
  onFrame: (frame: ChairsFrame) => void;
  /** Whether to offer to open on now once laid out. The screen decides, as it knows what else is above. */
  openAtNow: boolean;
  /** Where the screen's content would scroll to for the hour before now to show at the top; null if nothing would. */
  onOpenAtNow: (y: number | null) => void;
}) {
  const theme = useTheme();
  const fills = chairFills(theme);
  const { width: windowWidth } = useWindowDimensions();
  const [measured, setMeasured] = useState(0);
  const [rootY, setRootY] = useState<number | null>(null);
  const [gridY, setGridY] = useState<number | null>(null);
  const [strip, setStrip] = useState<{ x: number; width: number } | null>(null);
  const stripRef = useRef<View>(null);
  const sideways = useRef<ScrollView>(null);
  const shownX = useRef(0);
  // Each booking's block (or blocked day) by id, for focus to come back to.
  const blocks = useRef(new Map<string, View>());
  const lastSelected = useRef(selectedId);

  const content = measured || Math.min(windowWidth, MaxContentWidth) - 2 * Spacing.lg;
  const gridWidth = Math.max(content, Math.min(windowWidth, MAX_GRID_WIDTH + 2 * Spacing.lg) - 2 * Spacing.lg);
  const room = gridWidth - TIME_WIDTH;
  const count = grid.chairs.length;
  const fit = Math.max(1, Math.floor(room / MIN_CHAIR_WIDTH));
  // With more chairs than fit, a quarter of the next one shows at the edge, so it's clear there are more.
  const chairWidth = Math.floor(count <= fit ? room / Math.max(count, 1) : room / (fit + 0.25));
  const height = (grid.to - grid.from) * PER_MINUTE;
  const y = (minute: number) => (minute - grid.from) * PER_MINUTE;
  const nowMinute = minutesInto(day, now, tz);
  const nowShown = nowMinute >= grid.from && nowMinute <= grid.to && grid.to > grid.from;
  const top = rootY !== null && gridY !== null ? rootY + gridY : null;

  useEffect(() => {
    if (top !== null && strip) onFrame({ top, x: strip.x, width: strip.width, chairWidth });
  }, [top, strip, chairWidth, onFrame]);

  // Today can open on now, with the hour before it in view; a booking opened from the news card scrolls there instead.
  useEffect(() => {
    if (!openAtNow || top === null || count === 0) return;
    const above = (nowMinute - grid.from - 60) * PER_MINUTE;
    onOpenAtNow(!focus && nowShown && above > 0 ? top + above : null);
  }, [openAtNow, top, count, focus, nowShown, nowMinute, grid.from, onOpenAtNow]);

  // A booking's actions closed: back to its block, so a screen reader or keyboard carries on from there.
  useEffect(() => {
    const was = lastSelected.current;
    lastSelected.current = selectedId;
    if (was && !selectedId) moveFocus(blocks.current.get(was));
  }, [selectedId]);
  const blockRef = (id: string) => (node: View | null) => {
    if (node) blocks.current.set(id, node);
    else blocks.current.delete(id);
  };

  // That booking's chair, brought in from the side if it is out of view.
  const focusChair = focus ? grid.chairs.findIndex((c) => c.barber.id === focus.barber_id) : -1;
  useEffect(() => {
    if (focusChair < 0 || !strip) return;
    const left = focusChair * chairWidth;
    if (left < shownX.current || left + chairWidth > shownX.current + strip.width) {
      sideways.current?.scrollTo({ x: left, animated: true });
    }
  }, [focusChair, chairWidth, strip]);

  const onScroll = useMemo(
    () =>
      Animated.event([{ nativeEvent: { contentOffset: { x: scrollX } } }], { useNativeDriver: Platform.OS !== 'web' }),
    [scrollX],
  );
  useEffect(() => {
    const id = scrollX.addListener(({ value }) => {
      shownX.current = value;
    });
    return () => scrollX.removeListener(id);
  }, [scrollX]);

  const named = (list: Br[]) => list.map((b) => b.name).join(', ');
  const notIn = [
    grid.off.length ? t('Off: {names}', { names: named(grid.off) }) : null,
    grid.away.length ? t('Away: {names}', { names: named(grid.away) }) : null,
  ]
    .filter(Boolean)
    .join(' · ');

  const hours: number[] = [];
  for (let h = grid.from; h < grid.to; h += 60) hours.push(h);

  return (
    <View
      style={styles.root}
      onLayout={(e) => {
        setRootY(e.nativeEvent.layout.y);
        setMeasured(e.nativeEvent.layout.width);
      }}>
      {notIn ? <T variant="muted">{notIn}</T> : null}
      {grid.blocked.length ? (
        <View style={styles.blockedDays}>
          {grid.blocked.map(({ barber, booking }) => (
            <BlockedDay
              key={booking.id}
              ref={blockRef(booking.id)}
              barber={barber.name}
              reason={booking.service_name === 'Blocked' ? null : booking.service_name}
              label={bookingLabel(booking, nameOf, barber.name, tz, now)}
              fill={fills.block}
              selected={booking.id === selectedId}
              onPress={() => onOpen(booking)}
            />
          ))}
        </View>
      ) : null}
      {count === 0 ? (
        <Empty title={emptyTitle} />
      ) : (
        <View
          style={[styles.grid, { marginHorizontal: -(gridWidth - content) / 2 }]}
          onLayout={(e) => setGridY(e.nativeEvent.layout.y)}>
          {/* The times are in every block's and gap's name, so screen readers skip this column. */}
          <View
            aria-hidden
            importantForAccessibility="no-hide-descendants"
            accessibilityElementsHidden
            style={{ width: TIME_WIDTH }}>
            <View style={{ height: NAMES_HEIGHT }} />
            <View style={{ height }}>
              {hours.map((h) => {
                const { clock, period } = clockParts(Math.floor(h / 60) % 24, 0);
                // "tengah hari" takes two lines in the narrow column.
                const bottom = y(h) + 2 + 16 + 14 * (period.length > 8 ? 2 : 1);
                // The now pill says the time itself, so an hour it would half cover steps aside.
                if (nowShown && y(nowMinute) + 10 > y(h) && y(nowMinute) - 10 < bottom) return null;
                return (
                  <View key={h} style={[styles.hour, { top: y(h) + 2 }]}>
                    <Text style={[styles.hourClock, { color: theme.textSecondary }]}>{clock}</Text>
                    <Text style={[styles.hourPeriod, { color: theme.textSecondary }]}>{period}</Text>
                  </View>
                );
              })}
              {nowShown ? (
                <View style={[styles.nowPill, { top: y(nowMinute) - 10, backgroundColor: theme.accent }]}>
                  <Text style={[styles.nowText, { color: theme.accentText }]}>{formatClockOnly(new Date(now), tz)}</Text>
                </View>
              ) : null}
            </View>
          </View>
          <View
            ref={stripRef}
            style={styles.strip}
            onLayout={() =>
              stripRef.current?.measureInWindow((x, _y, width) =>
                setStrip((s) => (s && s.x === x && s.width === width ? s : { x, width })),
              )
            }>
            <Animated.ScrollView
              ref={sideways}
              horizontal
              showsHorizontalScrollIndicator={count > fit}
              onScroll={onScroll}
              scrollEventThrottle={16}>
              <View>
                <View
                  aria-hidden
                  importantForAccessibility="no-hide-descendants"
                  accessibilityElementsHidden
                  style={[styles.names, { borderBottomColor: theme.border }]}>
                  {grid.chairs.map((c) => (
                    <ChairName key={c.barber.id} barber={c.barber} width={chairWidth} />
                  ))}
                </View>
                <View style={[styles.body, { height }]}>
                  {grid.chairs.map((chair) => (
                    <ChairColumn
                      key={chair.barber.id}
                      chair={chair}
                      width={chairWidth}
                      height={height}
                      hours={hours}
                      y={y}
                      tz={tz}
                      now={now}
                      nowMinute={nowShown ? nowMinute : null}
                      notBefore={Math.max(0, nowMinute)}
                      fills={fills}
                      nameOf={nameOf}
                      selectedId={selectedId}
                      focusAt={
                        focus?.barber_id === chair.barber.id ? minutesInto(day, Date.parse(focus.starts_at), tz) : null
                      }
                      focusRef={focusRef}
                      blockRef={blockRef}
                      onOpen={onOpen}
                      onAdd={(clock) => onAdd(chair.barber.id, clock)}
                    />
                  ))}
                </View>
              </View>
            </Animated.ScrollView>
          </View>
        </View>
      )}
    </View>
  );
}

/** One barber's chair down the day, in time order for screen readers: off, bookings, free time, breaks. */
function ChairColumn<Br extends ChairsBarber, B extends ChairsBooking>({
  chair,
  width,
  height,
  hours,
  y,
  tz,
  now,
  nowMinute,
  notBefore,
  fills,
  nameOf,
  selectedId,
  focusAt,
  focusRef,
  blockRef,
  onOpen,
  onAdd,
}: {
  chair: Chair<Br, B>;
  width: number;
  height: number;
  /** The hours down the side, for a line at each hour and a fainter one at each half. */
  hours: number[];
  y: (minute: number) => number;
  tz: string;
  now: number;
  /** Where the now line goes; null when now isn't on this day's time line. */
  nowMinute: number | null;
  /** The earliest start free time can offer: the quarter hour now is in today, none on a day gone by. */
  notBefore: number;
  fills: ReturnType<typeof chairFills>;
  nameOf: (b: B) => string;
  selectedId: string | null;
  /** Where the booking opened from the news card starts, when it is in this chair. */
  focusAt: number | null;
  focusRef: Ref<View>;
  blockRef: (id: string) => Ref<View>;
  onOpen: (b: B) => void;
  onAdd: (clock: string) => void;
}) {
  const theme = useTheme();
  const barber = chair.barber.name;
  const pieces: { at: number; node: ReactNode }[] = [];

  for (const shade of chair.shades) {
    const h = (shade.to - shade.from) * PER_MINUTE;
    pieces.push({
      at: shade.from,
      node: (
        <View key={`s${shade.from}`} style={[styles.shade, { top: y(shade.from), height: h, backgroundColor: fills.shade }]}>
          {h >= 24 ? (
            <Text numberOfLines={1} style={[styles.shadeText, { color: theme.textSecondary }]}>
              {shade.kind === 'break' ? t('Break') : t('Not working')}
            </Text>
          ) : null}
        </View>
      ),
    });
  }

  for (const gap of chair.gaps) {
    const slots = gapSlots(gap, notBefore);
    if (slots.length === 0) continue;
    pieces.push({
      at: slots[0].from,
      node: (
        <FreeGap
          key={`g${gap.from}`}
          gap={gap}
          slots={slots}
          top={y(slots[0].from)}
          label={t('Free with {barber}, {from} to {to}. Add a booking', {
            barber,
            from: clockText(slots[0].at),
            to: clockText(gap.to),
          })}
          fill={fills.upcoming}
          onAdd={onAdd}
        />
      ),
    });
  }

  for (const item of chair.items) {
    const b = item.booking;
    const status = chairStatus(b, now);
    pieces.push({
      at: item.from,
      node: (
        <ChairBlock
          key={b.id}
          ref={blockRef(b.id)}
          name={b.is_block ? t('Blocked') : nameOf(b)}
          detail={b.is_block ? (b.service_name === 'Blocked' ? null : b.service_name) : b.service_name}
          clock={formatClockOnly(b.starts_at, tz)}
          status={status}
          label={bookingLabel(b, nameOf, barber, tz, now)}
          top={y(item.from)}
          height={(item.end - item.from) * PER_MINUTE}
          fills={fills}
          selected={b.id === selectedId}
          onPress={() => onOpen(b)}
        />
      ),
    });
  }
  pieces.sort((a, b) => a.at - b.at);

  return (
    <View
      role="group"
      aria-label={t('{name}’s chair', { name: barber })}
      style={[styles.chair, { width, height, backgroundColor: theme.card, borderLeftColor: theme.border }]}>
      {hours.flatMap((h) => [
        <View key={`h${h}`} style={[styles.line, { top: y(h), backgroundColor: theme.border }]} />,
        <View key={`h${h + 30}`} style={[styles.line, styles.halfLine, { top: y(h + 30), backgroundColor: theme.border }]} />,
      ])}
      {pieces.map((p) => p.node)}
      {focusAt !== null ? (
        // Half an hour above the booking, and the height of the names' copy at the top, so a little of what comes before shows.
        <View ref={focusRef} style={[styles.marker, { top: y(focusAt - 30) - NAMES_HEIGHT }]} />
      ) : null}
      {nowMinute !== null ? (
        <View style={[styles.nowLine, { top: y(nowMinute) - 1, backgroundColor: theme.tint }]} />
      ) : null}
    </View>
  );
}

/**
 * Free time in a chair: one button, opening Add to the day at the quarter
 * hour pressed. A screen reader or a key opens its first quarter hour, as
 * there is no spot to press.
 */
function FreeGap({
  gap,
  slots,
  top,
  label,
  fill,
  onAdd,
}: {
  gap: Span;
  slots: Slot[];
  top: number;
  label: string;
  /** The quarter hour pressed lights up in this. */
  fill: string;
  onAdd: (clock: string) => void;
}) {
  const theme = useTheme();
  const [pressed, setPressed] = useState<Slot | null>(null);
  const first = slots[0];
  // How far down the gap a press landed: a touch's offset in it, or on the web a click's. A key has none.
  const slotOf = (e: GestureResponderEvent) => {
    const { locationY, offsetY } = e.nativeEvent as { locationY?: number; offsetY?: number };
    const down = locationY ?? offsetY;
    return typeof down === 'number' && Number.isFinite(down) ? slotAt(slots, first.from + down / PER_MINUTE) : first;
  };
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityActions={[{ name: 'activate' }]}
      onAccessibilityAction={() => onAdd(clockOf(first.at))}
      onPressIn={(e) => setPressed(slotOf(e))}
      onPressOut={() => setPressed(null)}
      onPress={(e) => onAdd(clockOf(slotOf(e).at))}
      style={[styles.gap, { top, height: (gap.to - first.from) * PER_MINUTE }]}>
      {pressed ? (
        <View
          style={[
            styles.pressedSlot,
            {
              top: (pressed.from - first.from) * PER_MINUTE,
              height: (pressed.to - pressed.from) * PER_MINUTE,
              backgroundColor: fill,
            },
          ]}
        />
      ) : null}
      <View style={styles.freeHint}>
        <Ionicons name="add" size={16} color={theme.textSecondary} />
        <Text numberOfLines={1} style={[styles.freeText, { color: theme.textSecondary }]}>
          {t('Free')}
        </Text>
      </View>
    </Pressable>
  );
}

/** A booking, or blocked time: who, what and when, as much as its height has room for. */
function ChairBlock({
  ref,
  name,
  detail,
  clock,
  status,
  label,
  top,
  height,
  fills,
  selected,
  onPress,
}: {
  ref: Ref<View>;
  name: string;
  detail: string | null;
  /** When it starts, without am or pm: the time column says which. */
  clock: string;
  status: ChairStatus;
  label: string;
  top: number;
  height: number;
  fills: ReturnType<typeof chairFills>;
  selected: boolean;
  onPress: () => void;
}) {
  const theme = useTheme();
  const { fill, edge } = look(status, theme, fills);
  // Lines of 18pt inside the block's gap and padding: a quarter hour has two, half an hour four.
  const lines = Math.floor((height - 2 - 2 * BLOCK_PADDING) / 18);
  const sub = status === 'done' || status === 'noShow' ? theme.textSecondary : theme.text;
  const { title, rows } = blockText(lines, { name, detail, clock, word: statusWord(status) });
  return (
    <Pressable
      ref={ref}
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={({ pressed }) => [
        styles.block,
        { top: top + 1, height: Math.max(height - 2, 8), backgroundColor: fill, borderLeftColor: edge },
        status === 'block' && [styles.blocked, { borderColor: theme.inputBorder }],
        selected && { borderColor: theme.text, borderWidth: 2, borderLeftWidth: status === 'block' ? 2 : 4 },
        pressed && { opacity: 0.8 },
      ]}>
      {title ? (
        <T variant="label" numberOfLines={1} style={{ color: sub }}>
          {title}
        </T>
      ) : null}
      {rows.map((row, i) => (
        <T key={i} variant="small" numberOfLines={1} style={{ color: sub }}>
          {row}
        </T>
      ))}
    </Pressable>
  );
}

/** A barber's whole day blocked, above the chairs: who, and why if the barber said. It opens the block, to take it off. */
function BlockedDay({
  ref,
  barber,
  reason,
  label,
  fill,
  selected,
  onPress,
}: {
  ref: Ref<View>;
  barber: string;
  reason: string | null;
  label: string;
  fill: string;
  selected: boolean;
  onPress: () => void;
}) {
  const theme = useTheme();
  return (
    <Pressable
      ref={ref}
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={({ pressed }) => [
        styles.blockedDay,
        { backgroundColor: fill, borderColor: theme.inputBorder },
        selected && { borderColor: theme.text, borderWidth: 2, borderStyle: 'solid' },
        pressed && { opacity: 0.8 },
      ]}>
      <T variant="label" numberOfLines={1}>
        {barber}
      </T>
      <T variant="small" numberOfLines={1} style={{ color: theme.text }}>
        {reason ? `${t('Blocked all day')} · ${reason}` : t('Blocked all day')}
      </T>
    </Pressable>
  );
}

/**
 * How a booking is read out: "Hakim, Haircut, 4:30 pm to 5:00 pm, with Ali",
 * with how it went once it has started. For its block, its blocked day and
 * the dialog with its actions.
 */
export function bookingLabel<B extends ChairsBooking>(
  b: B,
  nameOf: (b: B) => string,
  barber: string,
  tz: string,
  now: number,
): string {
  const times = { from: formatTime(b.starts_at, tz), to: formatTime(b.ends_at, tz), barber };
  // Blocks saved without a reason get this English default from the database.
  const reason = b.service_name === 'Blocked' ? null : b.service_name;
  if (b.is_block && isWholeDay(b)) {
    return reason
      ? t('Blocked all day, {reason}, with {barber}', { barber, reason })
      : t('Blocked all day, with {barber}', { barber });
  }
  if (b.is_block) {
    return reason
      ? t('Blocked, {reason}, {from} to {to}, with {barber}', { ...times, reason })
      : t('Blocked, {from} to {to}, with {barber}', times);
  }
  const label = t('{name}, {service}, {from} to {to}, with {barber}', {
    ...times,
    name: nameOf(b),
    service: b.service_name,
  });
  const word = statusWord(chairStatus(b, now));
  return word ? `${label}. ${word}` : label;
}

/**
 * A booking's actions over the chairs, as a dialog: its time and barber over
 * the card the list has for it. Focus moves into it as it opens, so a screen
 * reader says what opened; the chairs send it back to the booking as it
 * closes. Give each booking its own key, so focus moves for each.
 */
export function ChairsPanel({
  label,
  title,
  onClose,
  onLayout,
  children,
}: {
  /** Read out for the dialog: the booking's label. */
  label: string;
  /** Its time and barber, as the heading. */
  title: string;
  onClose: () => void;
  onLayout?: (e: LayoutChangeEvent) => void;
  children: ReactNode;
}) {
  const theme = useTheme();
  const heading = useRef<View>(null);
  useEffect(() => moveFocus(heading.current), []);
  return (
    <View
      role="dialog"
      aria-label={label}
      onLayout={onLayout}
      style={[styles.panel, { backgroundColor: theme.background, borderColor: theme.border }]}>
      <View style={styles.panelHead}>
        <View ref={heading} accessible role="heading" tabIndex={-1} style={styles.panelTitle}>
          <T variant="label">{title}</T>
        </View>
        <IconButton icon="close" label={t('Close')} variant="ghost" onPress={onClose} />
      </View>
      {children}
    </View>
  );
}

/** Moves a screen reader's focus, and on the web the keyboard's, to `node`. */
function moveFocus(node: View | null | undefined) {
  if (!node) return;
  if (Platform.OS === 'web') (node as unknown as HTMLElement).focus?.();
  else AccessibilityInfo.sendAccessibilityEvent(node, 'focus');
}

function look(status: ChairStatus, theme: Palette, fills: ReturnType<typeof chairFills>) {
  switch (status) {
    case 'upcoming':
      return { fill: fills.upcoming, edge: theme.tint };
    case 'now':
      return { fill: fills.now, edge: theme.success };
    case 'toMark':
      return { fill: fills.toMark, edge: theme.warning };
    case 'done':
      return { fill: fills.done, edge: theme.textSecondary };
    // Over, so grey like a done one, with a red edge.
    case 'noShow':
      return { fill: fills.done, edge: theme.danger };
    default:
      return { fill: fills.block, edge: theme.inputBorder };
  }
}

/** A barber's name over their chair, with Away under it for one marked away who still has customers booked. */
function ChairName({ barber, width }: { barber: ChairsBarber; width: number }) {
  return (
    <View style={[styles.name, { width }]}>
      <T variant="label" numberOfLines={1}>
        {barber.name}
      </T>
      {barber.is_active ? null : (
        <T variant="small" numberOfLines={1}>
          {t('Away')}
        </T>
      )}
    </View>
  );
}

/**
 * The barbers' names, kept at the top of the screen once the chairs' own row
 * has scrolled away, and moved sideways with the chairs. Only for the eye:
 * each chair already says whose it is to screen readers.
 */
export function ChairNames<Br extends ChairsBarber, B>({
  chairs,
  frame,
  scrollX,
  topInset,
}: {
  chairs: Chair<Br, B>[];
  frame: ChairsFrame;
  scrollX: Animated.Value;
  topInset: number;
}) {
  const theme = useTheme();
  const [shift] = useState(() => Animated.multiply(scrollX, -1));
  return (
    <View
      aria-hidden
      importantForAccessibility="no-hide-descendants"
      accessibilityElementsHidden
      style={[styles.sticky, { paddingTop: topInset, backgroundColor: theme.background, borderBottomColor: theme.border }]}>
      <View style={{ marginLeft: frame.x, width: frame.width, height: NAMES_HEIGHT, overflow: 'hidden' }}>
        <Animated.View style={[styles.namesRow, { transform: [{ translateX: shift }] }]}>
          {chairs.map((c) => (
            <ChairName key={c.barber.id} barber={c.barber} width={frame.chairWidth} />
          ))}
        </Animated.View>
      </View>
    </View>
  );
}

/** The shape of two chairs and a few bookings, while a day with nothing kept from before loads. */
export function ChairsSkeleton() {
  return (
    <Skeleton label={t('Loading bookings')}>
      <View style={styles.skeletonRow}>
        <View style={[styles.skeletonTimes, { width: TIME_WIDTH }]}>
          {[0, 1, 2].map((i) => (
            <Bone key={i} width={36} height={12} />
          ))}
        </View>
        {[0, 1].map((c) => (
          <View key={c} style={styles.skeletonChair}>
            <Bone width="60%" height={18} />
            <Bone height={QUARTER_PX * 2 - 4} style={{ marginTop: c ? QUARTER_PX : 0 }} />
            <Bone height={QUARTER_PX * 3 - 4} style={{ marginTop: QUARTER_PX * (c ? 1 : 2) }} />
          </View>
        ))}
      </View>
    </Skeleton>
  );
}

const styles = StyleSheet.create({
  root: { gap: Spacing.sm },
  grid: { flexDirection: 'row' },
  strip: { flex: 1 },
  names: { flexDirection: 'row', height: NAMES_HEIGHT, borderBottomWidth: 1 },
  namesRow: { flexDirection: 'row' },
  name: { height: NAMES_HEIGHT, justifyContent: 'center', alignItems: 'center', paddingHorizontal: Spacing.xs },
  body: { flexDirection: 'row' },
  line: { position: 'absolute', left: 0, right: 0, height: 1 },
  halfLine: { opacity: 0.5 },
  chair: { borderLeftWidth: 1 },
  hour: { position: 'absolute', left: 0, right: Spacing.xs },
  hourClock: { fontFamily: Fonts?.sans, fontSize: 13, lineHeight: 16, fontWeight: '600' },
  hourPeriod: { fontFamily: Fonts?.sans, fontSize: 11, lineHeight: 14 },
  nowPill: {
    position: 'absolute',
    left: 0,
    right: Spacing.xs,
    height: 20,
    borderRadius: Radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
  },
  nowText: { fontFamily: Fonts?.sans, fontSize: 12, fontWeight: '700' },
  // Over free and shaded time, under bookings, so it never strikes through a name.
  nowLine: { position: 'absolute', left: 0, right: 0, height: 2, pointerEvents: 'none', zIndex: 1 },
  shade: { position: 'absolute', left: 0, right: 0, paddingHorizontal: Spacing.sm, paddingTop: 4 },
  shadeText: { fontFamily: Fonts?.sans, fontSize: 12, fontWeight: '600' },
  gap: { position: 'absolute', left: 0, right: 0 },
  freeHint: {
    position: 'absolute',
    top: 4,
    left: Spacing.xs,
    right: Spacing.xs,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
    pointerEvents: 'none',
  },
  freeText: { fontFamily: Fonts?.sans, fontSize: 12, flexShrink: 1 },
  block: {
    position: 'absolute',
    left: 3,
    right: 3,
    borderRadius: Radius.sm,
    borderLeftWidth: 4,
    paddingHorizontal: Spacing.sm - 2,
    paddingVertical: BLOCK_PADDING,
    overflow: 'hidden',
    zIndex: 2,
  },
  blocked: { borderWidth: 1, borderLeftWidth: 1, borderStyle: 'dashed' },
  marker: { position: 'absolute', left: 0, width: 1, height: 1 },
  // It takes its own taps, so none reaches the booking or free time scrolled under it, out of sight.
  sticky: { position: 'absolute', top: 0, left: 0, right: 0, borderBottomWidth: 1 },
  blockedDays: { flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.sm },
  blockedDay: {
    minHeight: 48,
    maxWidth: '100%',
    justifyContent: 'center',
    borderWidth: 1,
    borderStyle: 'dashed',
    borderRadius: Radius.sm,
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.xs,
  },
  pressedSlot: { position: 'absolute', left: 0, right: 0, pointerEvents: 'none' },
  // Over the chairs, as a sheet: the booking's time and barber, then its card.
  panel: {
    borderWidth: 1,
    borderRadius: Radius.md,
    padding: Spacing.sm,
    gap: Spacing.xs,
    boxShadow: '0 4px 16px rgba(0, 0, 0, 0.25)',
  },
  panelHead: { flexDirection: 'row', alignItems: 'center', gap: Spacing.sm, paddingLeft: Spacing.sm },
  panelTitle: { flex: 1 },
  skeletonRow: { flexDirection: 'row', gap: Spacing.sm },
  skeletonTimes: { gap: QUARTER_PX * 4 - 12, paddingTop: NAMES_HEIGHT },
  skeletonChair: { flex: 1, gap: Spacing.sm },
});
