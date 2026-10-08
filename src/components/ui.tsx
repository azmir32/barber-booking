// Small set of shared building blocks so every screen looks the same.

import Ionicons from '@expo/vector-icons/Ionicons';
import { useState, type ComponentProps, type ReactNode, type Ref } from 'react';
import {
  ActivityIndicator,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  type TextInputProps,
  type TextProps,
  type TextStyle,
  type ViewStyle,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Fonts, MaxContentWidth, Radius, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

export function Screen({
  children,
  scroll = true,
  edges = ['top'],
  onRefresh,
  footer,
  overlay,
  scrollRef,
}: {
  children: ReactNode;
  scroll?: boolean;
  edges?: ('top' | 'bottom')[];
  /** Enables pull to refresh. */
  onRefresh?: () => Promise<unknown>;
  /** Stays at the bottom of the screen while the content scrolls, e.g. a confirm bar. */
  footer?: ReactNode;
  /** Floats over the content, e.g. an undo bar or an add button. Position it absolutely. */
  overlay?: ReactNode;
  scrollRef?: Ref<ScrollView>;
}) {
  const theme = useTheme();
  const [refreshing, setRefreshing] = useState(false);
  const inner = <View style={styles.content}>{children}</View>;
  const refreshControl = onRefresh ? (
    <RefreshControl
      refreshing={refreshing}
      tintColor={theme.tint}
      colors={[theme.tint]}
      onRefresh={async () => {
        setRefreshing(true);
        try {
          await onRefresh();
        } finally {
          setRefreshing(false);
        }
      }}
    />
  ) : undefined;
  return (
    <SafeAreaView
      edges={footer ? edges.filter((e) => e !== 'bottom') : edges}
      style={[styles.screen, { backgroundColor: theme.background }]}>
      {scroll ? (
        <ScrollView
          ref={scrollRef}
          contentContainerStyle={styles.scroll}
          keyboardShouldPersistTaps="handled"
          refreshControl={refreshControl}>
          {inner}
        </ScrollView>
      ) : (
        inner
      )}
      {footer ? (
        <SafeAreaView edges={['bottom']} style={[styles.footer, { backgroundColor: theme.card, borderColor: theme.border }]}>
          <View style={styles.footerInner}>{footer}</View>
        </SafeAreaView>
      ) : null}
      {overlay}
    </SafeAreaView>
  );
}

type Variant = 'title' | 'heading' | 'body' | 'muted' | 'small' | 'label';

export function T({ variant = 'body', style, ...rest }: TextProps & { variant?: Variant }) {
  const theme = useTheme();
  const color = variant === 'muted' || variant === 'small' ? theme.textSecondary : theme.text;
  // Titles and headings are headings to screen readers too (h1/h2 on the web).
  const heading =
    variant === 'title' || variant === 'heading'
      ? ({ role: 'heading', 'aria-level': variant === 'title' ? 1 : 2 } as TextProps)
      : null;
  return <Text {...heading} style={[{ color, fontFamily: Fonts?.sans }, textStyles[variant], style]} {...rest} />;
}

/**
 * primary: the one main action (solid brand red). secondary: other actions
 * (outlined). danger: destructive actions (soft red, so Cancel never looks
 * like Confirm). ghost: quiet text actions; tone="danger" makes a ghost or
 * secondary button's text red for destructive ones.
 */
export function Button({
  title,
  onPress,
  variant = 'primary',
  tone,
  disabled,
  loading,
  style,
}: {
  title: string;
  onPress?: () => void;
  variant?: 'primary' | 'secondary' | 'danger' | 'ghost';
  tone?: 'danger';
  disabled?: boolean;
  loading?: boolean;
  style?: ViewStyle;
}) {
  const theme = useTheme();
  const bg =
    variant === 'primary'
      ? theme.accent
      : variant === 'danger'
        ? theme.dangerSoft
        : variant === 'secondary'
          ? theme.card
          : 'transparent';
  const border = variant === 'danger' ? theme.danger : variant === 'secondary' ? theme.inputBorder : 'transparent';
  const fg =
    variant === 'primary' ? theme.accentText : variant === 'danger' || tone === 'danger' ? theme.danger : theme.text;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={title}
      aria-busy={loading}
      aria-disabled={disabled}
      // While loading the button keeps its size, name and focus; presses are ignored.
      onPress={loading ? undefined : onPress}
      disabled={disabled}
      style={({ pressed }) => [
        styles.button,
        { backgroundColor: bg, borderColor: border, opacity: disabled ? 0.5 : pressed ? 0.8 : 1 },
        style,
      ]}>
      <Text style={[styles.buttonText, { color: fg, opacity: loading ? 0 : 1 }]}>{title}</Text>
      {loading ? <ActivityIndicator color={fg} style={StyleSheet.absoluteFill} /> : null}
    </Pressable>
  );
}

