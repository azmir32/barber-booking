import { Platform } from 'react-native';

export const Colors = {
  light: {
    text: '#15171C',
    textSecondary: '#5F6470',
    background: '#F7F6F3',
    card: '#FFFFFF',
    border: '#E3E1DC',
    accent: '#C8283C',
    accentText: '#FFFFFF',
    success: '#1E7F4F',
    warning: '#A15C00',
    danger: '#B42318',
    chip: '#EEECE7',
  },
  dark: {
    text: '#F3F2EF',
    textSecondary: '#A6AAB3',
    background: '#0F1115',
    card: '#191C22',
    border: '#2A2E36',
    accent: '#E5485D',
    accentText: '#FFFFFF',
    success: '#4CC38A',
    warning: '#F0A44B',
    danger: '#F97066',
    chip: '#242831',
  },
} as const;

export type Palette = { [K in keyof typeof Colors.light]: string };

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
