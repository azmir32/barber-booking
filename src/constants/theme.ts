import { Platform } from 'react-native';

export { Colors, type Palette } from './colors';

export const Fonts = Platform.select({
  web: { sans: 'Inter, ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif' },
  default: { sans: undefined },
});

export const Spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
} as const;

export const Radius = {
  sm: 8,
  md: 12,
  pill: 999,
} as const;

export const MaxContentWidth = 640;
