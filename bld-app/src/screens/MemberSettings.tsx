import React, { useState } from 'react';
import { ActivityIndicator, Alert, Image, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../../App';
import type { Size } from '../../../supabase/functions/_shared/pricing';
import type { SavedCar } from '../../../supabase/functions/_shared/membership';
import { SIZE_NAMES } from '../../../supabase/functions/_shared/payments/checkout';
import { useMember } from '../state/member';
import { useAppearance } from '../state/appearance';
import { fonts, themes, type Mode, type Theme } from '../theme';
import { ui } from '../ui';

type Props = NativeStackScreenProps<RootStackParamList, 'MemberSettings'>;
const SIZES: { key: Size; label: string }[] = [
  { key: 'sedan', label: 'SEDAN' }, { key: 'suv', label: 'SUV' }, { key: 'truck', label: 'TRUCK / VAN' },
];
const MAX_CARS = 6;

export default function MemberSettings({ navigation }: Props) {
  const m = useMember();
  const { mode, toggle } = useAppearance();
  const p = m.profile;
  const [tab, setTab] = useState<'info' | 'cars'>('info');
  const [name, setName] = useState(p?.member.name ?? '');
  const [address, setAddress] = useState(p?.member.address ?? '');
  const [carName, setCarName] = useState('');
  const [carSize, setCarSize] = useState<Size>('sedan');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState({ text: '', ok: false });
  if (!p) return null;

  const t = themes[mode];
  const u = ui[mode];
  const s = styles[mode];
  const cars = p.member.cars;
  const dirty = name.trim() !== p.member.name || address.trim() !== p.member.address;

  const switchTab = (next: 'info' | 'cars') => { setTab(next); setNote({ text: '', ok: false }); };
  const saveInfo = async () => {
    if (!name.trim()) return setNote({ text: 'Enter your name.', ok: false });
    setBusy(true);
    const err = await m.saveSettings({ name: name.trim(), address: address.trim() });
    setBusy(false);
    setNote(err
      ? { text: err === 'bad_address' ? 'That address is too long.' : 'Couldn’t save. Check your signal and try again.', ok: false }
      : { text: 'Saved. We’ll fill this in at checkout.', ok: true });
  };
  const saveCars = async (next: SavedCar[]) => {
    setBusy(true);
    const err = await m.saveSettings({ cars: next });
    setBusy(false);
    setNote(err ? { text: 'Couldn’t save your cars. Check your signal and try again.', ok: false } : { text: '', ok: false });
    return !err;
  };
  const addCar = async () => {
    if (!carName.trim()) return setNote({ text: 'Give this car a name, like “Black Tahoe”.', ok: false });
    if (await saveCars([...cars, { name: carName.trim(), size: carSize }])) { setCarName(''); setCarSize('sedan'); }
  };
  const removeCar = (i: number) => {
    Alert.alert(`Remove ${cars[i].name}?`, 'It won’t show up at checkout anymore.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Remove', style: 'destructive', onPress: () => saveCars(cars.filter((_, j) => j !== i)) },
    ]);
  };
  const logOut = () => {
    Alert.alert('Log out?', 'You’ll need the code from your email to get back in.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Log out', style: 'destructive', onPress: () => { m.leave(); navigation.reset({ index: 0, routes: [{ name: 'Home' }] }); } },
    ]);
  };
  const noteView = !!note.text && <Text style={[u.error, note.ok && { color: t.success }]}>{note.text}</Text>;

  return (
    <SafeAreaView style={u.root}>
      <StatusBar style={t.statusBar} />
      <LinearGradient colors={t.bg} style={StyleSheet.absoluteFill} />
      <ScrollView contentContainerStyle={u.content} keyboardShouldPersistTaps="handled">
        <View style={u.topbar}>
          <Pressable accessibilityRole="button" accessibilityLabel="Back" onPress={() => navigation.goBack()} style={u.topButton}><Text style={u.topButtonText}>‹</Text></Pressable>
          <View style={{ alignItems: 'center' }}><Text style={u.topTitle}>SETTINGS</Text><Text style={u.topSub}>{p.member.tier ? 'The Brotherhood' : 'Your account'}</Text></View>
          <Image source={require('../../assets/bld-logo.png')} style={u.logo} resizeMode="contain" />
        </View>
        <Text style={u.eyebrow}>{p.member.tier ? `${p.member.tier.toUpperCase()} MEMBER` : 'YOUR ACCOUNT'}</Text>
        <Text style={u.title}>YOUR INFO,{'\n'}ON FILE.</Text>
        <Text style={u.intro}>Save it once and checkout fills it in for you.</Text>

        <View style={s.tabs}>
          {([['info', 'MY INFO'], ['cars', 'MY CARS']] as const).map(([key, label]) => (
            <Pressable key={key} accessibilityRole="tab" accessibilityState={{ selected: tab === key }} onPress={() => switchTab(key)} style={[u.chip, tab === key && u.chipOn]}>
              <Text style={[u.chipText, tab === key && u.chipTextOn]}>{label}{key === 'cars' && cars.length ? ` · ${cars.length}` : ''}</Text>
            </Pressable>
          ))}
        </View>

        {tab === 'info' ? <>
          <View style={u.sectionHead}><Text style={u.sectionNum}>01</Text><Text style={u.sectionTitle}>YOUR DETAILS</Text></View>
          <View style={u.sheet}>
            <Text style={[u.fieldLabel, s.first]}>YOUR NAME</Text>
            <TextInput accessibilityLabel="Your name" style={u.input} value={name} onChangeText={setName} maxLength={60} placeholder="First and last name" placeholderTextColor={t.faint} keyboardAppearance={mode} autoComplete="name" />
            <Text style={u.fieldLabel}>EMAIL</Text>
            <TextInput accessibilityLabel="Email" style={[u.input, { color: t.muted }]} value={p.member.email} editable={false} />
            <Text style={s.fieldHint}>Your email is tied to your account. Contact us to change it.</Text>
            <Text style={u.fieldLabel}>SERVICE ADDRESS</Text>
            <TextInput accessibilityLabel="Service address" style={u.input} value={address} onChangeText={setAddress} maxLength={200} placeholder="Where we usually meet you" placeholderTextColor={t.faint} keyboardAppearance={mode} autoComplete="street-address" />
            <Pressable accessibilityRole="button" disabled={busy || !dirty} onPress={saveInfo} style={[u.button, s.save, (busy || !dirty) && { opacity: 0.5 }]}>
              {busy ? <ActivityIndicator color="#FFFFFF" /> : <Text style={u.buttonText}>SAVE CHANGES</Text>}
            </Pressable>
            {noteView}
          </View>

          <View style={u.sectionHead}><Text style={u.sectionNum}>02</Text><Text style={u.sectionTitle}>APPEARANCE</Text></View>
          <View style={u.sheet}>
            <View style={s.row}>
              {(['light', 'dark'] as Mode[]).map((k) => (
                <Pressable key={k} accessibilityRole="button" accessibilityState={{ selected: mode === k }} onPress={() => mode !== k && toggle()} style={[u.chip, mode === k && u.chipOn]}>
                  <Text style={[u.chipText, mode === k && u.chipTextOn]}>{k.toUpperCase()}</Text>
                </Pressable>
              ))}
            </View>
          </View>

          <Pressable accessibilityRole="button" onPress={logOut} style={s.logout}><Text style={s.logoutText}>LOG OUT</Text></Pressable>
        </> : <>
          <View style={u.sectionHead}><Text style={u.sectionNum}>01</Text><Text style={u.sectionTitle}>YOUR CARS</Text></View>
          <View style={u.sheet}>
            {!cars.length && <Text style={s.empty}>No cars saved yet. Add the ones we detail and they’ll pop up at checkout.</Text>}
            {cars.map((c, i) => (
              <View key={`${i}-${c.name}`} style={[s.car, i > 0 && s.carRule]}>
                <View style={s.carNum}><Text style={s.carNumText}>{String(i + 1).padStart(2, '0')}</Text></View>
                <View style={{ flex: 1 }}>
                  <Text style={s.carName} numberOfLines={1}>{c.name}</Text>
                  <Text style={s.carSize}>{SIZE_NAMES[c.size]}</Text>
                </View>
                <Pressable accessibilityRole="button" accessibilityLabel={`Remove ${c.name}`} disabled={busy} onPress={() => removeCar(i)} style={s.remove}>
                  <Text style={s.removeText}>REMOVE</Text>
                </Pressable>
              </View>
            ))}
          </View>

          <View style={u.sectionHead}><Text style={u.sectionNum}>02</Text><Text style={u.sectionTitle}>ADD A CAR</Text></View>
          <View style={u.sheet}>
            {cars.length >= MAX_CARS ? <Text style={s.empty}>That’s the max of {MAX_CARS} cars. Remove one to add another.</Text> : <>
              <Text style={[u.fieldLabel, s.first]}>WHAT DO YOU CALL IT?</Text>
              <TextInput accessibilityLabel="Car name" style={u.input} value={carName} onChangeText={setCarName} maxLength={40} placeholder="e.g. Black Tahoe" placeholderTextColor={t.faint} keyboardAppearance={mode} returnKeyType="done" />
              <Text style={u.fieldLabel}>SIZE</Text>
              <View style={s.row}>
                {SIZES.map((z) => (
                  <Pressable key={z.key} accessibilityRole="button" accessibilityState={{ selected: carSize === z.key }} onPress={() => setCarSize(z.key)} style={[u.chip, carSize === z.key && u.chipOn]}>
                    <Text style={[u.chipText, carSize === z.key && u.chipTextOn]}>{z.label}</Text>
                  </Pressable>
                ))}
              </View>
              <Pressable accessibilityRole="button" disabled={busy} onPress={addCar} style={[u.button, s.save, busy && { opacity: 0.5 }]}>
                {busy ? <ActivityIndicator color="#FFFFFF" /> : <Text style={u.buttonText}>ADD CAR</Text>}
              </Pressable>
            </>}
            {noteView}
          </View>
        </>}
      </ScrollView>
    </SafeAreaView>
  );
}

