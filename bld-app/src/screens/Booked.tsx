import React from 'react';
import { Alert, Pressable, StyleSheet, Text, View } from 'react-native';
import * as Calendar from 'expo-calendar';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../../App';
import { useOrder } from '../state/order';
import { fmtSlot } from './Build';
import { colors, fonts, radius, spacing } from '../theme';

type Props = NativeStackScreenProps<RootStackParamList, 'Booked'>;
const PAID = { demo: 'Demo deposit recorded, no money taken.', balance: 'Deposit paid from your balance.', membership: 'Booked with your membership.' };
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

// Same reference the website shows: BLD- plus the booking id's first 6 hex, uppercase.
export const bookingRef = (id: string) => `BLD-${id.replace(/-/g, '').slice(0, 6).toUpperCase()}`;

export default function Booked({ navigation, route }: Props) {
  const { state, dispatch } = useOrder();
  const { bookingId, escalated, paid = 'demo', stamps = 0, saved = 0 } = route.params;
  const [y, m, d] = state.day.split('-').map(Number);
  const dayText = state.day ? `${MONTHS[m - 1]} ${d}` : '';
  const address = `${state.street}, ${state.zip}`;

  const addToCalendar = async () => {
    const { status } = await Calendar.requestCalendarPermissionsAsync();
    if (status !== 'granted') return;
    const cals = await Calendar.getCalendarsAsync(Calendar.EntityTypes.EVENT);
    const cal = cals.find((c) => c.allowsModifications);
    if (!cal) return;
    const hour = Number((escalated ? '09:00' : state.slot || '09:00').slice(0, 2));
    const start = new Date(y, m - 1, d, hour);
    await Calendar.createEventAsync(cal.id, {
      title: 'Brotherly Love Detailing',
      location: address,
      startDate: start,
      endDate: new Date(start.getTime() + 2 * 3600e3),
      notes: `Booking ${bookingRef(bookingId)}.${escalated ? ' Exact time to be confirmed.' : ''}`,
    });
    Alert.alert('Added', 'Your detail is on your calendar.');
  };

  const done = () => {
    dispatch({ type: 'RESET' });
    navigation.reset({ index: 0, routes: [{ name: 'Home' }] });
  };

  return (
    <View style={s.root}>
      <Text style={s.check}>✓</Text>
      <Text style={s.title}>YOU'RE BOOKED</Text>
      <Text style={s.ref}>{bookingRef(bookingId)}</Text>
      <Text style={s.sub}>{escalated
        ? `${dayText}. We’ll confirm your time.`
        : `${dayText} at ${fmtSlot(state.slot)}.`}</Text>
      <Text style={s.addr}>{address}</Text>
      <Text style={s.paid}>{PAID[paid]}</Text>
      {saved > 0 && <Text style={s.saved}>You saved ${saved} with your membership.</Text>}
      {stamps > 0 && <Text style={s.stamp}>✓ You'll earn {stamps === 1 ? 'a stamp' : `${stamps} stamps`} when this detail is done.</Text>}
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
  ref: { fontFamily: fonts.heading, fontSize: 18, color: colors.primaryBright, letterSpacing: 1.5, marginTop: spacing(2) },
  sub: { color: colors.textSecondary, fontSize: 16, textAlign: 'center', marginTop: spacing(3), lineHeight: 23 },
  addr: { color: colors.textMuted, fontSize: 14, marginTop: spacing(2), textAlign: 'center' },
  paid: { color: colors.textMuted, fontSize: 13, marginTop: spacing(3), textAlign: 'center' },
  stamp: { color: colors.success, fontSize: 14, textAlign: 'center', marginTop: spacing(2) },
  saved: { color: '#F5B942', fontFamily: fonts.heading, fontSize: 15, textAlign: 'center', marginTop: spacing(4) },
  ghost: { marginTop: spacing(8), borderWidth: 1, borderColor: colors.border, borderRadius: radius.button, paddingVertical: spacing(3.5), paddingHorizontal: spacing(8), minHeight: 48, justifyContent: 'center' },
  ghostText: { color: colors.textSecondary, fontFamily: fonts.heading, fontSize: 14, letterSpacing: 1 },
  btn: { marginTop: spacing(3), backgroundColor: colors.primary, borderRadius: radius.button, paddingVertical: spacing(3.5), paddingHorizontal: spacing(12), minHeight: 48, justifyContent: 'center' },
  btnText: { color: colors.text, fontFamily: fonts.heading, fontSize: 16, letterSpacing: 1 },
});
