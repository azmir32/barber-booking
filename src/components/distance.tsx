import Ionicons from '@expo/vector-icons/Ionicons';
import { View, type ViewStyle } from 'react-native';

import { T } from '@/components/ui';
import { useTheme } from '@/hooks/use-theme';
import { distanceText } from '@/lib/distance';
import { t } from '@/lib/lang';

/** A pin and "800 m", read out as "800 m away": how far a shop is from the customer. */
export function Distance({ km, style }: { km: number; style?: ViewStyle }) {
  const theme = useTheme();
  const distance = distanceText(km);
  return (
    <View
      role="img"
      accessibilityLabel={t('{distance} away', { distance })}
      style={[{ flexDirection: 'row', alignItems: 'center', gap: 2, flexShrink: 0 }, style]}>
      <Ionicons name="location-outline" size={16} color={theme.textSecondary} />
      <T variant="label" style={{ color: theme.textSecondary }}>
        {distance}
      </T>
    </View>
  );
}
