import { StyleSheet, View } from 'react-native';

import { T } from '@/components/ui';
import { Radius, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

const VALUE_ROOM = 20;

/**
 * A small column chart made of plain Views: one bar per value, rising from
 * a shared baseline, with the ones that matter (the busiest) in the brand
 * colour and the rest in grey. Screen readers get `label`, which should say
 * every value, instead of the bars.
 */
export function BarChart({
  values,
  labels,
  highlight,
  label,
  valuesShown = 'all',
  height = 120,
}: {
  values: number[];
  /** Under each bar, e.g. "Mon" or "5". */
  labels: string[];
  /** The bars to pick out, by place. */
  highlight: number[];
  label: string;
  /** Numbers on top of every bar, or only the highlighted ones when there are too many to read. */
  valuesShown?: 'all' | 'highlight';
  height?: number;
}) {
  const theme = useTheme();
  const top = Math.max(1, ...values);
  const room = height - VALUE_ROOM;
  return (
    <View accessible role="img" accessibilityLabel={label} style={styles.chart}>
      <View style={[styles.plot, { height, borderColor: theme.border }]}>
        {values.map((value, i) => {
          const peak = highlight.includes(i);
          return (
            <View key={i} style={styles.slot}>
              {valuesShown === 'all' || peak ? (
                <T variant="small" style={[styles.value, peak && { color: theme.text, fontWeight: '700' }]}>
                  {value}
                </T>
              ) : null}
              <View
                style={[
                  styles.bar,
                  {
                    // An empty day still shows a sliver, so it reads as none rather than missing.
                    height: value === 0 ? 2 : Math.max(4, Math.round((value / top) * room)),
                    backgroundColor: peak ? theme.tint : theme.inputBorder,
                  },
                ]}
              />
            </View>
          );
        })}
      </View>
      <View style={styles.axis}>
        {labels.map((text, i) => (
          <T
            key={i}
            variant="small"
            numberOfLines={1}
            style={[styles.tick, highlight.includes(i) && { color: theme.text, fontWeight: '700' }]}>
            {text}
          </T>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  chart: { gap: Spacing.xs },
  plot: { flexDirection: 'row', alignItems: 'flex-end', gap: 2, borderBottomWidth: 1 },
  slot: { flex: 1, alignItems: 'center', justifyContent: 'flex-end', gap: 2 },
  value: { fontSize: 12, lineHeight: 16 },
  bar: { width: '64%', maxWidth: 24, borderTopLeftRadius: Radius.sm / 2, borderTopRightRadius: Radius.sm / 2 },
  axis: { flexDirection: 'row', gap: 2 },
  tick: { flex: 1, textAlign: 'center', fontSize: 12, lineHeight: 16 },
});