const make = (t: Theme) => StyleSheet.create({
  tabs: { flexDirection: 'row', gap: 8, marginTop: 22 },
  row: { flexDirection: 'row', gap: 8 },
  first: { marginTop: 0 },
  fieldHint: { color: t.faint, fontSize: 12, lineHeight: 17 },
  save: { marginTop: 18 },
  logout: { minHeight: 52, borderRadius: 16, borderWidth: 1.5, borderColor: t.error, alignItems: 'center', justifyContent: 'center', marginTop: 29 },
  logoutText: { color: t.error, fontFamily: fonts.heading, fontSize: 14, letterSpacing: 0.4 },
  empty: { color: t.muted, fontSize: 14, lineHeight: 20 },
  car: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 12 },
  carRule: { borderTopWidth: 1, borderTopColor: t.line },
  carNum: { width: 40, height: 40, borderRadius: 14, backgroundColor: t.soft, alignItems: 'center', justifyContent: 'center' },
  carNumText: { color: t.accent, fontFamily: fonts.heading, fontSize: 14 },
  carName: { color: t.text, fontSize: 16, fontWeight: '600' },
  carSize: { color: t.muted, fontSize: 12, marginTop: 2 },
  remove: { paddingHorizontal: 12, paddingVertical: 9, borderRadius: 12, backgroundColor: t.chip },
  removeText: { color: t.muted, fontFamily: fonts.heading, fontSize: 11, letterSpacing: 0.8 },
});
const styles = { light: make(themes.light), dark: make(themes.dark) };
