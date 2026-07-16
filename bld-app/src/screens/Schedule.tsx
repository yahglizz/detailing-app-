import React, { useMemo } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import * as Location from 'expo-location';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../../App';
import Seg from '../components/Seg';
import PriceBar from '../components/PriceBar';
import { useOrder } from '../state/order';
import { colors, radius, spacing } from '../theme';

type Props = NativeStackScreenProps<RootStackParamList, 'Schedule'>;

function nextDays(n: number): { iso: string; label: string }[] {
  return Array.from({ length: n }, (_, i) => {
    const d = new Date();
    d.setDate(d.getDate() + i + 1);
    return {
      iso: d.toISOString().slice(0, 10),
      label: d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }),
    };
  });
}

export default function Schedule({ navigation }: Props) {
  const { state, dispatch } = useOrder();
  const days = useMemo(() => nextDays(10), []);
  const set = (field: 'address' | 'preferredDay' | 'window' | 'notes') => (value: string) =>
    dispatch({ type: 'SET_FIELD', field, value });

  const useMyLocation = async () => {
    const { status } = await Location.requestForegroundPermissionsAsync();
    if (status !== 'granted') return;
    const pos = await Location.getCurrentPositionAsync({});
    const [a] = await Location.reverseGeocodeAsync(pos.coords);
    if (a) set('address')(`${a.streetNumber ?? ''} ${a.street ?? ''}, ${a.city ?? ''} ${a.postalCode ?? ''}`.trim());
  };

  const next = () => {
    if (!state.address.trim()) return Alert.alert('Where to?', 'Enter the address where the vehicle will be.');
    if (!state.preferredDay) return Alert.alert('Pick a day', 'Choose your preferred day.');
    navigation.navigate('Pay');
  };

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <ScrollView contentContainerStyle={{ padding: spacing(4) }}>
        <Text style={s.label}>Where's the vehicle?</Text>
        <TextInput style={s.input} placeholder="Street address" placeholderTextColor={colors.textMuted}
          value={state.address} onChangeText={set('address')} />
        <Pressable accessibilityRole="button" onPress={useMyLocation}>
          <Text style={s.link}>📍 Use my location</Text>
        </Pressable>

        <Text style={s.label}>Preferred day</Text>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: spacing(2) }}>
          {days.map((d) => (
            <Pressable key={d.iso} accessibilityRole="button" onPress={() => set('preferredDay')(d.iso)}
              style={[s.day, state.preferredDay === d.iso && s.dayOn]}>
              <Text style={[s.dayText, state.preferredDay === d.iso && { color: colors.text }]}>{d.label}</Text>
            </Pressable>
          ))}
        </ScrollView>

        <Text style={s.label}>Time window</Text>
        <Seg options={['morning', 'afternoon', 'either'] as const}
          labels={{ morning: 'Morning', afternoon: 'Afternoon', either: 'Either' }}
          value={state.window} onChange={set('window')} />
        <Text style={s.hint}>We'll text you to lock in the exact time.</Text>

        <Text style={s.label}>Notes (gate code, which car, etc.)</Text>
        <TextInput style={[s.input, { height: 88, textAlignVertical: 'top' }]} multiline
          placeholder="Optional" placeholderTextColor={colors.textMuted}
          value={state.notes} onChangeText={set('notes')} />
      </ScrollView>
      <PriceBar label="Continue" onNext={next} />
    </View>
  );
}

const s = StyleSheet.create({
  label: { color: colors.textMuted, fontSize: 13, textTransform: 'uppercase', letterSpacing: 1, marginTop: spacing(5), marginBottom: spacing(2) },
  input: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, borderRadius: radius.button, color: colors.text, padding: spacing(3.5), fontSize: 16 },
  link: { color: colors.primaryBright, marginTop: spacing(2), fontSize: 14 },
  day: { paddingHorizontal: spacing(4), minHeight: 44, justifyContent: 'center', borderRadius: radius.button, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface },
  dayOn: { borderColor: colors.primaryBright, backgroundColor: '#1a1030' },
  dayText: { color: colors.textMuted, fontSize: 14 },
  hint: { color: colors.textMuted, fontSize: 13, marginTop: spacing(2) },
});
