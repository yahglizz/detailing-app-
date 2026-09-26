import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Image, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import * as Linking from 'expo-linking';
import * as Location from 'expo-location';
import * as WebBrowser from 'expo-web-browser';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../../App';
import { priceOrder, type Extra, type Quote, type Service, type Size } from '../../../supabase/functions/_shared/pricing';
import { bestPlanFor, memberPrice, type MemberCatalog, type RewardKey } from '../../../supabase/functions/_shared/membership';
import { decideBump } from '../../../supabase/functions/_shared/bump';
import { SIZE_NAMES, splitPayment } from '../../../supabase/functions/_shared/payments/checkout';
import { supabase } from '../api';
import { useCatalog } from '../state/catalog';
import { TIER_COLORS, useMember } from '../state/member';
import TestTierSwitch from '../components/TestTierSwitch';
import { useOrder } from '../state/order';
import { useAppearance } from '../state/appearance';
import { brandGradient, fonts, themes, type Theme } from '../theme';
import { ui } from '../ui';

type Props = NativeStackScreenProps<RootStackParamList, 'Build'>;
const SIZES: { key: Size; label: string }[] = [
  { key: 'sedan', label: 'SEDAN' }, { key: 'suv', label: 'SUV' }, { key: 'truck', label: 'TRUCK / VAN' },
];
const SERVICES: { key: Service; label: string; image: number }[] = [
  { key: 'outside', label: 'OUTSIDE', image: require('../../assets/service-outside.png') },
  { key: 'inside', label: 'INSIDE', image: require('../../assets/service-inside.png') },
  { key: 'full', label: 'FULL DETAIL', image: require('../../assets/service-full.png') },
];
const EXTRAS: { key: Extra; label: string }[] = [
  { key: 'ceramic', label: 'Ceramic coating' }, { key: 'headlight', label: 'Headlight restore' },
  { key: 'engine', label: 'Engine bay' }, { key: 'pet', label: 'Pet hair / odor' },
];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const SLOTS = Array.from({ length: 9 }, (_, i) => {
  const h = 9 + i;
  return { key: `${String(h).padStart(2, '0')}:00`, label: `${h > 12 ? h - 12 : h}:00 ${h >= 12 ? 'PM' : 'AM'}` };
});
const toISO = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const addDays = (date: Date, count: number) => { const d = new Date(date); d.setDate(d.getDate() + count); return toISO(d); };
const monthCells = (year: number, month: number) => {
  const cells: (number | null)[] = Array(new Date(year, month, 1).getDay()).fill(null);
  for (let d = 1; d <= new Date(year, month + 1, 0).getDate(); d++) cells.push(d);
  while (cells.length % 7) cells.push(null);
  return cells;
};
const normalizeEmail = (raw: string) => raw.trim().toLowerCase();
const looksLikeEmail = (raw: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizeEmail(raw));

