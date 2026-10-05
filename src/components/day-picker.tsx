import { ScrollView, StyleSheet } from 'react-native';

import { Chip } from '@/components/ui';
import { Spacing } from '@/constants/theme';
import type { DayOption } from '@/lib/time';

/** A horizontal strip of day chips ("Today 5 Oct", "Tomorrow 6 Oct", ...). */
export function DayPicker({
  days,
  selected,
  onSelect,
}: {
  days: DayOption[];
  selected: string | null;
  onSelect: (date: string) => void;
}) {
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      style={styles.strip}
      contentContainerStyle={styles.content}>
      {days.map((d) => (
        <Chip
          key={d.date}
          label={d.label}
          sublabel={`${d.dayOfMonth} ${d.month}`}
          selected={selected === d.date}
          onPress={() => onSelect(d.date)}
        />
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  // Without this the strip stretches to fill a parent ScrollView.
  strip: { flexGrow: 0 },
  content: { gap: Spacing.sm, alignItems: 'flex-start' },
});
