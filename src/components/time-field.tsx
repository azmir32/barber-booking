import { useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, View } from 'react-native';

import { Button, Chip, T } from '@/components/ui';
import { Radius, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { formatClock } from '@/lib/hours';
import { t } from '@/lib/lang';
import type { PartOfDay } from '@/lib/time';

const toMinutes = (time: string) => {
  const [h, m] = time.split(':').map(Number);
  return h * 60 + m;
};
const fromMinutes = (minutes: number) =>
  `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;

/** Clock times ("HH:MM") from `from` to `to`, every `step` minutes, grouped like the customer's free times. */
export function timeChoices(from: string, to: string, step: number): [PartOfDay, string[]][] {
  const groups: Record<PartOfDay, string[]> = { Morning: [], Afternoon: [], Evening: [] };
  for (let m = toMinutes(from); m <= toMinutes(to); m += step) {
    const h = Math.floor(m / 60);
    groups[h < 12 ? 'Morning' : h < 17 ? 'Afternoon' : 'Evening'].push(fromMinutes(m));
  }
  return (Object.entries(groups) as [PartOfDay, string[]][]).filter(([, list]) => list.length > 0);
}

/**
 * A time that is picked, not typed: shows "2:30 pm" and opens a sheet of
 * times every 15 minutes, so there is no keyboard and no 24-hour rule.
 * `value` and `onChange` use "HH:MM".
 */
export function TimeField({
  label,
  value,
  onChange,
  from = '06:00',
  to = '23:45',
  step = 15,
  hint,
}: {
  label: string;
  value: string | null;
  onChange: (time: string) => void;
  from?: string;
  to?: string;
  step?: number;
  hint?: string;
}) {
  const theme = useTheme();
  const [open, setOpen] = useState(false);
  const shown = value ? formatClock(value) : t('Pick a time');

  return (
    <View style={styles.field}>
      <T variant="label">{label}</T>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${label}: ${shown}`}
        onPress={() => setOpen(true)}
        style={({ pressed }) => [
          styles.input,
          { backgroundColor: theme.card, borderColor: theme.border, opacity: pressed ? 0.8 : 1 },
        ]}>
        <T style={{ color: value ? theme.text : theme.textSecondary }}>{shown}</T>
      </Pressable>
      {hint ? <T variant="small">{hint}</T> : null}
      {open ? (
        <Modal transparent animationType="fade" visible onRequestClose={() => setOpen(false)}>
          <View style={styles.backdrop}>
            <View
              role="dialog"
              aria-modal
              aria-label={label}
              style={[styles.sheet, { backgroundColor: theme.card, borderColor: theme.border }]}>
              <T variant="heading">{label}</T>
              <ScrollView contentContainerStyle={{ gap: Spacing.md }}>
                {timeChoices(from, to, step).map(([part, times]) => (
                  <View key={part} style={{ gap: Spacing.sm }}>
                    <T variant="label">{t(part)}</T>
                    <View style={styles.grid}>
                      {times.map((time) => (
                        <Chip
                          key={time}
                          label={formatClock(time)}
                          selected={time === value}
                          onPress={() => {
                            onChange(time);
                            setOpen(false);
                          }}
                        />
                      ))}
                    </View>
                  </View>
                ))}
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
    borderWidth: 1,
    borderRadius: Radius.md,
    paddingHorizontal: Spacing.md,
    justifyContent: 'center',
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