export default function Build({ navigation }: Props) {
  const { state, dispatch } = useOrder();
  const catalog = useCatalog();
  const { profile, code, refresh } = useMember();
  const { mode } = useAppearance();
  const t = themes[mode];
  const u = ui[mode];
  const s = styles[mode];
  const today = useMemo(() => new Date(), []);
  const todayISO = toISO(today);
  const memberCatalog = catalog as unknown as MemberCatalog & { stripe?: { links?: Record<string, string> } };
  const tier = profile?.member.tier ?? null; // null = a guest, or a balance account that isn't a member
  const plan = tier ? memberCatalog.plans?.[tier] : undefined;
  const pct = plan?.discountPercent ?? 0;
  const maxISO = addDays(today, plan ? 30 : 7);
  const [view, setView] = useState({ year: today.getFullYear(), month: today.getMonth() });
  const [slotStates, setSlotStates] = useState<Map<string, { rank: number; anchored: boolean }>>(new Map());
  const [loadingSlots, setLoadingSlots] = useState(false);
  const [serverQuote, setServerQuote] = useState<Quote | null>(null);
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const myRank = plan?.rank ?? 0;
  const quote = serverQuote ?? priceOrder(state.items, catalog);
  // Same pricing as `book`: member price (credits, reward, tier % off), anchor, then the
  // prepaid balance, then the card.
  const issuedReward = plan ? profile!.issuedRewards[0] : undefined;
  const priced = plan ? memberPrice(quote, plan, profile!.credits, (issuedReward?.reward as RewardKey) ?? null) : null;
  const creditsUsed = priced?.creditsUsed ?? 0;
  const savings = priced?.savings ?? 0;
  let payable = priced ? priced.payable : quote.total;
  const anchorPrice = memberCatalog.anchorPrice;
  const anchorAvailable = typeof anchorPrice === 'number';
  if (!plan && state.anchor && anchorAvailable) payable += anchorPrice;
  const { walletUsed, rest, deposit, due, atDetail } = splitPayment(payable, profile?.wallet ?? 0, quote.depositPercent, state.payMode);
  // Non-members: the tier that makes this order cheapest, shown when it beats today's price.
  const best = !plan && memberCatalog.plans ? bestPlanFor(quote, memberCatalog.plans) : null;
  const upsell = best && best.payable < payable ? best : null;
  const joinLink = upsell ? memberCatalog.stripe?.links?.[upsell.tier] : undefined;
  const memberOff = (retail: number) => retail - Math.round((retail * pct) / 100);
  const savedCars = profile?.member.cars ?? [];
  const cells = useMemo(() => monthCells(view.year, view.month), [view]);
  const atCurrentMonth = view.year === today.getFullYear() && view.month === today.getMonth();
  const selectedHolder = state.timeSlot ? slotStates.get(state.timeSlot) ?? null : null;
  const selectedDecision = decideBump(myRank, selectedHolder);

  useEffect(() => { setServerQuote(null); }, [state.items, catalog]);
  useEffect(() => {
    if (!state.preferredDay) return;
    let alive = true;
    setLoadingSlots(true);
    setSlotStates(new Map());
    supabase.rpc('slot_states', { day: state.preferredDay }).then(
      ({ data }) => {
        if (!alive) return;
        const map = new Map<string, { rank: number; anchored: boolean }>();
        for (const r of (data ?? []) as { slot: string; rank: number; anchored: boolean }[]) map.set(r.slot, { rank: r.rank, anchored: r.anchored });
        setSlotStates(map); setLoadingSlots(false);
      },
      () => { if (alive) { setSlotStates(new Map()); setLoadingSlots(false); } },
    );
    return () => { alive = false; };
  }, [state.preferredDay]);

  const set = (field: 'address' | 'preferredDay' | 'timeSlot' | 'window' | 'notes' | 'name' | 'remainderMethod' | 'payMode') => (value: string) =>
    dispatch({ type: 'SET_FIELD', field, value });

  // Members: fill in what Settings knows (name, address, first saved car) once per visit.
  const prefilled = useRef(false);
  useEffect(() => {
    if (!profile || prefilled.current) return;
    prefilled.current = true;
    if (!state.name.trim()) set('name')(profile.member.name ?? '');
    if (!state.address.trim() && profile.member.address) set('address')(profile.member.address);
    const first = profile.member.cars?.[0];
    const [car, ...more] = state.items;
    const untouched = !more.length && !car.label && car.size === 'sedan' && car.service === 'full' && !car.extras.length;
    if (first && untouched) dispatch({ type: 'SET_CAR', index: 0, label: first.name, size: first.size });
  }, [profile]);
  const pickDay = (iso: string) => { set('preferredDay')(iso); set('timeSlot')(''); };
  const pickSlot = (key: string) => { set('timeSlot')(key); set('window')(Number(key.slice(0, 2)) < 12 ? 'morning' : 'afternoon'); };
  const changeMonth = (delta: number) => setView(({ year, month }) => {
    const d = new Date(year, month + delta, 1);
    return { year: d.getFullYear(), month: d.getMonth() };
  });
  const useMyLocation = async () => {
    try {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== 'granted') return;
      const pos = await Location.getCurrentPositionAsync({});
      const [a] = await Location.reverseGeocodeAsync(pos.coords);
      if (a) set('address')(`${a.streetNumber ?? ''} ${a.street ?? ''}, ${a.city ?? ''} ${a.postalCode ?? ''}`.trim());
    } catch { Alert.alert('Location unavailable', 'Please type the service address instead.'); }
  };
  const validate = () => {
    if (!state.address.trim()) return 'Enter the address where your car will be.';
    if (!state.preferredDay) return 'Choose a day on the calendar.';
    if (!state.timeSlot) return 'Choose an available time.';
    if (!state.name.trim()) return 'Enter your name.';
    if (!profile && !looksLikeEmail(email)) return "That email doesn't look right.";
    return '';
  };
  const bookError = async (e: unknown) => {
    const ctx = (e as { context?: Response }).context;
    const body = ctx && typeof ctx.json === 'function' ? await ctx.json().catch(() => ({})) : {};
    if (body.error === 'price_changed' && body.quote) { setServerQuote(body.quote); return `Prices were updated — new total is $${body.quote.total}. Tap again to accept.`; }
    if (body.error === 'slot_taken') { set('timeSlot')(''); return 'That time just got booked. Pick another slot below.'; }
    if (body.error === 'too_far_out') return 'Pick a closer day — members can book 30 days out, everyone else 7.';
    if (body.error === 'invalid_code') return 'Your code stopped working — log in again.';
    if (body.error === 'rate_limited') return 'Too many tries. Wait 15 minutes and try again.';
    if (body.error === 'bad_email') return "That email doesn't look right.";
    if (body.error === 'credit_conflict' || body.error === 'reward_conflict' || body.error === 'balance_conflict') { await refresh(); return 'Your balance just changed. Check the new total and tap again.'; }
    if (body.error === 'payments_not_configured') return 'Online payments aren’t switched on yet. Call or text us to book.';
    if (body.error === 'payments_unavailable') return 'Checkout is having a moment. Try again in a minute.';
    return body.error ?? 'Network problem. Check your signal and try again.';
  };
  const pay = async () => {
    const issue = validate();
    if (issue) { setError(issue); return; }
    setError(''); setBusy(true);
    try {
      // Stripe Checkout sends the customer back into the app here (via checkout-return).
      const returnUrl = Linking.createURL('checkout');
      const { data, error: e } = await supabase.functions.invoke('book', {
        body: {
          items: state.items, address: state.address, preferredDay: state.preferredDay,
          timeSlot: state.timeSlot, window: state.window, notes: state.notes,
          remainderMethod: state.remainderMethod, name: state.name,
          email: profile ? undefined : normalizeEmail(email), expectedTotal: quote.total,
          memberCode: code ?? undefined, anchor: state.anchor, payMode: state.payMode, returnUrl,
        },
      });
      if (e) { setError(await bookError(e)); return; }
      let escalated = !!data.escalated;
      if (data.checkoutUrl) {
        await WebBrowser.openAuthSessionAsync(data.checkoutUrl, returnUrl, { preferEphemeralSession: true });
        // Paid, backed out, or closed the sheet — the server asks Stripe which.
        const { data: done, error: se } = await supabase.functions.invoke('book', {
          body: { action: 'settle', bookingId: data.bookingId, sessionId: data.sessionId },
        });
        if (se || done?.status === 'processing') { setError('We couldn’t confirm your payment yet. If it went through, your confirmation email is on the way.'); return; }
        if (done.status !== 'paid') { setError('Checkout closed — you weren’t charged. Tap below to try again.'); return; }
        escalated = !!done.escalated;
      }
      if (profile) await refresh();
      navigation.reset({ index: 0, routes: [{ name: 'Booked', params: {
        bookingId: data.bookingId, escalated, paid: due > 0 ? state.payMode : walletUsed > 0 ? 'balance' : 'credit',
        stamps: plan ? state.items.length * (plan.stampsPerCar ?? 1) : 0, saved: savings,
      } }] });
    } finally {
      setBusy(false);
    }
  };

  return (
    <SafeAreaView style={u.root} edges={['top', 'left', 'right']}>
      <StatusBar style={t.statusBar} />
      <LinearGradient colors={t.bg} style={StyleSheet.absoluteFill} />
      <ScrollView contentContainerStyle={u.content} keyboardShouldPersistTaps="handled">
        <View style={u.topbar}>
          <Pressable accessibilityRole="button" accessibilityLabel="Back" onPress={() => navigation.goBack()} style={u.topButton}><Text style={u.topButtonText}>‹</Text></Pressable>
          <View style={{ alignItems: 'center' }}><Text style={u.topTitle}>BOOK YOUR DETAIL</Text><Text style={u.topSub}>Everything in one place</Text></View>
          <Image source={require('../../assets/bld-logo.png')} style={u.logo} resizeMode="contain" />
        </View>
        <Text style={u.eyebrow}>THE BROTHERLY LOVE EXPERIENCE</Text>
        <Text style={u.title}>A FRESH START{'\n'}FOR YOUR RIDE.</Text>
        <Text style={u.intro}>Choose your clean, pick your time, and check out below.</Text>
        <TestTierSwitch mode={mode} />

        <View style={u.sectionHead}><Text style={u.sectionNum}>01</Text><Text style={u.sectionTitle}>YOUR RIDE</Text></View>
        <View style={u.sheet}>
          <View style={u.rowBetween}><Text style={u.fieldHeading}>HOW MANY CARS?</Text><View style={s.stepper}>
            <Pressable accessibilityRole="button" accessibilityLabel="Remove car" onPress={() => dispatch({ type: 'SET_CAR_COUNT', count: state.items.length - 1 })} style={s.stepButton}><Text style={s.stepText}>−</Text></Pressable>
            <Text style={s.stepCount}>{state.items.length}</Text>
            <Pressable accessibilityRole="button" accessibilityLabel="Add car" onPress={() => dispatch({ type: 'SET_CAR_COUNT', count: state.items.length + 1 })} style={s.stepButton}><Text style={s.stepText}>+</Text></Pressable>
          </View></View>
          {state.items.map((car, i) => <View key={i} style={s.carBlock}>
            <Text style={s.carTitle}>CAR {String(i + 1).padStart(2, '0')}{car.label ? ` · ${car.label.toUpperCase()}` : ''}</Text>
            {!!savedCars.length && <>
              <Text style={u.fieldLabel}>YOUR CARS</Text>
              <View style={s.extrasWrap}>{savedCars.map((saved, j) => {
                const selected = car.label === saved.name && car.size === saved.size;
                return <Pressable key={j} accessibilityRole="button" accessibilityState={{ selected }} onPress={() => dispatch({ type: 'SET_CAR', index: i, label: saved.name, size: saved.size })} style={[s.extraChip, selected && s.extraChipOn]}><Text style={s.extraText}>{selected ? '✓ ' : ''}{saved.name} · {SIZE_NAMES[saved.size]}</Text></Pressable>;
              })}</View>
            </>}
            <Text style={u.fieldLabel}>VEHICLE SIZE</Text>
            <View style={s.choiceRow}>{SIZES.map((size) => <Pressable key={size.key} accessibilityRole="button" accessibilityState={{ selected: car.size === size.key }} onPress={() => dispatch({ type: 'SET_SIZE', index: i, size: size.key })} style={[u.chip, car.size === size.key && u.chipOn]}><Text style={[u.chipText, car.size === size.key && u.chipTextOn]}>{size.label}</Text></Pressable>)}</View>
            <Text style={u.fieldLabel}>CHOOSE YOUR CLEAN{tier && plan ? ` · ${tier.toUpperCase()} PRICES` : ''}</Text>
            <View style={s.serviceRow}>{SERVICES.map((service) => {
              const selected = car.service === service.key;
              const retail = Math.round(catalog.services[service.key] * catalog.sizeMultipliers[car.size]);
              // A credit covers it: the plan's service, with credits left after the cars above.
              const included = !!plan && plan.service === service.key
                && state.items.slice(0, i).filter((c) => c.service === plan.service).length < profile!.credits;
              return <Pressable key={service.key} accessibilityRole="button" accessibilityState={{ selected }} onPress={() => dispatch({ type: 'SET_SERVICE', index: i, service: service.key })} style={[s.serviceTile, selected && s.serviceTileOn]}>
                <Image source={service.image} style={s.serviceImage} resizeMode="contain" />
                <Text style={s.serviceName}>{service.label}</Text>
                {included ? <Text style={s.memberPrice}>INCLUDED</Text> : <Text style={pct ? s.memberPrice : s.servicePrice}>${memberOff(retail)}</Text>}
                {(included || pct > 0) && <Text style={s.wasPrice}>${retail}</Text>}
              </Pressable>;
            })}</View>
            <Text style={u.fieldLabel}>MAKE IT EXTRA</Text>
            <View style={s.extrasWrap}>{EXTRAS.map((extra) => {
              const selected = car.extras.includes(extra.key);
              return <Pressable key={extra.key} accessibilityRole="checkbox" accessibilityState={{ checked: selected }} onPress={() => dispatch({ type: 'TOGGLE_EXTRA', index: i, extra: extra.key })} style={[s.extraChip, selected && s.extraChipOn]}><Text style={s.extraText}>{selected ? '✓ ' : '+ '}{extra.label} · ${memberOff(catalog.extras[extra.key])}{pct > 0 && <Text style={s.wasInline}> ${catalog.extras[extra.key]}</Text>}</Text></Pressable>;
            })}</View>
          </View>)}
        </View>

        <View style={u.sectionHead}><Text style={u.sectionNum}>02</Text><Text style={u.sectionTitle}>WHEN & WHERE</Text></View>
        <View style={u.sheet}>
          <Text style={u.fieldHeading}>WHERE SHOULD WE MEET YOU?</Text>
          <TextInput accessibilityLabel="Service address" style={u.input} placeholder="Street address" placeholderTextColor={t.faint} keyboardAppearance={mode} value={state.address} onChangeText={set('address')} />
          <Pressable accessibilityRole="button" onPress={useMyLocation}><Text style={s.locationLink}>USE MY LOCATION</Text></Pressable>
          <View style={s.calendarHead}>
            <View><Text style={u.fieldLabel}>PICK A DAY</Text><Text style={s.monthTitle}>{MONTHS[view.month].toUpperCase()} {view.year}</Text></View>
            <View style={s.monthNav}>
              <Pressable accessibilityRole="button" accessibilityLabel="Previous month" disabled={atCurrentMonth} onPress={() => changeMonth(-1)} style={[s.monthButton, atCurrentMonth && { opacity: 0.35 }]}><Text style={s.monthArrow}>‹</Text></Pressable>
              <Pressable accessibilityRole="button" accessibilityLabel="Next month" onPress={() => changeMonth(1)} style={s.monthButton}><Text style={s.monthArrow}>›</Text></Pressable>
            </View>
          </View>
          <View style={s.weekRow}>{WEEKDAYS.map((day) => <Text key={day} style={s.weekday}>{day}</Text>)}</View>
          <View style={s.calendarGrid}>{cells.map((day, index) => {
            if (day === null) return <View key={index} style={s.dayWrap} />;
            const iso = `${view.year}-${String(view.month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
            const disabled = iso <= todayISO || iso > maxISO;
            const selected = state.preferredDay === iso;
            return <View key={index} style={s.dayWrap}><Pressable accessibilityRole="button" accessibilityLabel={`${MONTHS[view.month]} ${day}`} accessibilityState={{ selected, disabled }} disabled={disabled} onPress={() => pickDay(iso)} style={[s.dayTile, selected && s.daySelected, disabled && s.dayDisabled]}><Text style={[s.dayText, selected && u.chipTextOn]}>{day}</Text></Pressable></View>;
          })}</View>
          <Text style={u.fieldLabel}>PICK A TIME {loadingSlots ? '· CHECKING TIMES' : ''}</Text>
          {!state.preferredDay ? <Text style={u.hint}>Choose a day to see available times.</Text> : <View style={s.timeWrap}>{SLOTS.map((slot) => {
            const holder = slotStates.get(slot.key) ?? null;
            const decision = decideBump(myRank, holder);
            const selectable = !loadingSlots && (decision === 'open' || decision === 'bump' || decision === 'escalate');
            const selected = state.timeSlot === slot.key;
            return <Pressable key={slot.key} accessibilityRole="button" accessibilityState={{ selected, disabled: !selectable }} disabled={!selectable} onPress={() => pickSlot(slot.key)} style={[s.timeChip, selected && u.chipOn, !selectable && s.timeChipOff]}><Text style={[s.timeText, selected && u.chipTextOn]}>{slot.label}</Text>{holder && <Text style={[s.timeTag, selected && u.chipTextOn]}>{holder.anchored ? 'LOCKED' : selectable ? 'VIP' : 'TAKEN'}</Text>}</Pressable>;
          })}</View>}
          {selectedHolder && selectedDecision === 'bump' && <Text style={u.hint}>VIP perk: this booking moves the current appointment to the next open time.</Text>}
          {selectedHolder && selectedDecision === 'escalate' && <Text style={u.hint}>Another member of your tier holds this time. We’ll confirm the exact slot by email.</Text>}
          <Text style={u.fieldLabel}>ANYTHING ELSE?</Text>
          <TextInput accessibilityLabel="Booking notes" style={[u.input, s.notes]} multiline placeholder="Gate code, which car, or a quick note" placeholderTextColor={t.faint} keyboardAppearance={mode} value={state.notes} onChangeText={set('notes')} />
        </View>

        <View style={u.sectionHead}><Text style={u.sectionNum}>03</Text><Text style={u.sectionTitle}>CHECK OUT</Text></View>
        <View style={u.sheet}>
          <Text style={u.fieldHeading}>ALMOST THERE.</Text>
          <Text style={u.fieldLabel}>YOUR NAME</Text>
          <TextInput accessibilityLabel="Your name" style={u.input} placeholder="First name" placeholderTextColor={t.faint} keyboardAppearance={mode} value={state.name} onChangeText={set('name')} />
          <Text style={u.fieldLabel}>EMAIL FOR BOOKING UPDATES</Text>
          {profile
            ? <TextInput accessibilityLabel="Email address" style={[u.input, { color: t.muted }]} value={profile.member.email} editable={false} />
            : <TextInput accessibilityLabel="Email address" style={u.input} placeholder="you@email.com" placeholderTextColor={t.faint} keyboardAppearance={mode} keyboardType="email-address" autoCapitalize="none" autoCorrect={false} autoComplete="email" value={email} onChangeText={setEmail} />}
          {rest > 0 && <>
            <Text style={u.fieldLabel}>HOW DO YOU WANT TO PAY?</Text>
            <View style={s.choiceRow}>{([['deposit', `DEPOSIT $${deposit}`], ['full', `IN FULL $${rest}`]] as const).map(([key, label]) => <Pressable key={key} accessibilityRole="button" accessibilityState={{ selected: state.payMode === key }} onPress={() => set('payMode')(key)} style={[u.chip, state.payMode === key && u.chipOn]}><Text style={[u.chipText, state.payMode === key && u.chipTextOn]}>{label}</Text></Pressable>)}</View>
          </>}
          {atDetail > 0 && <>
            <Text style={u.fieldLabel}>PAY THE REST AT YOUR DETAIL</Text>
            <View style={s.choiceRow}>{(['cash', 'card'] as const).map((method) => <Pressable key={method} accessibilityRole="button" accessibilityState={{ selected: state.remainderMethod === method }} onPress={() => set('remainderMethod')(method)} style={[u.chip, state.remainderMethod === method && u.chipOn]}><Text style={[u.chipText, state.remainderMethod === method && u.chipTextOn]}>{method.toUpperCase()}</Text></Pressable>)}</View>
          </>}
          {!plan && anchorAvailable && <Pressable accessibilityRole="checkbox" accessibilityState={{ checked: state.anchor }} onPress={() => dispatch({ type: 'SET_ANCHOR', anchor: !state.anchor })} style={[s.anchor, state.anchor && s.anchorOn]}><View style={[s.checkCircle, state.anchor && s.checkCircleOn]}><Text style={s.checkMark}>{state.anchor ? '✓' : ''}</Text></View><View style={{ flex: 1 }}><Text style={s.anchorTitle}>LOCK IN YOUR TIME</Text><Text style={s.anchorSub}>Slot Anchor · bump-proof · +${anchorPrice}</Text></View></Pressable>}
          <Text style={[u.hint, s.payHint]}>{rest > 0 ? 'You’ll pay on Stripe’s secure checkout page — we never see your card.' : walletUsed > 0 ? 'Paid from your balance — nothing to pay today.' : 'Covered by your membership — nothing to pay today.'}</Text>
        </View>

        <LinearGradient colors={brandGradient} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={u.summary}>
          <Text style={u.summaryOverline}>YOUR DETAIL AT A GLANCE</Text>
          <View style={u.rowBetween}><Text style={u.summaryLabel}>{savings > 0 ? 'Regular price' : 'Detail total'}</Text><Text style={[u.summaryValue, savings > 0 && s.struck]}>${quote.total}</Text></View>
          {savings > 0 && <View style={[u.rowBetween, s.summaryRow]}><Text style={u.summaryLabel}>Your {tier!.toUpperCase()} price</Text><Text style={u.summaryValue}>${payable}</Text></View>}
          {!!creditsUsed && <Text style={u.summaryNote}>{creditsUsed} membership wash credit{creditsUsed > 1 ? 's' : ''} applied</Text>}
          {!!priced?.rewardUsed && <Text style={u.summaryNote}>Your {issuedReward!.label.toLowerCase()} reward is applied</Text>}
          {!!priced?.memberDiscount && <Text style={u.summaryNote}>{pct}% member discount · −${priced.memberDiscount}</Text>}
          {walletUsed > 0 && <View style={[u.rowBetween, s.summaryRow]}><Text style={u.summaryLabel}>From your balance</Text><Text style={u.summaryValue}>−${walletUsed}</Text></View>}
          <View style={u.summaryRule} />
          <View style={u.rowBetween}><Text style={u.summaryLabel}>Due today</Text><Text style={u.summaryBig}>${due}</Text></View>
          <Text style={u.summaryNote}>{atDetail > 0 ? `$${atDetail} at your detail · ${state.remainderMethod}` : rest > 0 ? 'Paid in full — nothing due at your detail' : walletUsed > 0 ? 'Covered by your balance' : 'Covered by your membership'}</Text>
          {savings > 0 && <View style={s.savingBadge}><Text style={s.savingText}>YOU'RE SAVING ${savings} WITH {tier!.toUpperCase()}</Text></View>}
        </LinearGradient>
        {upsell && <Pressable accessibilityRole={joinLink ? 'link' : undefined} disabled={!joinLink} onPress={() => joinLink && Linking.openURL(joinLink)} style={s.upsell}>
          <View style={[s.upsellStripe, { backgroundColor: TIER_COLORS[upsell.tier] }]} />
          <View style={{ flex: 1 }}>
            <Text style={s.upsellTitle}>{upsell.tier.toUpperCase()} MEMBERS PAY ${upsell.payable} FOR THIS</Text>
            <Text style={s.upsellSub}>You'd save ${payable - upsell.payable} on this detail · {joinLink ? 'Join for ' : ''}${upsell.price}/mo</Text>
          </View>
          {!!joinLink && <Text style={s.upsellArrow}>›</Text>}
        </Pressable>}
        <Text style={u.finePrint}>Your request is sent after checkout. We’ll email the exact time.</Text>
      </ScrollView>
      <SafeAreaView edges={['bottom']} style={u.footer}>
        <View><Text style={u.footerLabel}>DUE TODAY</Text><Text style={u.footerAmount}>${due}</Text>{savings > 0 && <Text style={s.footerSave}>SAVING ${savings}</Text>}</View>
        <Pressable accessibilityRole="button" disabled={busy} onPress={pay} style={[u.button, busy && { opacity: 0.65 }]}>{busy ? <ActivityIndicator color="#fff" /> : <Text style={u.buttonText}>{due > 0 ? 'CONTINUE TO PAYMENT' : walletUsed > 0 ? 'PAY WITH BALANCE' : creditsUsed ? 'BOOK WITH CREDIT' : 'CONFIRM BOOKING'}</Text>}</Pressable>
        {!!error && <Text style={[u.error, s.footerError]}>{error}</Text>}
      </SafeAreaView>
    </SafeAreaView>
  );
}

const make = (t: Theme) => StyleSheet.create({
  stepper: { flexDirection: 'row', alignItems: 'center', gap: 10 }, stepButton: { width: 37, height: 37, borderRadius: 14, backgroundColor: t.chip, alignItems: 'center', justifyContent: 'center' }, stepText: { color: t.text, fontSize: 22, lineHeight: 24 }, stepCount: { color: t.text, fontFamily: fonts.heading, fontSize: 20 }, carBlock: { marginTop: 20, borderTopWidth: 1, borderTopColor: t.line, paddingTop: 18 }, carTitle: { color: t.accent, fontFamily: fonts.heading, fontSize: 14, letterSpacing: 1.2 },
  choiceRow: { flexDirection: 'row', gap: 8 },
  serviceRow: { flexDirection: 'row', gap: 8 }, serviceTile: { flex: 1, minHeight: 126, borderRadius: 19, padding: 8, alignItems: 'center', backgroundColor: t.chip, borderWidth: 2, borderColor: 'transparent' }, serviceTileOn: { backgroundColor: t.soft, borderColor: t.primary }, serviceImage: { width: 67, height: 67 }, serviceName: { color: t.text, fontFamily: fonts.heading, fontSize: 12, textAlign: 'center' }, servicePrice: { color: t.muted, fontSize: 11, marginTop: 1 }, extrasWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 }, extraChip: { minHeight: 38, borderRadius: 14, paddingHorizontal: 11, justifyContent: 'center', backgroundColor: t.chip, borderWidth: 1, borderColor: t.chip }, extraChipOn: { backgroundColor: t.soft, borderColor: t.primary }, extraText: { color: t.text, fontSize: 12 },
  notes: { height: 82, textAlignVertical: 'top', paddingTop: 13 }, locationLink: { color: t.accent, fontFamily: fonts.heading, fontSize: 12, letterSpacing: 0.6, marginTop: 3 },
  calendarHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-end', marginTop: 18, marginBottom: 12 }, monthTitle: { color: t.text, fontFamily: fonts.heading, fontSize: 20 }, monthNav: { flexDirection: 'row', gap: 7 }, monthButton: { width: 32, height: 32, borderRadius: 12, backgroundColor: t.chip, alignItems: 'center', justifyContent: 'center' }, monthArrow: { color: t.text, fontSize: 25, lineHeight: 27 }, weekRow: { flexDirection: 'row', marginBottom: 5 }, weekday: { width: '14.2857%', color: t.faint, textAlign: 'center', fontSize: 10 }, calendarGrid: { flexDirection: 'row', flexWrap: 'wrap' }, dayWrap: { width: '14.2857%', aspectRatio: 1, padding: 2 }, dayTile: { flex: 1, borderRadius: 15, alignItems: 'center', justifyContent: 'center', backgroundColor: t.chip }, daySelected: { backgroundColor: t.primary, borderWidth: 2, borderColor: t.accent }, dayDisabled: { opacity: 0.32 }, dayText: { color: t.text, fontFamily: fonts.heading, fontSize: 15 },
  timeWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 7 }, timeChip: { width: '31.5%', minHeight: 45, backgroundColor: t.chip, borderRadius: 14, alignItems: 'center', justifyContent: 'center' }, timeChipOff: { opacity: 0.45 }, timeText: { color: t.text, fontFamily: fonts.heading, fontSize: 13 }, timeTag: { color: t.accent, fontSize: 8, fontWeight: '700' }, payHint: { marginTop: 14 },
  anchor: { flexDirection: 'row', gap: 11, alignItems: 'center', minHeight: 68, padding: 12, borderRadius: 17, backgroundColor: t.chip, borderWidth: 1, borderColor: t.chip, marginTop: 20 }, anchorOn: { backgroundColor: t.soft, borderColor: t.primary }, checkCircle: { width: 28, height: 28, borderRadius: 14, borderWidth: 1.5, borderColor: t.faint, alignItems: 'center', justifyContent: 'center' }, checkCircleOn: { backgroundColor: t.primary, borderColor: t.primary }, checkMark: { color: '#FFFFFF', fontWeight: '700' }, anchorTitle: { color: t.text, fontFamily: fonts.heading, fontSize: 14 }, anchorSub: { color: t.muted, fontSize: 12, marginTop: 2 },
  footerError: { width: '100%', textAlign: 'center' },
  memberPrice: { color: t.accent, fontFamily: fonts.heading, fontSize: 11, marginTop: 1 }, wasPrice: { color: t.faint, fontSize: 10, textDecorationLine: 'line-through' }, wasInline: { color: t.faint, textDecorationLine: 'line-through' },
  struck: { textDecorationLine: 'line-through', opacity: 0.7 }, summaryRow: { marginTop: 8 },
  savingBadge: { alignSelf: 'flex-start', backgroundColor: 'rgba(245,185,66,0.18)', borderRadius: 12, paddingHorizontal: 10, paddingVertical: 6, marginTop: 14 }, savingText: { color: '#F5B942', fontFamily: fonts.heading, fontSize: 12, letterSpacing: 0.6 },
  upsell: { flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: t.sheet, borderWidth: 1, borderColor: t.sheetBorder, borderRadius: 20, padding: 14, marginTop: 12 }, upsellStripe: { width: 5, alignSelf: 'stretch', borderRadius: 3 }, upsellTitle: { color: t.text, fontFamily: fonts.heading, fontSize: 13, letterSpacing: 0.3 }, upsellSub: { color: t.muted, fontSize: 12, marginTop: 3 }, upsellArrow: { color: t.muted, fontSize: 26, lineHeight: 28 },
  footerSave: { color: '#F5B942', fontFamily: fonts.heading, fontSize: 10, letterSpacing: 0.8 },
});
const styles = { light: make(themes.light), dark: make(themes.dark) };
