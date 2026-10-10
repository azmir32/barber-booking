import { useEffect, useRef } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';

import { Chip } from '@/components/ui';
import { Spacing } from '@/constants/theme';
import { t } from '@/lib/lang';
import type { DayOption } from '@/lib/time';

/**
 * A horizontal strip of day chips ("Today 5 Oct", "Tomorrow 6 Oct", ...). Closed days show but can't be
 * picked, unless pickClosed (the shop's own diary, where a closed day can be opened again).
 */
export function DayPicker({
  days,
  selected,
  onSelect,
  closed,
  closedLabel = t('Closed'),
  pickClosed = false,
  notes,
}: {
  days: DayOption[];
  selected: string | null;
  onSelect: (date: string) => void;
  /** Dates (YYYY-MM-DD) that can't be picked. */
  closed?: Set<string>;
  /** What those days say instead of the date, e.g. "Off" when one barber doesn't work that day. */
  closedLabel?: string;
  pickClosed?: boolean;
  /** A line under some days' dates, by date, e.g. "2 booked". */
  notes?: Record<string, string>;
}) {
  const strip = useRef<ScrollView>(null);
  // Where each chip sits and which part of the strip is on screen, so a day picked
  // from outside the strip (e.g. a "See Mon, 12 Oct" button) is scrolled into view.
  const chips = useRef<Record<string, { x: number; width: number }>>({});
  const view = useRef({ x: 0, width: 0 });

  useEffect(() => {
    const chip = selected ? chips.current[selected] : undefined;
    const { x, width } = view.current;
    if (!chip || width === 0) return;
    if (chip.x < x) strip.current?.scrollTo({ x: chip.x, animated: true });
    else if (chip.x + chip.width > x + width) strip.current?.scrollTo({ x: chip.x + chip.width - width, animated: true });
  }, [selected]);

  return (
    <ScrollView
      ref={strip}
      horizontal
      role="radiogroup"
      accessibilityLabel={t('Day')}
      showsHorizontalScrollIndicator={false}
      onLayout={(e) => {
        view.current.width = e.nativeEvent.layout.width;
      }}
      onScroll={(e) => {
        view.current.x = e.nativeEvent.contentOffset.x;
      }}
      scrollEventThrottle={100}
      style={styles.strip}
      contentContainerStyle={styles.content}>
      {days.map((d) => {
        const isClosed = closed?.has(d.date) ?? false;
        return (
          <View
            key={d.date}
            onLayout={(e) => {
              chips.current[d.date] = { x: e.nativeEvent.layout.x, width: e.nativeEvent.layout.width };
            }}>
            <Chip
              label={d.label}
              sublabel={`${isClosed ? closedLabel : `${d.dayOfMonth} ${d.month}`}${notes ? `\n${notes[d.date] || NO_NOTE}` : ''}`}
              selected={selected === d.date}
              disabled={isClosed && !pickClosed}
              onPress={() => onSelect(d.date)}
            />
          </View>
        );
      })}
    </ScrollView>
  );
}

// With notes, every chip gets the third line, so days without one are as tall as those with.
const NO_NOTE = '\u00a0';

const styles = StyleSheet.create({
  // Without this the strip stretches to fill a parent ScrollView.
  strip: { flexGrow: 0 },
  content: { gap: Spacing.sm, alignItems: 'flex-start' },
});
