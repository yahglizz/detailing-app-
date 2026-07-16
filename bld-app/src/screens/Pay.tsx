import React, { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
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

export default function Pay({ navigation }: Props) {
  const { state, dispatch } = useOrder();
  const catalog = useCatalog();
  const [quote, setQuote] = useState<Quote>(() => priceOrder(state.items, catalog));
  const [phase, setPhase] = useState<'email' | 'code' | 'card'>('email');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [cardNumber, setCardNumber] = useState('');
  const [exp, setExp] = useState('');
  const [cvc, setCvc] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [cooldown, setCooldown] = useState(0);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => { if (data.session) setPhase('card'); });
    return () => { if (timer.current) clearInterval(timer.current); };
  }, []);

  const startCooldown = () => {
    setCooldown(60);
    timer.current = setInterval(() => setCooldown((c) => {
      if (c <= 1 && timer.current) clearInterval(timer.current);
      return Math.max(0, c - 1);
    }), 1000);
  };

  const sendCode = async () => {
    if (!looksLikeEmail(email)) return setError("That email doesn't look right.");
    setError(''); setBusy(true);
    const { error: e } = await supabase.auth.signInWithOtp({ email: normalizeEmail(email) });
    setBusy(false);
    if (e) return setError(e.message);
    setPhase('code'); startCooldown();
  };

  const verify = async () => {
    setError(''); setBusy(true);
    const { error: e } = await supabase.auth.verifyOtp({ email: normalizeEmail(email), token: code, type: 'email' });
    setBusy(false);
    if (e) return setError('Wrong code — check your inbox and try again.');
    setPhase('card');
  };

  const pay = async () => {
    setError(''); setBusy(true);
    const [mm, yy] = exp.split('/');
    const { data, error: e } = await supabase.functions.invoke('book', {
      body: {
        items: state.items, address: state.address, preferredDay: state.preferredDay,
        window: state.window, notes: state.notes, remainderMethod: state.remainderMethod,
        name: state.name, expectedTotal: quote.total,
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
        if (body.error === 'card_declined') return setError('Card declined. Try another card.');
        return setError(body.error ?? 'Something went wrong. Try again.');
      }
      return setError('Network problem. Check your signal and try again.');
    }
    navigation.reset({ index: 0, routes: [{ name: 'Booked', params: { bookingId: data.bookingId } }] });
  };

  return (
    <ScrollView style={{ backgroundColor: colors.bg }} contentContainerStyle={{ padding: spacing(4) }}>
      <View style={s.summary}>
        <Text style={s.total}>${quote.total}</Text>
        <Text style={s.line}>${quote.deposit} deposit due now (card)</Text>
        <Text style={s.line}>${quote.remainder} at the detail</Text>
        <Text style={s.label}>Pay the rest with</Text>
        <Seg options={['cash', 'card'] as const} labels={{ cash: 'Cash at the job', card: 'Card at the job' }}
          value={state.remainderMethod}
          onChange={(v) => dispatch({ type: 'SET_FIELD', field: 'remainderMethod', value: v })} />
      </View>

      {phase === 'email' && (
        <View>
          <Text style={s.label}>Your name</Text>
          <TextInput style={s.input} placeholder="First name" placeholderTextColor={colors.textMuted}
            value={state.name} onChangeText={(v) => dispatch({ type: 'SET_FIELD', field: 'name', value: v })} />
          <Text style={s.label}>Email (we send your booking updates here)</Text>
          <TextInput style={s.input} placeholder="you@email.com" placeholderTextColor={colors.textMuted}
            keyboardType="email-address" autoCapitalize="none" autoCorrect={false} autoComplete="email"
            value={email} onChangeText={setEmail} />
          <Pressable accessibilityRole="button" style={s.btn} onPress={sendCode} disabled={busy}>
            {busy ? <ActivityIndicator color="#fff" /> : <Text style={s.btnText}>EMAIL ME A CODE</Text>}
          </Pressable>
        </View>
      )}

      {phase === 'code' && (
        <View>
          <Text style={s.label}>Enter the 6-digit code we emailed</Text>
          <TextInput style={[s.input, s.code]} keyboardType="number-pad" maxLength={6} value={code} onChangeText={setCode} />
          <Pressable accessibilityRole="button" style={s.btn} onPress={verify} disabled={busy || code.length !== 6}>
            {busy ? <ActivityIndicator color="#fff" /> : <Text style={s.btnText}>VERIFY</Text>}
          </Pressable>
          <Pressable accessibilityRole="button" onPress={sendCode} disabled={cooldown > 0}>
            <Text style={s.resend}>{cooldown > 0 ? `Resend in ${cooldown}s` : 'Resend code'}</Text>
          </Pressable>
        </View>
      )}

      {phase === 'card' && (
        <View>
          <Text style={s.label}>Card for the ${quote.deposit} deposit</Text>
          <TextInput style={s.input} placeholder="Card number" placeholderTextColor={colors.textMuted}
            keyboardType="number-pad" value={cardNumber} onChangeText={setCardNumber} />
          <View style={{ flexDirection: 'row', gap: spacing(2) }}>
            <TextInput style={[s.input, { flex: 1 }]} placeholder="MM/YY" placeholderTextColor={colors.textMuted}
              value={exp} onChangeText={setExp} />
            <TextInput style={[s.input, { flex: 1 }]} placeholder="CVC" placeholderTextColor={colors.textMuted}
              keyboardType="number-pad" maxLength={4} value={cvc} onChangeText={setCvc} />
          </View>
          <Pressable accessibilityRole="button" style={s.btn} onPress={pay} disabled={busy}>
            {busy ? <ActivityIndicator color="#fff" /> : <Text style={s.btnText}>PAY ${quote.deposit} DEPOSIT</Text>}
          </Pressable>
        </View>
      )}

      {!!error && <Text style={s.error}>{error}</Text>}
    </ScrollView>
  );
}

const s = StyleSheet.create({
  summary: { backgroundColor: colors.surface, borderRadius: radius.card, borderWidth: 1, borderColor: colors.border, padding: spacing(4), marginBottom: spacing(4) },
  total: { fontFamily: fonts.headingBlack, fontSize: 36, color: colors.primaryBright },
  line: { color: colors.textSecondary, fontSize: 15, marginTop: spacing(1) },
  label: { color: colors.textMuted, fontSize: 13, textTransform: 'uppercase', letterSpacing: 1, marginTop: spacing(4), marginBottom: spacing(2) },
  input: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, borderRadius: radius.button, color: colors.text, padding: spacing(3.5), fontSize: 16, marginBottom: spacing(2) },
  code: { textAlign: 'center', fontSize: 24, letterSpacing: 8 },
  btn: { backgroundColor: colors.primary, borderRadius: radius.button, minHeight: 52, alignItems: 'center', justifyContent: 'center', marginTop: spacing(2) },
  btnText: { fontFamily: fonts.heading, color: colors.text, fontSize: 16, letterSpacing: 1 },
  resend: { color: colors.primaryBright, textAlign: 'center', marginTop: spacing(4), fontSize: 14 },
  error: { color: colors.danger, marginTop: spacing(4), fontSize: 14, textAlign: 'center' },
});