export function Field({
  label,
  hint,
  error,
  ...props
}: TextInputProps & {
  label: string;
  hint?: string;
  /** Shown under the field in red, and read out, when what was typed is not right. */
  error?: string | null;
}) {
  const theme = useTheme();
  const [focused, setFocused] = useState(false);
  return (
    <View style={styles.field}>
      <T variant="label">{label}</T>
      <TextInput
        accessibilityLabel={label}
        accessibilityHint={hint}
        aria-invalid={Boolean(error)}
        placeholderTextColor={theme.textSecondary}
        {...props}
        onFocus={(e) => {
          setFocused(true);
          props.onFocus?.(e);
        }}
        onBlur={(e) => {
          setFocused(false);
          props.onBlur?.(e);
        }}
        style={[
          styles.input,
          {
            color: theme.text,
            backgroundColor: theme.card,
            borderColor: error ? theme.danger : focused ? theme.tint : theme.inputBorder,
            borderWidth: focused || error ? 2 : 1,
          },
          // The coloured border shows focus, so the browser's own outline is not needed.
          Platform.OS === 'web' && ({ outlineStyle: 'none' } as unknown as TextStyle),
          props.multiline && { minHeight: 88, textAlignVertical: 'top' },
          props.style,
        ]}
      />
      {error ? <ErrorText message={error} /> : hint ? <T variant="small">{hint}</T> : null}
    </View>
  );
}

export function Card({
  children,
  onPress,
  style,
  role = 'button',
  selected,
  accessibilityLabel,
}: {
  children: ReactNode;
  onPress?: () => void;
  style?: ViewStyle;
  /** What a tappable card is to a screen reader: a button, a link to another page, or one choice of several. */
  role?: 'button' | 'link' | 'radio';
  /** For role="radio": whether this card is the one picked. */
  selected?: boolean;
  accessibilityLabel?: string;
}) {
  const theme = useTheme();
  const cardStyle = [
    styles.card,
    { backgroundColor: theme.card, borderColor: theme.border },
    selected && { borderColor: theme.tint, borderWidth: 2 },
    style,
  ];
  if (!onPress) return <View style={cardStyle}>{children}</View>;
  return (
    <Pressable
      role={role}
      aria-checked={role === 'radio' ? Boolean(selected) : undefined}
      accessibilityState={role === 'radio' ? { checked: Boolean(selected) } : undefined}
      accessibilityLabel={accessibilityLabel}
      onPress={onPress}
      style={({ pressed }) => [...cardStyle, pressed && { opacity: 0.8 }]}>
      {children}
    </Pressable>
  );
}

/**
 * A choice. With `selected` set it is one option of a set (a radio button to
 * screen readers, or an on/off switch with mode="toggle"); without it, it is
 * a plain button such as a suggestion.
 */
export function Chip({
  label,
  sublabel,
  selected,
  disabled,
  mode = 'radio',
  accessibilityLabel,
  onPress,
}: {
  label: string;
  sublabel?: string;
  selected?: boolean;
  /** Shown faded and can't be tapped, e.g. a day the shop is closed. */
  disabled?: boolean;
  mode?: 'radio' | 'toggle';
  accessibilityLabel?: string;
  onPress?: () => void;
}) {
  const theme = useTheme();
  const choice = selected !== undefined;
  // react-native-web only passes aria-* props to the page, so set both kinds.
  const state = choice
    ? mode === 'toggle'
      ? ({ 'aria-pressed': selected } as object)
      : { 'aria-checked': selected }
    : null;
  return (
    <Pressable
      role={choice && mode === 'radio' ? 'radio' : 'button'}
      {...state}
      aria-disabled={disabled}
      accessibilityState={{ checked: choice && mode === 'radio' ? selected : undefined, selected, disabled }}
      accessibilityLabel={accessibilityLabel}
      disabled={disabled}
      onPress={onPress}
      style={[
        styles.chip,
        {
          backgroundColor: selected ? theme.accent : theme.chip,
          borderColor: selected ? theme.accent : theme.inputBorder,
          opacity: disabled ? 0.45 : 1,
        },
      ]}>
      <Text style={[styles.chipText, { color: selected ? theme.accentText : theme.text }]}>{label}</Text>
      {sublabel ? (
        <Text style={[styles.chipSub, { color: selected ? theme.accentText : theme.textSecondary }]}>{sublabel}</Text>
      ) : null}
    </Pressable>
  );
}

/** A square button with just an icon, as big as a regular button so it is easy to hit. */
export function IconButton({
  icon,
  label,
  onPress,
  variant = 'secondary',
  color,
}: {
  icon: ComponentProps<typeof Ionicons>['name'];
  /** Read out by screen readers, since there is no visible text. */
  label: string;
  onPress?: () => void;
  variant?: 'primary' | 'secondary' | 'ghost';
  color?: string;
}) {
  const theme = useTheme();
  const bg = variant === 'primary' ? theme.accent : variant === 'secondary' ? theme.card : 'transparent';
  const border = variant === 'secondary' ? theme.inputBorder : 'transparent';
  const fg = color ?? (variant === 'primary' ? theme.accentText : theme.text);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      hitSlop={4}
      style={({ pressed }) => [styles.iconButton, { backgroundColor: bg, borderColor: border, opacity: pressed ? 0.8 : 1 }]}>
      <Ionicons name={icon} size={22} color={fg} />
    </Pressable>
  );
}

