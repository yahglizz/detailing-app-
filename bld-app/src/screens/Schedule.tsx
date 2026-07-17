import React, { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import * as Location from 'expo-location';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../../App';
import PriceBar from '../components/PriceBar';
import { supabase } from '../api';
import { useOrder } from '../state/order';
import { useMember } from '../state/member';
import { useCatalog } from '../state/catalog';
import { decideBump } from '../../../supabase/functions/_shared/bump';
import { colors, fonts, radius, spacing } from '../theme';

type Props = NativeStackScreenProps<RootStackParamList, 'Schedule'>;

// ——— calendar helpers ———
const WEEKDAYS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

const toISO = (y: number, m: number, d: number) =>
  `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

const addDays = (iso: string, days: number) => {
  const d = new Date(`${iso}T00:00:00`);
  d.setDate(d.getDate() + days);
  return toISO(d.getFullYear(), d.getMonth(), d.getDate());
};

function monthCells(year: number, month: number): (number | null)[] {
  const first = new Date(year, month, 1).getDay();
  const count = new Date(year, month + 1, 0).getDate();
  const cells: (number | null)[] = Array(first).fill(null);
  for (let d = 1; d <= count; d++) cells.push(d);
  while (cells.length % 7 !== 0) cells.push(null);
  return cells;
}

// ——— time slots: 9 AM – 5 PM hourly ———
const SLOTS = Array.from({ length: 9 }, (_, i) => {
  const h = 9 + i;
  const ampm = h >= 12 ? 'PM' : 'AM';
  const h12 = h > 12 ? h - 12 : h;
  return { key: `${String(h).padStart(2, '0')}:00`, label: `${h12}:00 ${ampm}` };
});

export default function Schedule({ navigation }: Props) {
  const { state, dispatch } = useOrder();
  const set = (field: 'address' | 'preferredDay' | 'timeSlot' | 'window' | 'notes') => (value: string) =>
    dispatch({ type: 'SET_FIELD', field, value });

  const today = useMemo(() => new Date(), []);
  const [view, setView] = useState({ year: today.getFullYear(), month: today.getMonth() });
  const [slotStates, setSlotStates] = useState<Map<string, { rank: number; anchored: boolean }>>(new Map());
  const [loadingSlots, setLoadingSlots] = useState(false);
  const { profile } = useMember();
  const catalog = useCatalog() as unknown as { plans?: Record<string, { rank: number }> };
  const myRank = profile ? catalog.plans?.[profile.member.tier]?.rank ?? 0 : 0;

  const cells = useMemo(() => monthCells(view.year, view.month), [view]);
  const todayISO = toISO(today.getFullYear(), today.getMonth(), today.getDate());
  const atCurrentMonth = view.year === today.getFullYear() && view.month === today.getMonth();
  // Members can book 30 days out, everyone else 7 — matches the `book` edge function's window.
  const maxISO = addDays(todayISO, profile ? 30 : 7);

  // Availability + priority: rank/anchored state per slot for the selected day. Backend down → everything stays open.
  useEffect(() => {
    if (!state.preferredDay) return;
    let alive = true;
    setLoadingSlots(true);
    supabase.rpc('slot_states', { day: state.preferredDay }).then(
      ({ data }) => {
        if (!alive) return;
        const map = new Map<string, { rank: number; anchored: boolean }>();
        for (const r of (data ?? []) as { slot: string; rank: number; anchored: boolean }[]) {
          map.set(r.slot, { rank: r.rank, anchored: r.anchored });
        }
        setSlotStates(map);
        setLoadingSlots(false);
      },
      () => { if (alive) { setSlotStates(new Map()); setLoadingSlots(false); } },
    );
    return () => { alive = false; };
  }, [state.preferredDay]);

  const pickDay = (iso: string) => {
    set('preferredDay')(iso);
    if (state.timeSlot) set('timeSlot')(''); // day changed — old time no longer applies
  };

  const pickSlot = (key: string) => {
    set('timeSlot')(key);
    // Backend still tracks morning/afternoon; derive it from the exact time.
    set('window')(Number(key.slice(0, 2)) < 12 ? 'morning' : 'afternoon');
  };

  const selectedHolder = state.timeSlot ? slotStates.get(state.timeSlot) ?? null : null;
  const selectedDecision = decideBump(myRank, selectedHolder);
  const showBumpHint = !!selectedHolder && (selectedDecision === 'bump' || selectedDecision === 'escalate');

  const prevMonth = () => setView((v) => (v.month === 0 ? { year: v.year - 1, month: 11 } : { ...v, month: v.month - 1 }));
  const nextMonth = () => setView((v) => (v.month === 11 ? { year: v.year + 1, month: 0 } : { ...v, month: v.month + 1 }));

  const useMyLocation = async () => {
    const { status } = await Location.requestForegroundPermissionsAsync();
    if (status !== 'granted') return;
    const pos = await Location.getCurrentPositionAsync({});
    const [a] = await Location.reverseGeocodeAsync(pos.coords);
    if (a) set('address')(`${a.streetNumber ?? ''} ${a.street ?? ''}, ${a.city ?? ''} ${a.postalCode ?? ''}`.trim());
  };

  const next = () => {
    if (!state.address.trim()) return Alert.alert('Where to?', 'Enter the address where the vehicle will be.');
    if (!state.preferredDay) return Alert.alert('Pick a day', 'Choose a day on the calendar.');
    if (!state.timeSlot) return Alert.alert('Pick a time', 'Choose an open time slot.');
    navigation.navigate('Pay');
  };

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <ScrollView contentContainerStyle={{ padding: spacing(4), paddingBottom: spacing(6) }}>
        <Text style={s.label}>Where's the vehicle?</Text>
        <TextInput style={s.input} placeholder="Street address" placeholderTextColor={colors.textMuted}
          value={state.address} onChangeText={set('address')} />
        <Pressable accessibilityRole="button" onPress={useMyLocation}>
          <Text style={s.link}>📍 Use my location</Text>
        </Pressable>

        <Text style={s.label}>Pick a day</Text>
        <View style={s.calendar}>
          <View style={s.calHeader}>
            <Pressable accessibilityRole="button" onPress={prevMonth} disabled={atCurrentMonth}
              style={[s.navBtn, atCurrentMonth && { opacity: 0.3 }]} hitSlop={8}>
              <Text style={s.navText}>‹</Text>
            </Pressable>
            <Text style={s.calTitle}>{MONTHS[view.month]} {view.year}</Text>
            <Pressable accessibilityRole="button" onPress={nextMonth} style={s.navBtn} hitSlop={8}>
              <Text style={s.navText}>›</Text>
            </Pressable>
          </View>
          <View style={s.weekRow}>
            {WEEKDAYS.map((w, i) => <Text key={i} style={s.weekday}>{w}</Text>)}
          </View>
          <View style={s.grid}>
            {cells.map((d, i) => {
              if (d === null) return <View key={i} style={s.cell} />;
              const iso = toISO(view.year, view.month, d);
              const past = iso <= todayISO; // bookings start tomorrow
              const tooFar = iso > maxISO;
              const disabled = past || tooFar;
              const on = state.preferredDay === iso;
              return (
                <Pressable key={i} accessibilityRole="button" disabled={disabled}
                  onPress={() => pickDay(iso)}
                  style={[s.cell, s.dayCell, on && s.dayOn, disabled && s.dayPast]}>
                  <Text style={[s.dayNum, on && s.dayNumOn, disabled && s.dayNumPast]}>{d}</Text>
                </Pressable>
              );
            })}
          </View>
        </View>

        <Text style={s.label}>Pick a time {loadingSlots && <ActivityIndicator size="small" color={colors.primaryBright} />}</Text>
        {!state.preferredDay ? (
          <Text style={s.hint}>Choose a day first — open times show here.</Text>
        ) : (
          <>
            <View style={s.slotGrid}>
              {SLOTS.map((slot) => {
                const holder = slotStates.get(slot.key) ?? null;
                const decision = decideBump(myRank, holder);
                const selectable = decision === 'open' || decision === 'bump' || decision === 'escalate';
                const on = state.timeSlot === slot.key;
                const bumpable = !!holder && selectable;
                return (
                  <Pressable key={slot.key} accessibilityRole="button" disabled={!selectable}
                    onPress={() => pickSlot(slot.key)}
                    style={[s.slot, on && s.slotOn, !selectable && s.slotTaken, bumpable && !on && s.slotBumpable]}>
                    <Text style={[s.slotText, on && s.slotTextOn, !selectable && s.slotTextTaken]}>{slot.label}</Text>
                    {!selectable && <Text style={s.takenTag}>{holder?.anchored ? 'LOCKED' : 'TAKEN'}</Text>}
                    {bumpable && <Text style={s.vipTag}>VIP — TAKE IT</Text>}
                  </Pressable>
                );
              })}
            </View>
            {showBumpHint && (
              <Text style={s.hint}>VIP perk: booking this moves the current appointment to the next open time — they'll be notified.</Text>
            )}
          </>
        )}

        <Text style={s.label}>Notes (gate code, which car, etc.)</Text>
        <TextInput style={[s.input, { height: 72, textAlignVertical: 'top' }]} multiline
          placeholder="Optional" placeholderTextColor={colors.textMuted}
          value={state.notes} onChangeText={set('notes')} />
      </ScrollView>
      <PriceBar label="Continue" onNext={next} />
    </View>
  );
}

const CELL = `${100 / 7}%`;

const s = StyleSheet.create({
  label: { color: colors.textMuted, fontSize: 13, textTransform: 'uppercase', letterSpacing: 1, marginTop: spacing(5), marginBottom: spacing(2) },
  input: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, borderRadius: radius.button, color: colors.text, padding: spacing(3.5), fontSize: 16 },
  link: { color: colors.primaryBright, marginTop: spacing(2), fontSize: 14 },
  hint: { color: colors.textMuted, fontSize: 13, marginTop: spacing(1) },

  calendar: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, borderRadius: radius.card, padding: spacing(3) },
  calHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: spacing(2) },
  calTitle: { fontFamily: fonts.heading, color: colors.text, fontSize: 16, letterSpacing: 0.5 },
  navBtn: { width: 40, height: 40, borderRadius: radius.button, borderWidth: 1, borderColor: colors.border, alignItems: 'center', justifyContent: 'center' },
  navText: { color: colors.primaryBright, fontSize: 22, lineHeight: 24 },
  weekRow: { flexDirection: 'row', marginBottom: spacing(1) },
  weekday: { width: CELL, textAlign: 'center', color: colors.textMuted, fontSize: 11, letterSpacing: 1 },
  grid: { flexDirection: 'row', flexWrap: 'wrap' },
  cell: { width: CELL, aspectRatio: 1, alignItems: 'center', justifyContent: 'center', padding: 2 },
  dayCell: { borderRadius: 999 },
  dayOn: { backgroundColor: colors.primary },
  dayPast: { opacity: 0.35 },
  dayNum: { color: colors.textSecondary, fontSize: 15 },
  dayNumOn: { color: colors.text, fontFamily: fonts.heading },
  dayNumPast: { color: colors.textMuted },

  slotGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing(2) },
  slot: {
    width: '31%', minHeight: 48, borderRadius: radius.button, borderWidth: 1, borderColor: colors.border,
    backgroundColor: colors.surface, alignItems: 'center', justifyContent: 'center', paddingVertical: spacing(2),
  },
  slotOn: { borderColor: colors.primaryBright, backgroundColor: '#1a1030' },
  slotTaken: { opacity: 0.45, backgroundColor: '#17161a', borderColor: '#232127' },
  slotBumpable: { borderColor: '#F5B942' },
  slotText: { color: colors.textSecondary, fontSize: 14 },
  slotTextOn: { color: colors.text, fontFamily: fonts.heading },
  slotTextTaken: { color: colors.textMuted, textDecorationLine: 'line-through' },
  takenTag: { color: colors.textMuted, fontSize: 9, letterSpacing: 1, marginTop: 2 },
  vipTag: { color: '#F5B942', fontSize: 9, letterSpacing: 1, marginTop: 2 },
});
