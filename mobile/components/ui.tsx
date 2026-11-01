import { BlurView } from 'expo-blur';
import { LinearGradient } from 'expo-linear-gradient';
import type { ReactNode } from 'react';
import { ActivityIndicator, StyleSheet, Text, View, type ViewStyle } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { blur, colors, dock, radii, spacing, type } from '../theme';
import PressScale from './PressScale';

// Shared glass pieces (R1, P1-22). Colors come only from theme.ts.

/** Distance from the screen bottom to the floating tab bar's bottom edge. */
export function useDockBottom(): number {
  return Math.max(useSafeAreaInsets().bottom, dock.bottomInset);
}

/** Bottom padding that keeps content clear of the floating tab bar. */
export function useTabBarSpace(): number {
  return useDockBottom() + dock.height + spacing.md;
}

type ScreenProps = {
  children: ReactNode;
  /** Tab screens: content runs to the bottom and scrolls behind the floating tab bar. */
  tabBar?: boolean;
};

export function GlassScreen({ children, tabBar = false }: ScreenProps) {
  const insets = useSafeAreaInsets();
  return (
    <LinearGradient
      colors={colors.gradient}
      style={[
        styles.screen,
        { paddingTop: insets.top + spacing.lg, paddingBottom: tabBar ? 0 : insets.bottom + spacing.lg },
      ]}
    >
      {children}
    </LinearGradient>
  );
}

export function GlassCard({ children, style }: { children: ReactNode; style?: ViewStyle }) {
  return (
    <View style={[styles.card, style]}>
      <BlurView intensity={blur.intensity} tint={blur.tint} style={StyleSheet.absoluteFill} />
      <View style={styles.cardFill} />
      <View style={styles.cardBody}>{children}</View>
    </View>
  );
}

export function ScreenTitle({ children }: { children: ReactNode }) {
  return <Text style={styles.screenTitle}>{children}</Text>;
}

type ChipProps = {
  label: string;
  selected?: boolean;
  onPress?: () => void;
  onRemove?: () => void;
  wide?: boolean;
  detail?: string;
};

export function Chip({ label, selected = false, onPress, onRemove, wide = false, detail }: ChipProps) {
  return (
    <PressScale
      onPress={onPress ?? onRemove}
      accessibilityRole="button"
      accessibilityState={{ selected }}
      style={[styles.chip, wide && styles.chipWide, selected && styles.chipSelected]}
    >
      <Text style={[styles.chipText, selected && styles.chipTextSelected]}>{label}</Text>
      {detail && <Text style={[styles.chipDetail, selected && styles.chipTextSelected]}>{detail}</Text>}
      {onRemove && <Text style={[styles.chipText, selected && styles.chipTextSelected]}> ×</Text>}
    </PressScale>
  );
}

type ButtonProps = { label: string; onPress: () => void; disabled?: boolean; busy?: boolean };

export function PrimaryButton({ label, onPress, disabled = false, busy = false }: ButtonProps) {
  return (
    <PressScale
      onPress={onPress}
      disabled={disabled || busy}
      accessibilityRole="button"
      accessibilityState={{ disabled: disabled || busy }}
      style={[styles.button, (disabled || busy) && styles.buttonDisabled]}
    >
      {busy ? (
        <ActivityIndicator color={colors.onAccent} />
      ) : (
        <Text style={styles.buttonText}>{label}</Text>
      )}
    </PressScale>
  );
}

/** The quieter partner of PrimaryButton: same height and shape, glass fill (P1-24). */
export function SecondaryButton({ label, onPress, disabled = false }: Omit<ButtonProps, 'busy'>) {
  return (
    <PressScale
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      style={[styles.button, styles.buttonSecondary, disabled && styles.buttonDisabled]}
    >
      <Text style={[styles.buttonText, styles.buttonSecondaryText]}>{label}</Text>
    </PressScale>
  );
}

export function TextLink({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <PressScale onPress={onPress} accessibilityRole="button" style={styles.link} hitSlop={12}>
      <Text style={styles.linkText}>{label}</Text>
    </PressScale>
  );
}

export function Dots({ step, total }: { step: number; total: number }) {
  return (
    <View style={styles.dots}>
      {Array.from({ length: total }, (_, i) => (
        <View key={i} style={[styles.dot, i <= step && styles.dotOn]} />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    paddingHorizontal: spacing.xl,
  },
  card: {
    borderRadius: radii.card,
    borderWidth: 1,
    borderColor: colors.glassBorder,
    overflow: 'hidden',
    shadowColor: colors.shadow,
    shadowOpacity: 0.06,
    shadowRadius: 24,
    shadowOffset: { width: 0, height: 8 },
  },
  cardFill: {
    ...StyleSheet.absoluteFill,
    backgroundColor: colors.glass,
  },
  cardBody: {
    padding: spacing.xl,
    gap: spacing.lg,
  },
  screenTitle: {
    fontSize: type.title,
    fontWeight: '700',
    color: colors.text,
    marginBottom: spacing.md,
  },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderRadius: radii.pill,
    backgroundColor: colors.glassStrong,
    borderWidth: 1,
    borderColor: colors.hairline,
  },
  chipWide: {
    justifyContent: 'space-between',
    paddingVertical: spacing.lg,
    paddingHorizontal: spacing.xl,
  },
  chipSelected: {
    backgroundColor: colors.accent,
    borderColor: colors.accent,
  },
  chipText: {
    fontSize: type.small,
    color: colors.text,
    fontWeight: '500',
  },
  chipDetail: {
    fontSize: type.small,
    color: colors.textSecondary,
  },
  chipTextSelected: {
    color: colors.onAccent,
  },
  button: {
    backgroundColor: colors.accent,
    borderRadius: radii.pill,
    paddingVertical: spacing.lg,
    alignItems: 'center',
  },
  buttonDisabled: {
    opacity: 0.35,
  },
  buttonSecondary: {
    backgroundColor: colors.glassStrong,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.hairline,
  },
  buttonSecondaryText: {
    color: colors.text,
  },
  buttonText: {
    color: colors.onAccent,
    fontSize: type.body,
    fontWeight: '600',
  },
  link: {
    alignSelf: 'flex-start',
    paddingVertical: spacing.xs,
  },
  linkText: {
    fontSize: type.small,
    color: colors.textSecondary,
  },
  dots: {
    flexDirection: 'row',
    gap: 6,
    justifyContent: 'center',
  },
  dot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: colors.dot,
  },
  dotOn: {
    backgroundColor: colors.accent,
  },
});
