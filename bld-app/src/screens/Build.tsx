import React from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../../App';
import type { Extra } from '../../../supabase/functions/_shared/pricing';
import Seg from '../components/Seg';
import PriceBar from '../components/PriceBar';
import { useOrder } from '../state/order';
import { useCatalog } from '../state/catalog';
import { colors, fonts, radius, spacing } from '../theme';

const SIZES = ['sedan', 'suv', 'truck'] as const;
const SERVICES = ['outside', 'inside', 'full'] as const;
const EXTRAS: { key: Extra; label: string }[] = [
  { key: 'ceramic', label: 'Ceramic coating' },
  { key: 'headlight', label: 'Headlight restore' },
  { key: 'engine', label: 'Engine bay' },
  { key: 'pet', label: 'Pet hair / odor' },
];

type Props = NativeStackScreenProps<RootStackParamList, 'Build'>;

export default function Build({ navigation }: Props) {
  const { state, dispatch } = useOrder();
  const catalog = useCatalog();
  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <ScrollView contentContainerStyle={{ padding: spacing(4), paddingBottom: spacing(8) }}>
        <Text style={s.label}>How many cars?</Text>
        <View style={s.stepper}>
          <Pressable accessibilityRole="button" style={s.stepBtn} onPress={() => dispatch({ type: 'SET_CAR_COUNT', count: state.items.length - 1 })}>
            <Text style={s.stepText}>−</Text>
          </Pressable>
          <Text style={s.count}>{state.items.length}</Text>
          <Pressable accessibilityRole="button" style={s.stepBtn} onPress={() => dispatch({ type: 'SET_CAR_COUNT', count: state.items.length + 1 })}>
            <Text style={s.stepText}>+</Text>
          </Pressable>
        </View>

        {state.items.map((car, i) => (
          <View key={i} style={s.card}>
            <Text style={s.carTitle}>CAR {i + 1}</Text>
            <Text style={s.label}>Size</Text>
            <Seg options={SIZES} labels={{ sedan: 'Sedan', suv: 'SUV', truck: 'Truck/Van' }} value={car.size}
              onChange={(size) => dispatch({ type: 'SET_SIZE', index: i, size })} />
            <Text style={s.label}>Service</Text>
            <Seg
              options={SERVICES}
              labels={{
                outside: `Outside $${Math.round(catalog.services.outside * catalog.sizeMultipliers[car.size])}`,
                inside: `Inside $${Math.round(catalog.services.inside * catalog.sizeMultipliers[car.size])}`,
                full: `Full $${Math.round(catalog.services.full * catalog.sizeMultipliers[car.size])}`,
              }}
              value={car.service}
              onChange={(service) => dispatch({ type: 'SET_SERVICE', index: i, service })}
            />
            <Text style={s.label}>Extras</Text>
            {EXTRAS.map((e) => {
              const on = car.extras.includes(e.key);
              return (
                <Pressable key={e.key} accessibilityRole="checkbox" accessibilityState={{ checked: on }}
                  style={[s.extra, on && s.extraOn]}
                  onPress={() => dispatch({ type: 'TOGGLE_EXTRA', index: i, extra: e.key })}>
                  <Text style={[s.extraText, on && { color: colors.text }]}>{e.label}</Text>
                  <Text style={s.extraPrice}>+${catalog.extras[e.key]}</Text>
                </Pressable>
              );
            })}
          </View>
        ))}
      </ScrollView>
      <PriceBar label="Continue" onNext={() => navigation.navigate('Schedule')} />
    </View>
  );
}

const s = StyleSheet.create({
  label: { color: colors.textMuted, fontSize: 13, textTransform: 'uppercase', letterSpacing: 1, marginTop: spacing(4), marginBottom: spacing(2) },
  stepper: { flexDirection: 'row', alignItems: 'center', gap: spacing(4) },
  stepBtn: { width: 48, height: 48, borderRadius: radius.button, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, alignItems: 'center', justifyContent: 'center' },
  stepText: { color: colors.text, fontSize: 24 },
  count: { fontFamily: fonts.headingBlack, color: colors.text, fontSize: 28, minWidth: 32, textAlign: 'center' },
  card: { backgroundColor: colors.surface, borderRadius: radius.card, borderWidth: 1, borderColor: colors.border, padding: spacing(4), marginTop: spacing(4) },
  carTitle: { fontFamily: fonts.heading, color: colors.primaryBright, fontSize: 16, letterSpacing: 1 },
  extra: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', minHeight: 44, paddingHorizontal: spacing(3), borderRadius: radius.button, borderWidth: 1, borderColor: colors.border, marginBottom: spacing(2) },
  extraOn: { borderColor: colors.primaryBright, backgroundColor: '#1a1030' },
  extraText: { color: colors.textMuted, fontSize: 15 },
  extraPrice: { color: colors.textSecondary, fontSize: 14 },
});
