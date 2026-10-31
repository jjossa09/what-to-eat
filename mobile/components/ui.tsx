import { LinearGradient } from 'expo-linear-gradient';
import type { ReactNode } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

// Minimal glass look (R1): a soft gradient behind frosted white cards and pill chips.
export const colors = {
  ink: '#111',
  muted: '#6b6b76',
  error: '#c0392b',
  gradient: ['#FDE7D9', '#ECE6FB', '#DCEFF8'] as const,
  glass: 'rgba(255,255,255,0.55)',
  glassBorder: 'rgba(255,255,255,0.85)',
};

export function GlassScreen({ children }: { children: ReactNode }) {
  return (
    <LinearGradient colors={colors.gradient} style={styles.screen}>
      {children}
    </LinearGradient>
  );
}

export function GlassCard({ children }: { children: ReactNode }) {
  return <View style={styles.card}>{children}</View>;
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
    <Pressable
      onPress={onPress ?? onRemove}
      accessibilityRole="button"
      accessibilityState={{ selected }}
      style={({ pressed }) => [
        styles.chip,
        wide && styles.chipWide,
        selected && styles.chipSelected,
        pressed && styles.pressed,
      ]}
    >
      <Text style={[styles.chipText, selected && styles.chipTextSelected]}>{label}</Text>
      {detail && <Text style={[styles.chipDetail, selected && styles.chipTextSelected]}>{detail}</Text>}
      {onRemove && <Text style={[styles.chipText, selected && styles.chipTextSelected]}> ×</Text>}
    </Pressable>
  );
}

type ButtonProps = { label: string; onPress: () => void; disabled?: boolean; busy?: boolean };

export function PrimaryButton({ label, onPress, disabled = false, busy = false }: ButtonProps) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled || busy}
      accessibilityRole="button"
      style={({ pressed }) => [
        styles.button,
        (disabled || busy) && styles.buttonDisabled,
        pressed && styles.pressed,
      ]}
    >
      {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.buttonText}>{label}</Text>}
    </Pressable>
  );
}

export function TextLink({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} accessibilityRole="button" style={styles.link} hitSlop={12}>
      <Text style={styles.linkText}>{label}</Text>
    </Pressable>
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
    paddingTop: 72,
    paddingHorizontal: 20,
    paddingBottom: 40,
  },
  card: {
    backgroundColor: colors.glass,
    borderColor: colors.glassBorder,
    borderWidth: 1,
    borderRadius: 28,
    padding: 20,
    gap: 16,
    shadowColor: '#000',
    shadowOpacity: 0.06,
    shadowRadius: 24,
    shadowOffset: { width: 0, height: 8 },
  },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderRadius: 999,
    backgroundColor: 'rgba(255,255,255,0.7)',
    borderWidth: 1,
    borderColor: 'rgba(17,17,17,0.08)',
  },
  chipWide: {
    justifyContent: 'space-between',
    paddingVertical: 16,
    paddingHorizontal: 20,
  },
  chipSelected: {
    backgroundColor: colors.ink,
    borderColor: colors.ink,
  },
  chipText: {
    fontSize: 15,
    color: colors.ink,
    fontWeight: '500',
  },
  chipDetail: {
    fontSize: 15,
    color: colors.muted,
  },
  chipTextSelected: {
    color: '#fff',
  },
  pressed: {
    opacity: 0.7,
  },
  button: {
    backgroundColor: colors.ink,
    borderRadius: 999,
    paddingVertical: 16,
    alignItems: 'center',
  },
  buttonDisabled: {
    opacity: 0.35,
  },
  buttonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
  },
  link: {
    alignSelf: 'flex-start',
    paddingVertical: 4,
  },
  linkText: {
    fontSize: 15,
    color: colors.muted,
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
    backgroundColor: 'rgba(17,17,17,0.15)',
  },
  dotOn: {
    backgroundColor: colors.ink,
  },
});
