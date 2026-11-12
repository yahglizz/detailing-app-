import React, { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Image, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import * as ImagePicker from 'expo-image-picker';
import * as Location from 'expo-location';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../../App';
import { SERVICES, VEHICLES, type DetailService, type VehicleType } from '../../../supabase/functions/_shared/detail_pricing';
import { MAX_PHOTOS, PHOTO_EXTS } from '../../../supabase/functions/_shared/detail_booking';
import { decideBump } from '../../../supabase/functions/_shared/bump';
import { detail } from '../api';
import { useCatalog } from '../state/catalog';
import { useMember } from '../state/member';
import TestTierSwitch from '../components/TestTierSwitch';
import { MAX_CARS, useOrder, type Car, type Condition } from '../state/order';
import { useAppearance } from '../state/appearance';
import { brandGradient, fonts, themes, type Theme } from '../theme';
import { ui } from '../ui';

type Props = NativeStackScreenProps<RootStackParamList, 'Build'>;

// Server answers. The device never computes a price: it shows these numbers.
type Line = { service: DetailService; vehicleType: VehicleType; startingPrice: number; deposit: number; covered?: boolean; payable?: number };
type MemberPart = { lines: Line[]; subtotal: number; payable: number; deposit: number; rewardUsed: boolean; memberDiscount: number; savings: number; tier: string };
type Quote = { lines: Line[]; subtotal: number; deposit: number; member?: MemberPart };
type Day = { day: string; capacity: number; booked: number; closed: boolean };
type DayInfo = { taken: string[]; minSlot?: string; holders?: Record<string, number> };
type Paid = { ok?: boolean; day?: string | null; slot?: string | null };
type Reserved = { bookingId: string; payKey: string; uploads?: ({ path: string; signedUrl: string } | null)[]; escalated?: boolean; paidFromBalance?: boolean };

const STEPS = ['YOUR CARS', 'WHERE & WHEN', 'YOU', 'PHOTOS', 'REVIEW'];
export const DISCLAIMER = 'Prices shown are starting estimates. Final pricing is confirmed after an in-person vehicle inspection. Your booking deposit is applied toward your final service total. Any additional charges must be approved before work begins.';
const CONDITIONS: [Condition, string, string][] = [['light', 'LIGHT', 'Mostly clean'], ['moderate', 'MODERATE', 'Everyday dirt'], ['heavy', 'HEAVY', 'Stains or odor']];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MIME: Record<string, string> = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', heic: 'image/heic' };
const localDate = (iso: string) => { const [y, m, d] = iso.split('-').map(Number); return new Date(y, m - 1, d); };
export const fmtSlot = (slot: string) => { const h = Number(slot.slice(0, 2)); return `${h > 12 ? h - 12 : h}:00 ${h >= 12 ? 'PM' : 'AM'}`; };
const looksLikeEmail = (raw: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw.trim());
const extOf = (a: ImagePicker.ImagePickerAsset) => {
  const e = a.uri.split('?')[0].split('.').pop()?.toLowerCase() ?? '';
  return (PHOTO_EXTS as readonly string[]).includes(e) ? e : a.mimeType === 'image/png' ? 'png' : 'jpg';
};

export default function Build({ navigation }: Props) {
  const { state, dispatch } = useOrder();
  const catalog = useCatalog();
  const { profile, code, refresh } = useMember();
  const { mode } = useAppearance();
  const t = themes[mode];
  const u = ui[mode];
  const s = styles[mode];
  const pricing = catalog.pricing;
  const plan = profile?.plan ?? null;
  const myRank = plan ? catalog.membership?.[plan.tier]?.rank ?? 0 : 0;
  const savedCars = profile?.member.cars ?? [];

  const [quote, setQuote] = useState<Quote | null>(null);
  const [quoteFailed, setQuoteFailed] = useState(false);
  const [days, setDays] = useState<Day[]>([]);
  const [dayInfo, setDayInfo] = useState<DayInfo | null>(null);
  const [useBalance, setUseBalance] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [step, setStep] = useState(0);
  const scroller = useRef<ScrollView>(null);
  const goStep = (n: number) => { setError(''); setStep(n); scroller.current?.scrollTo({ y: 0, animated: false }); };
  // A reserved-but-unpaid booking holds its time slot; leaving this screen frees it.
  const hold = useRef<{ bookingId: string; payKey: string } | null>(null);
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; if (hold.current) void detail({ action: 'release', ...hold.current }); }, []);
  const quoteReq = useRef(0);

  const set = (field: 'street' | 'zip' | 'day' | 'slot' | 'notes' | 'name' | 'phone' | 'email') => (value: string) =>
    dispatch({ type: 'SET_FIELD', field, value });
  const setCar = <K extends keyof Omit<Car, 'label'>>(index: number, field: K, value: Car[K]) =>
    dispatch({ type: 'SET_CAR_FIELD', index, field, value });

  // Members: fill in what Settings knows (name, email, address, first saved car) once per visit.
  const prefilled = useRef(false);
  useEffect(() => {
    if (!profile || prefilled.current) return;
    prefilled.current = true;
    if (!state.name.trim()) set('name')(profile.member.name ?? '');
    set('email')(profile.member.email ?? '');
    const addr = (profile.member.address ?? '').trim();
    if (addr && !state.street.trim()) {
      // saved as one line; a trailing ZIP goes in the ZIP field
      const zip = /\b(\d{5})(?:-\d{4})?\s*$/.exec(addr);
      set('street')(zip ? addr.slice(0, zip.index).replace(/[,\s]+$/, '') : addr);
      if (zip && !state.zip) set('zip')(zip[1]);
    }
    const [car, ...more] = state.cars;
    if (savedCars[0] && !more.length && !car.year && !car.make && !car.label) dispatch({ type: 'PREFILL_CAR', index: 0, car: savedCars[0] });
  }, [profile]);

  // Server quote whenever the cars or the member change (300 ms debounce).
  const quoteKey = JSON.stringify([state.cars.map((c) => [c.service, c.vehicleType]), code, plan?.tier, profile?.credits, profile?.issuedRewards.length]);
  const fetchQuote = async () => {
    const id = ++quoteReq.current;
    const { data } = await detail<Quote>({
      action: 'quote', cars: state.cars.map((c) => ({ service: c.service, vehicleType: c.vehicleType })), memberCode: code ?? undefined,
    });
    if (id !== quoteReq.current || !mounted.current) return data; // a newer quote is in flight
    setQuoteFailed(!data);
    if (data) setQuote(data);
    return data;
  };
  useEffect(() => {
    quoteReq.current++; // drop any answer still in flight for the old cars
    setQuote(null);
    const id = setTimeout(fetchQuote, 300);
    return () => clearTimeout(id);
  }, [quoteKey]);

  // The 14-day window with each day's room, and the chosen day's taken times.
  const loadDays = () => detail<{ days: Day[] }>({ action: 'availability' }).then(({ data }) => { if (data) setDays(data.days ?? []); });
  const loadDay = (day: string, alive: () => boolean = () => true) => {
    setDayInfo(null);
    // Ignore a late answer for a day the customer has already moved off.
    return detail<DayInfo>({ action: 'availability', day }).then(({ data }) => { if (alive()) setDayInfo(data ?? { taken: [] }); });
  };
  useEffect(() => { void loadDays(); }, []);
  useEffect(() => {
    let alive = true;
    if (state.day) void loadDay(state.day, () => alive);
    return () => { alive = false; };
  }, [state.day]);

  const pickDay = (iso: string) => { set('day')(iso); set('slot')(''); };
  const useMyLocation = async () => {
    try {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== 'granted') return;
      const pos = await Location.getCurrentPositionAsync({});
      const [a] = await Location.reverseGeocodeAsync(pos.coords);
      if (a) {
        set('street')(`${a.streetNumber ?? ''} ${a.street ?? ''}`.trim());
        if (a.postalCode) set('zip')(a.postalCode.slice(0, 5));
      }
    } catch { Alert.alert('Location unavailable', 'Please type the service address instead.'); }
  };
  const addPhotos = async () => {
    const room = MAX_PHOTOS - state.photos.length;
    if (room < 1) return;
    const res = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], allowsMultipleSelection: true, selectionLimit: room, quality: 0.7 });
    if (res.canceled) return;
    dispatch({ type: 'SET_PHOTOS', photos: [...state.photos, ...res.assets.slice(0, room).map((a) => ({ uri: a.uri, ext: extOf(a) }))] });
  };

  // What the customer pays: the member price when the server sent one.
  const total = quote ? quote.member?.payable ?? quote.subtotal : 0;
  const deposit = quote ? quote.member?.deposit ?? quote.deposit : 0;
  const lines = quote ? quote.member?.lines ?? quote.lines : [];
  const canUseBalance = !!profile && deposit > 0 && profile.wallet >= deposit;
  const payWithBalance = useBalance && canUseBalance;
  const savings = quote?.member?.savings ?? 0;

  // one list per step so NEXT only checks what's on screen
  const checks = (n: number) => {
    if (n === 0) for (const [i, c] of state.cars.entries()) {
      const which = state.cars.length > 1 ? ` for car ${i + 1}` : '';
      if (!/^(19|20)\d{2}$/.test(c.year)) return `Enter the year${which}, like 2019.`;
      if (!c.make.trim()) return `Enter the brand${which}.`;
      if (!c.condition) return `Choose the interior condition${which}.`;
      if (c.petHair === null) return `Tell us if there is pet hair${which}.`;
    }
    if (n === 1) {
    if (!state.street.trim()) return 'Enter the street address.';
    if (!/^\d{5}$/.test(state.zip.trim())) return 'Enter a 5-digit ZIP code.';
    if (!state.day) return 'Choose a day.';
    if (!state.slot) return 'Choose a time.';
    }
    if (n !== 2) return '';
    if (!state.name.trim()) return 'Enter your name.';
    const digits = state.phone.replace(/\D/g, '');
    if (digits.length < 10 || digits.length > 15) return 'Enter a phone number we can text.';
    if (!profile && !looksLikeEmail(state.email)) return "That email doesn't look right.";
    return '';
  };
  const validate = () => { for (let n = 0; n < 3; n++) { const m = checks(n); if (m) { goStep(n); return m; } } return ''; };
  const next = () => { const m = checks(step); if (m) setError(m); else goStep(step + 1); };

  // Server error code -> what to tell the customer (and fix what we can).
  const explain = async (err: string): Promise<string> => {
    const at = ({ bad_vehicle: 0, slot_taken: 1, day_full: 1, day_closed: 1, bad_day: 1, bad_slot: 1, bad_zip: 1, bad_email: 2, bad_phone: 2, bad_photos: 3 } as Record<string, number>)[err];
    if (at !== undefined) goStep(at);
    switch (err) {
      case 'slot_taken': set('slot')(''); if (state.day) void loadDay(state.day); return 'That time just got booked. Pick another time.';
      case 'day_full': case 'day_closed': case 'bad_day':
        pickDay(''); void loadDays(); return err === 'day_closed' ? 'We’re closed that day. Pick another day.' : 'That day can’t be booked anymore. Pick another day.';
      case 'bad_slot': set('slot')(''); if (state.day) void loadDay(state.day); return 'That time has passed. Pick a later time.';
      case 'price_changed': {
        // re-quote through `quote` (same server maths as reserve) and show it
        const q = await fetchQuote();
        return q ? `Your price changed. New total $${q.member?.payable ?? q.subtotal}, deposit $${q.member?.deposit ?? q.deposit}. Tap again to book.` : 'Prices were just updated. Tap again to book.';
      }
      case 'balance_changed': setUseBalance(false); await refresh(); return 'Your balance just changed. Check the total and tap again.';
      case 'invalid_code': return 'Your code stopped working. Log in again.';
      case 'rate_limited': return 'Too many tries. Wait 15 minutes and try again.';
      case 'too_many': return 'That’s a lot of bookings at once. Call or text us and we’ll set it up.';
      case 'bad_email': return "That email doesn't look right.";
      case 'bad_phone': return 'Check your phone number.';
      case 'bad_zip': return 'Enter a 5-digit ZIP code.';
      case 'bad_vehicle': return 'Check the year of each car.';
      case 'bad_photos': return 'One of your photos can’t be sent. Remove it and try again.';
      case 'payments_not_demo': return 'Online booking is paused right now. Call or text us to book.';
      case 'network': return 'Network problem. Check your signal and try again.';
      default: return err.startsWith('bad_') || err === 'missing_fields' ? 'Please check your details and try again.' : 'Something went wrong. Try again in a minute.';
    }
  };

  const reserve = async () => {
    const issue = validate();
    if (issue) { setError(issue); return; }
    if (!quote) return;
    setError(''); setBusy(true);
    try {
      const { data, error: err } = await detail<Reserved>({
        action: 'reserve',
        cars: state.cars.map(({ year, make, vehicleType, service, condition, petHair }) => ({ year, make: make.trim(), vehicleType, service, condition, petHair })),
        // the server requires an email even for code bookings (it uses the account's)
        name: state.name.trim(), phone: state.phone.trim(), email: (profile ? profile.member.email : state.email).trim().toLowerCase(),
        street: state.street.trim(), zip: state.zip.trim(), day: state.day, slot: state.slot, notes: state.notes.trim(),
        photoExts: state.photos.map((p) => p.ext),
        memberCode: code ?? undefined, useBalance: payWithBalance, expectedTotal: total,
      });
      if (!mounted.current) {
        // Left the screen mid-request: free the hold; a balance booking is already real and paid.
        if (data && !data.paidFromBalance) void detail({ action: 'release', bookingId: data.bookingId, payKey: data.payKey });
        return;
      }
      if (!data) { setError(await explain(err ?? 'network')); return; }
      hold.current = data.paidFromBalance ? null : { bookingId: data.bookingId, payKey: data.payKey };

      // Photos go straight to storage; a failed upload never blocks the booking (same as the website).
      // Snapshot at submit time: the confirmation never reads live order state.
      const snap = {
        address: `${state.street.trim()}, ${state.zip.trim()}`,
        cars: state.cars.map((c) => `${c.year} ${c.make.trim()}`.trim()).join(', '),
      };
      let photosFailed = 0;
      await Promise.all(state.photos.map(async (p, i) => {
        const up = data.uploads?.[i];
        if (!up) { photosFailed++; return; }
        try {
          const blob = await (await fetch(p.uri)).blob();
          const res = await fetch(up.signedUrl, { method: 'PUT', headers: { 'content-type': MIME[p.ext] ?? 'image/jpeg' }, body: blob });
          if (!res.ok) photosFailed++;
        } catch { photosFailed++; }
      }));
      if (!mounted.current) return; // unmount cleanup already released the hold

      // The deposit step moves the hold to a request (also for $0 member bookings).
      // Where the booking really sits: pay-demo reports it (a VIP bump may have moved it);
      // a balance booking uses what was reserved (no time when escalated).
      let when: { day: string; slot: string | null } = { day: state.day, slot: data.escalated ? null : state.slot };
      if (!data.paidFromBalance) {
        const paid = await detail<Paid>({ action: 'pay-demo', bookingId: data.bookingId, payKey: data.payKey });
        if (!mounted.current) return; // cleanup released the hold; booking not confirmed here
        if (!paid.data) {
          // start clean next tap: free this hold, then explain (price_changed re-quotes)
          void detail({ action: 'release', ...hold.current! });
          hold.current = null;
          setError(await explain(paid.error ?? 'network'));
          return;
        }
        // old backend: no day/slot in the answer -> keep what was picked
        if (paid.data.day) when = { day: paid.data.day, slot: paid.data.slot ?? null };
      }
      hold.current = null;
      // final check: a VIP may have moved the booking since (e.g. during the photo upload)
      const now = await detail<{ day: string; slot: string | null }>({ action: 'status', bookingId: data.bookingId, payKey: data.payKey }).catch(() => null);
      if (now?.data?.day) when = { day: now.data.day, slot: now.data.slot ?? null };
      if (profile) await refresh();
      if (!mounted.current) return;
      navigation.reset({ index: 0, routes: [{ name: 'Booked', params: {
        bookingId: data.bookingId, escalated: !!data.escalated, photosFailed,
        day: when.day, slot: when.slot, address: snap.address, cars: snap.cars,
        paid: data.paidFromBalance ? 'balance' : deposit === 0 ? 'membership' : 'demo',
        stamps: plan ? state.cars.length * plan.stampsPerCar : 0, saved: savings,
      } }] });
    } finally {
      if (mounted.current) setBusy(false);
    }
  };

  // 14-day calendar laid out under weekday headers.
  const firstDay = days[0] ? localDate(days[0].day) : null;
  const lastDay = days.length ? localDate(days[days.length - 1].day) : null;
  const monthTitle = firstDay && lastDay
    ? (firstDay.getMonth() === lastDay.getMonth() ? MONTHS[firstDay.getMonth()] : `${MONTHS[firstDay.getMonth()]} – ${MONTHS[lastDay.getMonth()]}`).toUpperCase()
    : '';
  const cells: (Day | null)[] = firstDay ? [...Array(firstDay.getDay()).fill(null), ...days] : [];
  while (cells.length % 7) cells.push(null);

  const slots = catalog.slots.length ? catalog.slots : [];
  const holderOf = (slot: string) => (dayInfo?.taken.includes(slot)
    // a taken time missing from `holders` is treated as locked
    ? { rank: dayInfo.holders?.[slot] ?? 0, anchored: !(dayInfo.holders && slot in dayInfo.holders) }
    : null);
  const chosen = state.slot ? decideBump(myRank, holderOf(state.slot)) : 'open';
  const vehicleName = (v: VehicleType) => pricing?.vehicleTypes[v] ?? v;
  const serviceName = (sv: DetailService) => pricing?.services[sv]?.name ?? sv;
  const buttonLabel = deposit === 0 && quote ? 'BOOK WITH YOUR MEMBERSHIP' : payWithBalance ? 'PAY DEPOSIT FROM BALANCE' : 'RESERVE WITH DEMO DEPOSIT';

  if (!pricing) {
    return (
      <SafeAreaView style={[u.root, s.center]}>
        <LinearGradient colors={t.bg} style={StyleSheet.absoluteFill} />
        {catalog.failed
          ? <><Text style={u.hint}>Couldn’t load our prices. Check your signal.</Text><Pressable accessibilityRole="button" onPress={catalog.reload} style={[u.button, s.retry]}><Text style={u.buttonText}>TRY AGAIN</Text></Pressable></>
          : <ActivityIndicator color={t.accent} />}
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={u.root} edges={['top', 'left', 'right']}>
      <StatusBar style={t.statusBar} />
      <LinearGradient colors={t.bg} style={StyleSheet.absoluteFill} />
      <View style={{ flex: 1, opacity: busy ? 0.6 : 1 }} pointerEvents={busy ? 'none' : 'auto'}>
      <ScrollView ref={scroller} contentContainerStyle={u.content} keyboardShouldPersistTaps="handled">
        <View style={u.topbar}>
          <Pressable accessibilityRole="button" accessibilityLabel="Back" disabled={busy} onPress={() => step ? goStep(step - 1) : navigation.goBack()} style={u.topButton}><Text style={u.topButtonText}>‹</Text></Pressable>
          <View style={{ alignItems: 'center' }}><Text style={u.topTitle}>BOOK YOUR DETAIL</Text><Text style={u.topSub}>STEP {step + 1} OF {STEPS.length} · {STEPS[step]}</Text></View>
          <Image source={require('../../assets/bld-logo.png')} style={u.logo} resizeMode="contain" />
        </View>
        <View style={s.progress}>{STEPS.map((_, i) => <View key={i} style={[s.progressBar, i <= step && s.progressOn]} />)}</View>
        {step === 0 && <>
        <Text style={u.eyebrow}>THE BROTHERLY LOVE EXPERIENCE</Text>
        <Text style={u.title}>A FRESH START{'\n'}FOR YOUR RIDE.</Text>
        <Text style={u.intro}>Pick your cars and your package, then tap next.</Text>
        <TestTierSwitch mode={mode} />

        <View style={u.sectionHead}><Text style={u.sectionNum}>01</Text><Text style={u.sectionTitle}>YOUR CARS</Text></View>
        {state.cars.map((car, i) => <View key={i} style={[u.sheet, i > 0 && s.nextSheet]}>
          <View style={u.rowBetween}>
            <Text style={s.carTitle}>CAR {String(i + 1).padStart(2, '0')}{car.label ? ` · ${car.label.toUpperCase()}` : ''}</Text>
            {state.cars.length > 1 && <Pressable accessibilityRole="button" accessibilityLabel={`Remove car ${i + 1}`} onPress={() => dispatch({ type: 'REMOVE_CAR', index: i })} style={s.remove}><Text style={s.removeText}>REMOVE</Text></Pressable>}
          </View>
          {!!savedCars.length && <>
            <Text style={u.fieldLabel}>YOUR SAVED CARS</Text>
            <View style={s.wrap}>{savedCars.map((saved, j) => {
              const selected = car.label === saved.name;
              const size = (saved.size as string) === 'truck' ? 'suv' : saved.size;
              return <Pressable key={j} accessibilityRole="button" accessibilityState={{ selected }} onPress={() => dispatch({ type: 'PREFILL_CAR', index: i, car: saved })} style={[s.pill, selected && s.pillOn]}><Text style={s.pillText}>{selected ? '✓ ' : ''}{saved.name} · {vehicleName(size)}</Text></Pressable>;
            })}</View>
          </>}
          <View style={s.twoCol}>
            <View style={s.yearCol}>
              <Text style={u.fieldLabel}>YEAR</Text>
              <TextInput accessibilityLabel={`Year of car ${i + 1}`} style={u.input} placeholder="2019" placeholderTextColor={t.faint} keyboardAppearance={mode} keyboardType="number-pad" maxLength={4} value={car.year} onChangeText={(v) => setCar(i, 'year', v.replace(/\D/g, ''))} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={u.fieldLabel}>BRAND</Text>
              <TextInput accessibilityLabel={`Brand of car ${i + 1}`} style={u.input} placeholder="Honda" placeholderTextColor={t.faint} keyboardAppearance={mode} autoCapitalize="words" maxLength={40} value={car.make} onChangeText={(v) => setCar(i, 'make', v)} />
            </View>
          </View>
          <Text style={[u.fieldLabel, s.tight]}>VEHICLE TYPE</Text>
          <View style={s.row}>{VEHICLES.map((v) => {
            const on = car.vehicleType === v;
            return <Pressable key={v} accessibilityRole="button" accessibilityState={{ selected: on }} onPress={() => setCar(i, 'vehicleType', v)} style={[u.chip, on && u.chipOn]}><Text style={[u.chipText, on && u.chipTextOn]}>{vehicleName(v).toUpperCase()}</Text></Pressable>;
          })}</View>
          <Text style={u.fieldLabel}>PACKAGE · STARTING PRICES</Text>
          {SERVICES.map((sv) => {
            const on = car.service === sv;
            const svc = pricing.services[sv];
            const inPlan = !!plan?.visits?.[sv];
            return <Pressable key={sv} accessibilityRole="button" accessibilityState={{ selected: on }} onPress={() => setCar(i, 'service', sv)} style={[s.pkg, on && s.pkgOn]}>
              <View style={{ flex: 1 }}>
                <Text style={s.pkgName}>{svc.name.toUpperCase()}</Text>
                <Text style={s.pkgSub}>{svc.duration}{svc.popular ? ' · Most booked' : ''}{inPlan ? ' · In your plan' : ''}</Text>
              </View>
              <Text style={s.pkgPrice}>FROM ${svc.prices[car.vehicleType]}</Text>
            </Pressable>;
          })}
          <Text style={u.fieldLabel}>INTERIOR CONDITION</Text>
          <View style={s.row}>{CONDITIONS.map(([key, label, hint]) => {
            const on = car.condition === key;
            return <Pressable key={key} accessibilityRole="button" accessibilityLabel={`${label} condition`} accessibilityState={{ selected: on }} onPress={() => setCar(i, 'condition', key)} style={[u.chip, s.tallChip, on && u.chipOn]}><Text style={[u.chipText, on && u.chipTextOn]}>{label}</Text><Text style={[s.chipHint, on && u.chipTextOn]}>{hint}</Text></Pressable>;
          })}</View>
          <Text style={u.fieldLabel}>PET HAIR?</Text>
          <View style={s.row}>{([[true, 'YES'], [false, 'NO']] as const).map(([val, label]) => {
            const on = car.petHair === val;
            return <Pressable key={label} accessibilityRole="button" accessibilityLabel={`Pet hair ${label.toLowerCase()}`} accessibilityState={{ selected: on }} onPress={() => setCar(i, 'petHair', val)} style={[u.chip, on && u.chipOn]}><Text style={[u.chipText, on && u.chipTextOn]}>{label}</Text></Pressable>;
          })}</View>
        </View>)}
        {state.cars.length < MAX_CARS && <Pressable accessibilityRole="button" onPress={() => dispatch({ type: 'ADD_CAR' })} style={s.addCar}><Text style={s.addCarText}>+ ADD ANOTHER CAR</Text></Pressable>}

        </>}
        {step === 1 && <>
        <View style={u.sectionHead}><Text style={u.sectionNum}>02</Text><Text style={u.sectionTitle}>WHERE & WHEN</Text></View>
        <View style={u.sheet}>
          <Text style={u.fieldHeading}>WHERE SHOULD WE MEET YOU?</Text>
          <Text style={[u.fieldLabel, s.tight]}>STREET ADDRESS</Text>
          <TextInput accessibilityLabel="Street address" style={u.input} placeholder="2841 S 12th St" placeholderTextColor={t.faint} keyboardAppearance={mode} autoComplete="street-address" maxLength={120} value={state.street} onChangeText={set('street')} />
          <TextInput accessibilityLabel="ZIP code" style={u.input} placeholder="ZIP code" placeholderTextColor={t.faint} keyboardAppearance={mode} keyboardType="number-pad" autoComplete="postal-code" maxLength={5} value={state.zip} onChangeText={(v) => set('zip')(v.replace(/\D/g, ''))} />
          <Pressable accessibilityRole="button" onPress={useMyLocation}><Text style={s.link}>USE MY LOCATION</Text></Pressable>

          <View style={s.calendarHead}><View><Text style={u.fieldLabel}>PICK A DAY</Text><Text style={s.monthTitle}>{monthTitle}</Text></View></View>
          {!days.length ? <ActivityIndicator color={t.accent} /> : <>
            <View style={s.weekRow}>{WEEKDAYS.map((d) => <Text key={d} style={s.weekday}>{d}</Text>)}</View>
            <View style={s.calendarGrid}>{cells.map((d, index) => {
              if (!d) return <View key={index} style={s.dayWrap} />;
              const date = localDate(d.day);
              const disabled = d.closed || d.booked >= d.capacity;
              const selected = state.day === d.day;
              return <View key={index} style={s.dayWrap}><Pressable accessibilityRole="button" accessibilityLabel={`${MONTHS[date.getMonth()]} ${date.getDate()}`} accessibilityState={{ selected, disabled }} disabled={disabled} onPress={() => pickDay(d.day)} style={[s.dayTile, selected && s.daySelected, disabled && s.dayDisabled]}><Text style={[s.dayText, selected && u.chipTextOn]}>{date.getDate()}</Text></Pressable></View>;
            })}</View>
          </>}

          <Text style={u.fieldLabel}>PICK A TIME {state.day && !dayInfo ? '· CHECKING TIMES' : ''}</Text>
          {!state.day ? <Text style={u.hint}>Choose a day to see open times.</Text> : <View style={s.wrap}>{slots.map((slot) => {
            const holder = holderOf(slot);
            const decision = decideBump(myRank, holder);
            const past = !!dayInfo?.minSlot && slot < dayInfo.minSlot;
            const selectable = !!dayInfo && !past && decision !== 'blocked';
            const selected = state.slot === slot;
            const tag = !holder ? '' : decision === 'bump' ? 'VIP' : decision === 'escalate' ? 'ASK' : 'TAKEN';
            return <Pressable key={slot} accessibilityRole="button" accessibilityLabel={`${fmtSlot(slot)}${tag ? ` ${tag}` : ''}`} accessibilityState={{ selected, disabled: !selectable }} disabled={!selectable} onPress={() => set('slot')(slot)} style={[s.timeChip, selected && u.chipOn, !selectable && s.timeChipOff]}><Text style={[s.timeText, selected && u.chipTextOn]}>{fmtSlot(slot)}</Text>{!!tag && <Text style={[s.timeTag, selected && u.chipTextOn]}>{tag}</Text>}</Pressable>;
          })}</View>}
          {chosen === 'bump' && <Text style={u.hint}>VIP perk: your booking takes this time and the current one moves to the next open time.</Text>}
          {chosen === 'escalate' && <Text style={u.hint}>Another member of your tier holds this time. We’ll confirm your exact time.</Text>}
          <Text style={u.fieldLabel}>ANYTHING ELSE?</Text>
          <TextInput accessibilityLabel="Booking notes" style={[u.input, s.notes]} multiline maxLength={500} placeholder="Gate code, parking, or a quick note" placeholderTextColor={t.faint} keyboardAppearance={mode} value={state.notes} onChangeText={set('notes')} />
        </View>

        </>}
        {step === 2 && <>
        <View style={u.sectionHead}><Text style={u.sectionNum}>03</Text><Text style={u.sectionTitle}>YOU</Text></View>
        <View style={u.sheet}>
          <Text style={[u.fieldLabel, s.tight]}>YOUR NAME</Text>
          <TextInput accessibilityLabel="Your name" style={u.input} placeholder="First and last name" placeholderTextColor={t.faint} keyboardAppearance={mode} autoComplete="name" maxLength={60} value={state.name} onChangeText={set('name')} />
          <Text style={u.fieldLabel}>PHONE</Text>
          <TextInput accessibilityLabel="Phone number" style={u.input} placeholder="(215) 555-0123" placeholderTextColor={t.faint} keyboardAppearance={mode} keyboardType="phone-pad" autoComplete="tel" maxLength={30} value={state.phone} onChangeText={set('phone')} />
          <Text style={u.fieldLabel}>EMAIL FOR BOOKING UPDATES</Text>
          {profile
            ? <TextInput accessibilityLabel="Email address" style={[u.input, { color: t.muted }]} value={profile.member.email} editable={false} />
            : <TextInput accessibilityLabel="Email address" style={u.input} placeholder="you@email.com" placeholderTextColor={t.faint} keyboardAppearance={mode} keyboardType="email-address" autoCapitalize="none" autoCorrect={false} autoComplete="email" maxLength={254} value={state.email} onChangeText={set('email')} />}
        </View>

        </>}
        {step === 3 && <>
        <View style={u.sectionHead}><Text style={u.sectionNum}>04</Text><Text style={u.sectionTitle}>PHOTOS</Text></View>
        <View style={u.sheet}>
          <Text style={u.fieldHeading}>OPTIONAL, BUT HELPFUL.</Text>
          <Text style={u.hint}>Up to {MAX_PHOTOS} photos of the interior or problem spots help us confirm your price.</Text>
          {!!state.photos.length && <View style={[s.wrap, s.photoRow]}>{state.photos.map((p, i) => (
            <View key={p.uri}>
              <Image source={{ uri: p.uri }} style={s.thumb} />
              <Pressable accessibilityRole="button" accessibilityLabel={`Remove photo ${i + 1}`} onPress={() => dispatch({ type: 'SET_PHOTOS', photos: state.photos.filter((_, j) => j !== i) })} style={s.thumbX}><Text style={s.thumbXText}>×</Text></Pressable>
            </View>
          ))}</View>}
          {state.photos.length < MAX_PHOTOS && <Pressable accessibilityRole="button" onPress={addPhotos} style={s.addCar}><Text style={s.addCarText}>+ ADD PHOTOS</Text></Pressable>}
        </View>

        </>}
        {step === 4 && <>
        <View style={u.sectionHead}><Text style={u.sectionNum}>05</Text><Text style={u.sectionTitle}>REVIEW & DEPOSIT</Text></View>
        <LinearGradient colors={brandGradient} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={[u.summary, s.summaryTop]}>
          <Text style={u.summaryOverline}>YOUR DETAIL AT A GLANCE</Text>
          {!quote ? (quoteFailed
            ? <Pressable accessibilityRole="button" onPress={fetchQuote}><Text style={u.summaryLabel}>Couldn’t get your price. Tap to try again.</Text></Pressable>
            : <ActivityIndicator color="#FFFFFF" />) : <>
            {lines.map((l, i) => {
              const car = state.cars[i];
              const who = car ? `${car.year} ${car.make}`.trim() : '';
              const pay = l.payable ?? l.startingPrice;
              return <View key={i} style={[u.rowBetween, i > 0 && s.summaryRow]}>
                <View style={{ flex: 1, paddingRight: 10 }}>
                  <Text style={u.summaryLabel}>{serviceName(l.service)}</Text>
                  <Text style={u.summaryNote}>Car {i + 1}{who ? ` · ${who}` : ''} · {vehicleName(l.vehicleType)}</Text>
                </View>
                <View style={{ alignItems: 'flex-end' }}>
                  <Text style={u.summaryValue}>{l.covered && pay === 0 ? 'INCLUDED' : `$${pay}`}</Text>
                  {pay !== l.startingPrice && <Text style={[u.summaryNote, s.struck]}>${l.startingPrice}</Text>}
                </View>
              </View>;
            })}
            <View style={u.summaryRule} />
            <View style={u.rowBetween}><Text style={u.summaryLabel}>{quote.member ? 'Starting price' : 'Starting total'}</Text><Text style={[u.summaryValue, !!quote.member && savings > 0 && s.struck]}>${quote.subtotal}</Text></View>
            {quote.member && <>
              <View style={[u.rowBetween, s.summaryRow]}><Text style={u.summaryLabel}>Your {quote.member.tier.toUpperCase()} price</Text><Text style={u.summaryValue}>${quote.member.payable}</Text></View>
              {quote.member.rewardUsed && !!profile?.issuedRewards[0] && <Text style={u.summaryNote}>Your {profile.issuedRewards[0].label.toLowerCase()} reward is applied</Text>}
              {quote.member.memberDiscount > 0 && <Text style={u.summaryNote}>{plan?.discountPercent ?? ''}% member discount · −${quote.member.memberDiscount}</Text>}
            </>}
            <View style={u.summaryRule} />
            <View style={u.rowBetween}><Text style={u.summaryLabel}>Deposit today</Text><Text style={u.summaryBig}>${deposit}</Text></View>
            <Text style={u.summaryNote}>{deposit === 0 ? 'Covered by your membership' : payWithBalance
              ? `$${Math.max(0, total - deposit)} at your detail, after inspection`
              // a demo deposit takes no money, so the whole total is still collected at the job
              : `$${total} at your detail, after inspection (the demo deposit takes no money)`}</Text>
            {savings > 0 && <View style={s.savingBadge}><Text style={s.savingText}>YOU'RE SAVING ${savings} WITH {quote.member!.tier.toUpperCase()}</Text></View>}
          </>}
        </LinearGradient>
        {canUseBalance && <Pressable accessibilityRole="checkbox" accessibilityState={{ checked: useBalance }} onPress={() => setUseBalance(!useBalance)} style={[s.check, useBalance && s.checkOn]}>
          <View style={[s.checkCircle, useBalance && s.checkCircleOn]}><Text style={s.checkMark}>{useBalance ? '✓' : ''}</Text></View>
          <View style={{ flex: 1 }}><Text style={s.checkTitle}>Pay deposit from balance</Text><Text style={s.checkSub}>${profile!.wallet} on your balance</Text></View>
        </Pressable>}
        {deposit > 0 && !payWithBalance && <Text style={u.hint}>Demo deposit: no money is taken yet.</Text>}
        <Text style={[u.hint, s.disclaimer]}>{DISCLAIMER}</Text>
        </>}
      </ScrollView>
      </View>
      <SafeAreaView edges={['bottom']} style={u.footer}>
        <View><Text style={u.footerLabel}>{payWithBalance ? 'FROM BALANCE' : 'DEPOSIT TODAY'}</Text><Text style={u.footerAmount}>{quote ? `$${deposit}` : '—'}</Text>{savings > 0 && <Text style={s.footerSave}>SAVING ${savings}</Text>}</View>
        {step < STEPS.length - 1 ? <Pressable accessibilityRole="button" onPress={next} style={[u.button, s.footerButton]}><Text style={u.buttonText}>NEXT · {STEPS[step + 1]}</Text></Pressable>
        : <Pressable accessibilityRole="button" disabled={busy || !quote} onPress={reserve} style={[u.button, s.footerButton, (busy || !quote) && { opacity: 0.65 }]}>{busy ? <ActivityIndicator color="#fff" /> : <Text style={u.buttonText}>{buttonLabel}</Text>}</Pressable>}
        {!!error && <Text style={[u.error, s.footerError]}>{error}</Text>}
      </SafeAreaView>
    </SafeAreaView>
  );
}

const make = (t: Theme) => StyleSheet.create({
  center: { alignItems: 'center', justifyContent: 'center', padding: 24 }, retry: { marginTop: 16 },
  nextSheet: { marginTop: 12 }, carTitle: { color: t.accent, fontFamily: fonts.heading, fontSize: 14, letterSpacing: 1.2 },
  remove: { paddingHorizontal: 12, paddingVertical: 8, borderRadius: 12, backgroundColor: t.chip }, removeText: { color: t.muted, fontFamily: fonts.heading, fontSize: 11, letterSpacing: 0.8 },
  row: { flexDirection: 'row', gap: 8 }, wrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  twoCol: { flexDirection: 'row', gap: 10 }, yearCol: { width: 96 }, tight: { marginTop: 8 },
  pill: { minHeight: 38, borderRadius: 14, paddingHorizontal: 11, justifyContent: 'center', backgroundColor: t.chip, borderWidth: 1, borderColor: t.chip }, pillOn: { backgroundColor: t.soft, borderColor: t.primary }, pillText: { color: t.text, fontSize: 12 },
  pkg: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 58, borderRadius: 17, paddingHorizontal: 14, paddingVertical: 10, marginBottom: 8, backgroundColor: t.chip, borderWidth: 2, borderColor: 'transparent' }, pkgOn: { backgroundColor: t.soft, borderColor: t.primary },
  pkgName: { color: t.text, fontFamily: fonts.heading, fontSize: 14 }, pkgSub: { color: t.muted, fontSize: 11, marginTop: 2 }, pkgPrice: { color: t.accent, fontFamily: fonts.heading, fontSize: 14 },
  tallChip: { minHeight: 56, paddingVertical: 6 }, chipHint: { color: t.faint, fontSize: 10, marginTop: 2, textAlign: 'center' },
  addCar: { minHeight: 52, borderRadius: 16, borderWidth: 1.5, borderColor: t.primary, borderStyle: 'dashed', alignItems: 'center', justifyContent: 'center', marginTop: 12 }, addCarText: { color: t.accent, fontFamily: fonts.heading, fontSize: 14, letterSpacing: 0.4 },
  notes: { height: 82, textAlignVertical: 'top', paddingTop: 13 }, link: { color: t.accent, fontFamily: fonts.heading, fontSize: 12, letterSpacing: 0.6, marginTop: 3 },
  calendarHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-end', marginTop: 8, marginBottom: 12 }, monthTitle: { color: t.text, fontFamily: fonts.heading, fontSize: 20 },
  weekRow: { flexDirection: 'row', marginBottom: 5 }, weekday: { width: '14.2857%', color: t.faint, textAlign: 'center', fontSize: 10 }, calendarGrid: { flexDirection: 'row', flexWrap: 'wrap' }, dayWrap: { width: '14.2857%', aspectRatio: 1, padding: 2 }, dayTile: { flex: 1, borderRadius: 15, alignItems: 'center', justifyContent: 'center', backgroundColor: t.chip }, daySelected: { backgroundColor: t.primary, borderWidth: 2, borderColor: t.accent }, dayDisabled: { opacity: 0.32 }, dayText: { color: t.text, fontFamily: fonts.heading, fontSize: 15 },
  timeChip: { width: '31.5%', minHeight: 45, backgroundColor: t.chip, borderRadius: 14, alignItems: 'center', justifyContent: 'center' }, timeChipOff: { opacity: 0.45 }, timeText: { color: t.text, fontFamily: fonts.heading, fontSize: 13 }, timeTag: { color: t.accent, fontSize: 8, fontWeight: '700' },
  photoRow: { marginTop: 14 }, thumb: { width: 72, height: 72, borderRadius: 14, backgroundColor: t.chip }, thumbX: { position: 'absolute', top: -6, right: -6, width: 24, height: 24, borderRadius: 12, backgroundColor: t.primary, alignItems: 'center', justifyContent: 'center' }, thumbXText: { color: '#FFFFFF', fontSize: 16, lineHeight: 18 },
  summaryTop: { marginTop: 0 }, summaryRow: { marginTop: 10 }, struck: { textDecorationLine: 'line-through', opacity: 0.7 },
  savingBadge: { alignSelf: 'flex-start', backgroundColor: 'rgba(245,185,66,0.18)', borderRadius: 12, paddingHorizontal: 10, paddingVertical: 6, marginTop: 14 }, savingText: { color: '#F5B942', fontFamily: fonts.heading, fontSize: 12, letterSpacing: 0.6 },
  check: { flexDirection: 'row', gap: 11, alignItems: 'center', minHeight: 64, padding: 12, borderRadius: 17, backgroundColor: t.chip, borderWidth: 1, borderColor: t.chip, marginTop: 14 }, checkOn: { backgroundColor: t.soft, borderColor: t.primary },
  checkCircle: { width: 28, height: 28, borderRadius: 14, borderWidth: 1.5, borderColor: t.faint, alignItems: 'center', justifyContent: 'center' }, checkCircleOn: { backgroundColor: t.primary, borderColor: t.primary }, checkMark: { color: '#FFFFFF', fontWeight: '700' },
  checkTitle: { color: t.text, fontSize: 15, fontWeight: '600' }, checkSub: { color: t.muted, fontSize: 12, marginTop: 2 },
  progress: { flexDirection: 'row', gap: 6, marginBottom: 18 }, progressBar: { flex: 1, height: 4, borderRadius: 2, backgroundColor: t.chip }, progressOn: { backgroundColor: t.primary },
  disclaimer: { marginTop: 14, fontSize: 11, lineHeight: 16 },
  footerButton: { flexShrink: 1, paddingHorizontal: 16 }, footerError: { width: '100%', textAlign: 'center' }, footerSave: { color: '#F5B942', fontFamily: fonts.heading, fontSize: 10, letterSpacing: 0.8 },
});
const styles = { light: make(themes.light), dark: make(themes.dark) };
