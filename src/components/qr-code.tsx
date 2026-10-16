import { useMemo } from 'react';
import { View } from 'react-native';

import { QUIET_ZONE, qrMatrix, qrRuns } from '@/lib/qr';

/**
 * A scannable QR code drawn with plain Views, one per run of dark modules.
 * Always black on white with a white border, since scanners can't read a
 * code inverted for dark mode.
 */
export function QrCode({ value, size, accessibilityLabel }: { value: string; size: number; accessibilityLabel: string }) {
  const { count, runs } = useMemo(() => {
    const matrix = qrMatrix(value);
    return { count: matrix.length, runs: qrRuns(matrix) };
  }, [value]);
  const cells = count + QUIET_ZONE * 2;
  // Whole points per module, so modules line up evenly instead of blurring at the edges.
  const unit = Math.max(1, Math.floor(size / cells));
  return (
    <View
      role="img"
      accessible
      accessibilityLabel={accessibilityLabel}
      style={{ width: unit * cells, height: unit * cells, backgroundColor: '#FFFFFF' }}>
      {runs.map((r) => (
        <View
          key={`${r.row}-${r.col}`}
          style={{
            position: 'absolute',
            top: (r.row + QUIET_ZONE) * unit,
            left: (r.col + QUIET_ZONE) * unit,
            width: r.length * unit,
            height: unit,
            backgroundColor: '#000000',
          }}
        />
      ))}
    </View>
  );
}
