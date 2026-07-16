import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { priceOrder } from '../../../supabase/functions/_shared/pricing';
import { useCatalog } from '../state/catalog';
import { useOrder } from '../state/order';
import { colors, fonts, radius, spacing } from '../theme';

export default function PriceBar({ onNext, label }: { onNext: () => void; label: string }) {
  const catalog = useCatalog();
  const { state } = useOrder();
  const quote = priceOrder(state.items, catalog);
  return (
    <View style={s.bar}>
      <View>
        <Text style={s.total}>${quote.total}</Text>
        <Text style={s.deposit}>${quote.deposit} deposit · ${quote.remainder} at the job</Text>
      </View>
      <Pressable accessibilityRole="button" style={s.btn} onPress={onNext}>
        <Text style={s.btnText}>{label}</Text>
      </Pressable>
    </View>
  );
}

const s = StyleSheet.create({
  bar: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    backgroundColor: colors.surface, borderTopWidth: 1, borderColor: colors.border,
    padding: spacing(4), paddingBottom: spacing(7),
  },
  total: { fontFamily: fonts.headingBlack, fontSize: 30, color: colors.primaryBright },
  deposit: { color: colors.textMuted, fontSize: 13 },
  btn: { backgroundColor: colors.primary, borderRadius: radius.button, paddingVertical: spacing(4), paddingHorizontal: spacing(7), minHeight: 48, justifyContent: 'center' },
  btnText: { fontFamily: fonts.heading, color: colors.text, fontSize: 16, letterSpacing: 0.5 },
});
