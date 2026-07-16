import React, { useState } from 'react';
import { ActivityIndicator, Alert, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../../App';
import { priceOrder, type Quote } from '../../../supabase/functions/_shared/pricing';
import Seg from '../components/Seg';
import { supabase } from '../api';
import { useCatalog } from '../state/catalog';
import { useOrder } from '../state/order';
import { colors, fonts, radius, spacing } from '../theme';

type Props = NativeStackScreenProps<RootStackParamList, 'Pay'>;

const normalizeEmail = (raw: string) => raw.trim().toLowerCase();
const looksLikeEmail = (raw: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizeEmail(raw));

// "4242424242424242" -> "4242 4242 4242 4242"
const formatCardNumber = (raw: string) =>
  raw.replace(/\D/g, '').slice(0, 19).replace(/(.{4})/g, '$1 ').trim();

// "1226" -> "12/26"
const formatExp = (raw: string) => {
  const d = raw.replace(/\D/g, '').slice(0, 4);
  return d.length > 2 ? `${d.slice(0, 2)}/${d.slice(2)}` : d;
};

const prettySlot = (key: string) => {
  if (!key) return '';
  const h = Number(key.slice(0, 2));
  const ampm = h >= 12 ? 'PM' : 'AM';
  const h12 = h > 12 ? h - 12 : h === 0 ? 12 : h;
  return `${h12}:${key.slice(3)} ${ampm}`;
};

export default function Pay({ navigation }: Props) {
  const { state, dispatch } = useOrder();
  const catalog = useCatalog();
  const [quote, setQuote] = useState<Quote>(() => priceOrder(state.items, catalog));
  const [email, setEmail] = useState('');
  const [cardNumber, setCardNumber] = useState('');
  const [exp, setExp] = useState('');
  const [cvc, setCvc] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const validate = () => {
    if (!state.name.trim()) return 'Enter your name.';
    if (!looksLikeEmail(email)) return "That email doesn't look right.";
    if (cardNumber.replace(/\s/g, '').length < 13) return 'Enter your full card number.';
    if (!/^\d{2}\/\d{2}$/.test(exp)) return 'Expiry looks off — use MM/YY.';
    if (cvc.length < 3) return 'Enter the security code on the back of the card.';
    return '';
  };

  const pay = async () => {
    const v = validate();
    if (v) return setError(v);
    setError(''); setBusy(true);
    const [mm, yy] = exp.split('/');
    const { data, error: e } = await supabase.functions.invoke('book', {
      body: {
        items: state.items, address: state.address, preferredDay: state.preferredDay,
        timeSlot: state.timeSlot, window: state.window, notes: state.notes,
        remainderMethod: state.remainderMethod, name: state.name,
        email: normalizeEmail(email), expectedTotal: quote.total,
        card: { number: cardNumber.replace(/\s/g, ''), expMonth: Number(mm), expYear: 2000 + Number(yy), cvc },
      },
    });
    setBusy(false);
    if (e) {
      const ctx = (e as { context?: Response }).context;
      if (ctx) {
        const body = await ctx.json().catch(() => ({}));
        if (body.error === 'price_changed' && body.quote) {
          setQuote(body.quote);
          return setError(`Prices were updated — new total is $${body.quote.total}. Tap Pay again to accept.`);
        }
        if (body.error === 'slot_taken') return setError('That time just got booked. Go back and pick another slot.');
        if (body.error === 'card_declined') return setError('Card declined. Try another card.');
        return setError(body.error ?? 'Something went wrong. Try again.');
      }
      return setError('Network problem. Check your signal and try again.');
    }
    navigation.reset({ index: 0, routes: [{ name: 'Booked', params: { bookingId: data.bookingId } }] });
  };

  const applePay = () => {
    // Real Apple Pay needs a native payment sheet (e.g. @stripe/stripe-react-native
    // PlatformPay) in a dev build — Expo Go can't present it. Button is wired and
    // ready; swap this alert for the sheet when the payment provider goes live.
    Alert.alert(
      'Apple Pay',
      Platform.OS === 'ios'
        ? 'Apple Pay will be enabled when card processing goes live. Use the card form below for now.'
        : 'Apple Pay is only available on iPhone.',
    );
  };

  return (
    <ScrollView style={{ backgroundColor: colors.bg }} contentContainerStyle={{ padding: spacing(4), paddingBottom: spacing(10) }}>
      <View style={s.summary}>
        <Text style={s.total}>${quote.total}</Text>
        <Text style={s.line}>${quote.deposit} deposit due now (card)</Text>
        <Text style={s.line}>${quote.remainder} at the detail</Text>
        {!!state.preferredDay && (
          <Text style={s.when}>{state.preferredDay}{state.timeSlot ? ` · ${prettySlot(state.timeSlot)}` : ''}</Text>
        )}
        <Text style={s.label}>Pay the rest with</Text>
        <Seg options={['cash', 'card'] as const} labels={{ cash: 'Cash at the job', card: 'Card at the job' }}
          value={state.remainderMethod}
          onChange={(v) => dispatch({ type: 'SET_FIELD', field: 'remainderMethod', value: v })} />
      </View>

      <Pressable accessibilityRole="button" style={s.applePay} onPress={applePay}>
        <Text style={s.applePayText}> Pay</Text>
      </Pressable>

      <View style={s.dividerRow}>
        <View style={s.dividerLine} />
        <Text style={s.dividerText}>or pay with card</Text>
        <View style={s.dividerLine} />
      </View>

      <Text style={s.label}>Your name</Text>
      <TextInput style={s.input} placeholder="First name" placeholderTextColor={colors.textMuted}
        value={state.name} onChangeText={(v) => dispatch({ type: 'SET_FIELD', field: 'name', value: v })} />

      <Text style={s.label}>Email (we send your booking updates here)</Text>
      <TextInput style={s.input} placeholder="you@email.com" placeholderTextColor={colors.textMuted}
        keyboardType="email-address" autoCapitalize="none" autoCorrect={false} autoComplete="email"
        value={email} onChangeText={setEmail} />

      <Text style={s.label}>Card for the ${quote.deposit} deposit</Text>
      <TextInput style={s.input} placeholder="Card number" placeholderTextColor={colors.textMuted}
        keyboardType="number-pad" autoComplete="cc-number" value={cardNumber}
        onChangeText={(v) => setCardNumber(formatCardNumber(v))} />
      <View style={{ flexDirection: 'row', gap: spacing(2) }}>
        <TextInput style={[s.input, { flex: 1 }]} placeholder="MM/YY" placeholderTextColor={colors.textMuted}
          keyboardType="number-pad" maxLength={5} value={exp}
          onChangeText={(v) => setExp(formatExp(v))} />
        <TextInput style={[s.input, { flex: 1 }]} placeholder="CVC" placeholderTextColor={colors.textMuted}
          keyboardType="number-pad" maxLength={4} secureTextEntry value={cvc} onChangeText={setCvc} />
      </View>

      <Pressable accessibilityRole="button" style={[s.btn, busy && { opacity: 0.7 }]} onPress={pay} disabled={busy}>
        {busy ? <ActivityIndicator color="#fff" /> : <Text style={s.btnText}>PAY ${quote.deposit} DEPOSIT</Text>}
      </Pressable>

      {!!error && <Text style={s.error}>{error}</Text>}
    </ScrollView>
  );
}

const s = StyleSheet.create({
  summary: { backgroundColor: colors.surface, borderRadius: radius.card, borderWidth: 1, borderColor: colors.border, padding: spacing(4), marginBottom: spacing(4) },
  total: { fontFamily: fonts.headingBlack, fontSize: 36, color: colors.primaryBright },
  line: { color: colors.textSecondary, fontSize: 15, marginTop: spacing(1) },
  when: { color: colors.primaryBright, fontSize: 14, marginTop: spacing(2) },
  label: { color: colors.textMuted, fontSize: 13, textTransform: 'uppercase', letterSpacing: 1, marginTop: spacing(4), marginBottom: spacing(2) },
  input: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, borderRadius: radius.button, color: colors.text, padding: spacing(3.5), fontSize: 16, marginBottom: spacing(2) },
  applePay: { backgroundColor: '#000', borderWidth: 1, borderColor: '#2a2a2e', borderRadius: radius.button, minHeight: 52, alignItems: 'center', justifyContent: 'center' },
  applePayText: { color: '#fff', fontSize: 19, fontWeight: '600' },
  dividerRow: { flexDirection: 'row', alignItems: 'center', gap: spacing(3), marginTop: spacing(4) },
  dividerLine: { flex: 1, height: 1, backgroundColor: colors.border },
  dividerText: { color: colors.textMuted, fontSize: 12, textTransform: 'uppercase', letterSpacing: 1 },
  btn: { backgroundColor: colors.primary, borderRadius: radius.button, minHeight: 52, alignItems: 'center', justifyContent: 'center', marginTop: spacing(3) },
  btnText: { fontFamily: fonts.heading, color: colors.text, fontSize: 16, letterSpacing: 1 },
  error: { color: colors.danger, marginTop: spacing(4), fontSize: 14, textAlign: 'center' },
});
