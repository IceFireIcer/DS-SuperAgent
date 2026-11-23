// Adapted from DS Bot 0.3.8 (Apache-2.0), mobile/src/ui/tokens.ts (see NOTICE).
import { Pressable, StyleSheet, Text, useColorScheme } from 'react-native';
import type { ReactNode } from 'react';

export function usePalette() {
  return useColorScheme() === 'dark' ? {
    bg: '#141414', surface: '#1d1d1d', ink: '#f2f2f2', muted: '#b2b2b2', separator: '#393939',
    accent: '#92aaff', accentInk: '#151b32', outgoing: '#263557', danger: '#ffadb5',
  } : {
    bg: '#fcfcfc', surface: '#f3f4f6', ink: '#141414', muted: '#555c67', separator: '#dfe2e8',
    accent: '#3453d4', accentInk: '#ffffff', outgoing: '#e9efff', danger: '#a32031',
  };
}

export const radius = { input: 8, bubble: 18, pill: 999 };
export const type = {
  title: { fontSize: 22, lineHeight: 28, fontWeight: '600' as const },
  header: { fontSize: 17, lineHeight: 24, fontWeight: '600' as const },
  body: { fontSize: 16, lineHeight: 23 },
  caption: { fontSize: 13, lineHeight: 19 },
};

export function Button({ label, icon, onPress, disabled = false, primary = false, compact = false }: {
  label: string; icon?: (color: string) => ReactNode; onPress: () => void; disabled?: boolean; primary?: boolean; compact?: boolean;
}) {
  const palette = usePalette();
  const color = primary ? palette.accentInk : palette.accent;
  return <Pressable accessibilityLabel={label} accessibilityRole="button" accessibilityState={{ disabled }}
    disabled={disabled} onPress={onPress} style={({ pressed }) => [styles.button, compact && styles.compact,
      { backgroundColor: primary ? palette.accent : palette.surface, opacity: disabled ? 0.45 : pressed ? 0.75 : 1 }]}>
    {icon?.(color)}
    {(!compact || !icon) && <Text style={[type.caption, { color, fontWeight: '600' }]}>{label}</Text>}
  </Pressable>;
}

const styles = StyleSheet.create({
  button: { minHeight: 44, maxWidth: '100%', paddingHorizontal: 14, paddingVertical: 8, borderRadius: radius.pill,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6 },
  compact: { width: 44, paddingHorizontal: 0 },
});
