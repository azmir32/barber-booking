import Ionicons from '@expo/vector-icons/Ionicons';
import { useRef, useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, View } from 'react-native';

import { Button, Chip, T } from '@/components/ui';
import { Radius, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { formatClock } from '@/lib/hours';
import { t } from '@/lib/lang';
import { groupTimes, type PartOfDay } from '@/lib/time';

const toMinutes = (time: string) => {
  const [h, m] = time.split(':').map(Number);
  return h * 60 + m;
};
const fromMinutes = (minutes: number) =>
  `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;

/** Clock times ("HH:MM") from `from` to `to`, every `step` minutes, grouped like the customer's free times. */
export function timeChoices(from: string, to: string, step: number): [PartOfDay, string[]][] {
  const times: string[] = [];
  for (let m = toMinutes(from); m <= toMinutes(to); m += step) times.push(fromMinutes(m));
  return groupTimes(times, (time) => Number(time.slice(0, 2)));
}

/**
 * A time that is picked, not typed: shows "2:30 pm" and opens a sheet of
 * times every 15 minutes, so there is no keyboard and no 24-hour rule.
 * `value` and `onChange` use "HH:MM". The sheet opens on the picked time.
 */
export function TimeField({
  label,
  value,
  onChange,
  from = '06:00',
  to = '23:45',
  step = 15,
  hint,
  title,
  error,
}: {
  label: string;
  value: string | null;
  onChange: (time: string) => void;
  from?: string;
  to?: string;
  step?: number;
  hint?: string;
  /** The sheet's heading when the label alone isn't enough, e.g. "Mon · To". */
  title?: string;
  /** Marks the field in red, when the time is the problem; say why next to it. */
  error?: boolean;
}) {
  const theme = useTheme();
  const [open, setOpen] = useState(false);
  const shown = value ? formatClock(value) : t('Pick a time');
  const heading = title ?? label;
  const sheet = useRef<ScrollView>(null);
  // Where the picked time sits in the sheet: its part of the day, the chips under that part's
  // name, and the chip itself. Once all three are laid out the sheet scrolls to it.
  const spot = useRef<{ part?: number; grid?: number; chip?: number; done?: boolean }>({});
  const place = (key: 'part' | 'grid' | 'chip', y: number) => {
    spot.current[key] = y;
    const { part, grid, chip, done } = spot.current;
    if (done || part === undefined || grid === undefined || chip === undefined) return;
    spot.current.done = true;
    // A row of times above it stays in view, so it doesn't look like the first choice.
    sheet.current?.scrollTo({ y: Math.max(0, part + grid + chip - 56), animated: false });
  };

  return (
    <View style={styles.field}>
      <T variant="label">{label}</T>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${label}: ${shown}`}
        aria-invalid={error || undefined}
        onPress={() => {
          spot.current = {};
          setOpen(true);
        }}
        style={({ pressed }) => [
          styles.input,
          {
            backgroundColor: theme.card,
            borderColor: error ? theme.danger : theme.inputBorder,
            borderWidth: error ? 2 : 1,
            opacity: pressed ? 0.8 : 1,
          },
        ]}>
        <T style={{ flex: 1, color: value ? theme.text : theme.textSecondary }}>{shown}</T>
        <Ionicons name="time-outline" size={20} color={theme.textSecondary} />
      </Pressable>
      {hint ? <T variant="small">{hint}</T> : null}
      {open ? (
        <Modal transparent animationType="fade" visible onRequestClose={() => setOpen(false)}>
          <View style={styles.backdrop}>
            <View
              role="dialog"
              aria-modal
              aria-label={heading}
              style={[styles.sheet, { backgroundColor: theme.card, borderColor: theme.border }]}>
              <T variant="heading">{heading}</T>
              <ScrollView ref={sheet} contentContainerStyle={{ gap: Spacing.md }}>
                {timeChoices(from, to, step).map(([part, times]) => {
                  const holdsValue = value !== null && times.includes(value);
                  return (
                    <View
                      key={part}
                      style={{ gap: Spacing.sm }}
                      onLayout={holdsValue ? (e) => place('part', e.nativeEvent.layout.y) : undefined}>
                      <T variant="label">{t(part)}</T>
                      <View
                        style={styles.grid}
                        onLayout={holdsValue ? (e) => place('grid', e.nativeEvent.layout.y) : undefined}>
                        {times.map((time) => {
                          const chip = (
                            <Chip
                              key={time}
                              label={formatClock(time)}
                              selected={time === value}
                              onPress={() => {
                                onChange(time);
                                setOpen(false);
                              }}
                            />
                          );
                          return time === value ? (
                            <View key={time} onLayout={(e) => place('chip', e.nativeEvent.layout.y)}>
                              {chip}
                            </View>
                          ) : (
                            chip
                          );
                        })}
                      </View>
                    </View>
                  );
                })}
              </ScrollView>
              <Button title={t('Cancel')} variant="secondary" onPress={() => setOpen(false)} />
            </View>
          </View>
        </Modal>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  field: { gap: Spacing.xs },
  input: {
    minHeight: 48,
    borderRadius: Radius.md,
    paddingHorizontal: Spacing.md,
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
  },
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.45)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: Spacing.lg,
  },
  sheet: {
    width: '100%',
    maxWidth: 480,
    maxHeight: '85%',
    borderRadius: 16,
    borderWidth: 1,
    padding: Spacing.lg,
    gap: Spacing.md,
  },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.sm },
});
