import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { colors, radius, spacing } from '../theme';

export default function Seg<T extends string>({
  options, labels, value, onChange,
}: { options: readonly T[]; labels?: Partial<Record<T, string>>; value: T; onChange: (v: T) => void }) {
  return (
    <View style={s.row}>
      {options.map((o) => {
        const active = o === value;
        return (
          <Pressable
            key={o}
            accessibilityRole="button"
            accessibilityState={{ selected: active }}
            onPress={() => onChange(o)}
            style={[s.opt, active && s.active]}
          >
            <Text style={[s.text, active && s.textActive]}>{labels?.[o] ?? o}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const s = StyleSheet.create({
  row: { flexDirection: 'row', gap: spacing(2) },
  opt: {
    flex: 1, minHeight: 44, alignItems: 'center', justifyContent: 'center',
    backgroundColor: colors.surface, borderRadius: radius.button, borderWidth: 1, borderColor: colors.border,
  },
  active: { borderColor: colors.primaryBright, backgroundColor: '#1a1030' },
  text: { color: colors.textMuted, fontSize: 15, textTransform: 'capitalize' },
  textActive: { color: colors.text, fontWeight: '700' },
});