export function Badge({ label, tone = 'neutral' }: { label: string; tone?: 'neutral' | 'success' | 'warning' | 'danger' }) {
  const theme = useTheme();
  const color =
    tone === 'success' ? theme.success : tone === 'warning' ? theme.warning : tone === 'danger' ? theme.danger : theme.textSecondary;
  return (
    <View style={[styles.badge, { borderColor: color }]}>
      <Text style={[styles.badgeText, { color }]}>{label}</Text>
    </View>
  );
}

export function Row({
  children,
  style,
  role,
  accessibilityLabel,
}: {
  children: ReactNode;
  style?: ViewStyle;
  /** "radiogroup" around a set of chips where one is picked, with a label saying what is being picked. */
  role?: 'radiogroup' | 'group';
  accessibilityLabel?: string;
}) {
  return (
    <View role={role} accessibilityLabel={accessibilityLabel} style={[styles.row, style]}>
      {children}
    </View>
  );
}

export function Section({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <View style={styles.section}>
      <Row style={{ justifyContent: 'space-between' }}>
        <T variant="heading">{title}</T>
        {action}
      </Row>
      {children}
    </View>
  );
}

export function Loading() {
  const theme = useTheme();
  return (
    <View style={[styles.center, { backgroundColor: theme.background }]}>
      <ActivityIndicator color={theme.tint} />
    </View>
  );
}

export function ErrorText({ message }: { message: string | null }) {
  const theme = useTheme();
  if (!message) return null;
  return (
    <Text role="alert" accessibilityLiveRegion="polite" style={{ color: theme.danger }}>
      {message}
    </Text>
  );
}

export function Empty({ title, body, children }: { title: string; body?: string; children?: ReactNode }) {
  return (
    <View style={styles.empty}>
      <T variant="heading" style={{ textAlign: 'center' }}>
        {title}
      </T>
      {body ? (
        <T variant="muted" style={{ textAlign: 'center' }}>
          {body}
        </T>
      ) : null}
      {children}
    </View>
  );
}

const textStyles = StyleSheet.create({
  title: { fontSize: 28, lineHeight: 34, fontWeight: '700' },
  heading: { fontSize: 18, lineHeight: 24, fontWeight: '700' },
  body: { fontSize: 16, lineHeight: 22 },
  muted: { fontSize: 15, lineHeight: 21 },
  small: { fontSize: 13, lineHeight: 18 },
  label: { fontSize: 14, lineHeight: 18, fontWeight: '600' },
});

const styles = StyleSheet.create({
  screen: { flex: 1 },
  scroll: { flexGrow: 1 },
  content: {
    flex: 1,
    width: '100%',
    maxWidth: MaxContentWidth,
    alignSelf: 'center',
    padding: Spacing.lg,
    gap: Spacing.lg,
  },
  button: {
    minHeight: 48,
    borderRadius: Radius.md,
    borderWidth: 1,
    paddingHorizontal: Spacing.lg,
    alignItems: 'center',
    justifyContent: 'center',
  },
  buttonText: { fontSize: 16, fontWeight: '600' },
  field: { gap: Spacing.xs },
  input: {
    minHeight: 48,
    borderWidth: 1,
    borderRadius: Radius.md,
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.sm,
    fontSize: 16,
  },
  card: {
    borderWidth: 1,
    borderRadius: Radius.md,
    padding: Spacing.lg,
    gap: Spacing.sm,
  },
  chip: {
    borderWidth: 1,
    borderRadius: Radius.md,
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.sm,
    alignItems: 'center',
    justifyContent: 'center',
    minWidth: 64,
    minHeight: 48,
  },
  iconButton: {
    minWidth: 48,
    minHeight: 48,
    borderRadius: Radius.md,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  footer: { borderTopWidth: StyleSheet.hairlineWidth },
  footerInner: {
    width: '100%',
    maxWidth: MaxContentWidth,
    alignSelf: 'center',
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.md,
    gap: Spacing.sm,
  },
  chipText: { fontSize: 15, fontWeight: '600' },
  chipSub: { fontSize: 12 },
  badge: {
    borderWidth: 1,
    borderRadius: Radius.pill,
    paddingHorizontal: Spacing.sm,
    paddingVertical: 2,
    alignSelf: 'flex-start',
  },
  badgeText: { fontSize: 12, fontWeight: '600' },
  row: { flexDirection: 'row', alignItems: 'center', gap: Spacing.sm, flexWrap: 'wrap' },
  section: { gap: Spacing.md },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  empty: { alignItems: 'center', gap: Spacing.sm, paddingVertical: Spacing.xxl },
});
