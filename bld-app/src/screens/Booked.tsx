import React from 'react';
import { Alert, Pressable, StyleSheet, Text, View } from 'react-native';
import * as Calendar from 'expo-calendar';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../../App';
import { useOrder } from '../state/order';
import { colors, fonts, radius, spacing } from '../theme';

type Props = NativeStackScreenProps<RootStackParamList, 'Booked'>;

export default function Booked({ navigation }: Props) {
  const { state, dispatch } = useOrder();

  const addToCalendar = async () => {
    const { status } = await Calendar.requestCalendarPermissionsAsync();
    if (status !== 'granted') return;
    const cals = await Calendar.getCalendarsAsync(Calendar.EntityTypes.EVENT);
    const cal = cals.find((c) => c.allowsModifications);
    if (!cal) return;
    const start = new Date(`${state.preferredDay}T${state.window === 'afternoon' ? '13:00' : '09:00'}:00`);
    await Calendar.createEventAsync(cal.id, {
      title: 'Brotherly Love Detailing',
      location: state.address,
      startDate: start,
      endDate: new Date(start.getTime() + 2 * 3600e3),
      notes: 'Exact time will be confirmed by text.',
    });
    Alert.alert('Added', 'Detail day is on your calendar.');
  };

  const done = () => {
    dispatch({ type: 'RESET' });
    navigation.reset({ index: 0, routes: [{ name: 'Home' }] });
  };

  return (
    <View style={s.root}>
      <Text style={s.check}>✓</Text>
      <Text style={s.title}>YOU'RE BOOKED</Text>
      <Text style={s.sub}>Deposit paid. We'll text you shortly to lock in your exact time for {state.preferredDay} ({state.window}).</Text>
      <Text style={s.addr}>{state.address}</Text>
      <Pressable accessibilityRole="button" style={s.ghost} onPress={addToCalendar}>
        <Text style={s.ghostText}>ADD TO CALENDAR</Text>
      </Pressable>
      <Pressable accessibilityRole="button" style={s.btn} onPress={done}>
        <Text style={s.btnText}>DONE</Text>
      </Pressable>
    </View>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg, alignItems: 'center', justifyContent: 'center', padding: spacing(8) },
  check: { fontSize: 64, color: colors.success },
  title: { fontFamily: fonts.headingBlack, fontSize: 32, color: colors.text, marginTop: spacing(4) },
  sub: { color: colors.textSecondary, fontSize: 16, textAlign: 'center', marginTop: spacing(3), lineHeight: 23 },
  addr: { color: colors.textMuted, fontSize: 14, marginTop: spacing(2) },
  ghost: { marginTop: spacing(8), borderWidth: 1, borderColor: colors.border, borderRadius: radius.button, paddingVertical: spacing(3.5), paddingHorizontal: spacing(8), minHeight: 48, justifyContent: 'center' },
  ghostText: { color: colors.textSecondary, fontFamily: fonts.heading, fontSize: 14, letterSpacing: 1 },
  btn: { marginTop: spacing(3), backgroundColor: colors.primary, borderRadius: radius.button, paddingVertical: spacing(3.5), paddingHorizontal: spacing(12), minHeight: 48, justifyContent: 'center' },
  btnText: { color: colors.text, fontFamily: fonts.heading, fontSize: 16, letterSpacing: 1 },
});
