import React, { useState } from 'react';
import { ActivityIndicator, Image, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import * as Linking from 'expo-linking';
import * as WebBrowser from 'expo-web-browser';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../../App';
import { topupBonus, type MemberCatalog } from '../../../supabase/functions/_shared/membership';
import { supabase } from '../api';
import { useCatalog } from '../state/catalog';
import { useMember } from '../state/member';
import { useAppearance } from '../state/appearance';
import { brandGradient, fonts, themes, type Theme } from '../theme';
import { ui } from '../ui';

type Props = NativeStackScreenProps<RootStackParamList, 'TopUp'>;
const PRESETS = [25, 50, 100, 200];

// Load prepaid balance through Stripe Checkout. Logged in, it goes on that account
// (plus the member's tier bonus); otherwise on the account for the email typed, and
// the login code to spend it is emailed there.
export default function TopUp({ navigation }: Props) {
  const { profile, code, refresh } = useMember();
  const { mode } = useAppearance();
  const catalog = useCatalog() as unknown as Partial<MemberCatalog>;
  const [preset, setPreset] = useState(50);
  const [other, setOther] = useState('');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState<{ added: number; email: string } | null>(null);

  const t = themes[mode];
  const u = ui[mode];
  const s = styles[mode];
  const loggedIn = !!(profile && code);
  const { min, max } = catalog.topup ?? { min: 10, max: 500 };
  const amount = other ? Number(other) : preset;
  const valid = Number.isInteger(amount) && amount >= min && amount <= max;
  const tier = loggedIn ? profile!.member.tier : null;
  const plan = tier ? catalog.plans?.[tier] : undefined;
  const bonus = valid ? topupBonus(amount, plan) : 0;
  const bestBonus = Math.max(0, ...Object.values(catalog.plans ?? {}).map((p) => p.topupBonusPercent ?? 0));
  const guestEmail = email.trim().toLowerCase();

  const topupError = async (e: unknown) => {
    const ctx = (e as { context?: Response }).context;
    const body = ctx && typeof ctx.json === 'function' ? await ctx.json().catch(() => ({})) : {};
    if (body.error === 'bad_amount') return `Pick an amount from $${body.min ?? min} to $${body.max ?? max}.`;
    if (body.error === 'bad_email') return "That email doesn't look right.";
    if (body.error === 'invalid_code') return 'Your code stopped working — log in again.';
    if (body.error === 'rate_limited') return 'Too many tries. Wait 15 minutes and try again.';
    if (body.error === 'payments_not_configured') return 'Online payments aren’t switched on yet. Call or text us to add money.';
    if (body.error === 'payments_unavailable') return 'Checkout is having a moment. Try again in a minute.';
    return 'Network problem. Check your signal and try again.';
  };

  const pay = async () => {
    if (!valid) { setError(`Pick an amount from $${min} to $${max}.`); return; }
    if (!loggedIn && !name.trim()) { setError('Enter your name.'); return; }
    if (!loggedIn && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(guestEmail)) { setError("That email doesn't look right."); return; }
    setError(''); setBusy(true);
    try {
      // Stripe Checkout sends the customer back into the app here (via checkout-return).
      const returnUrl = Linking.createURL('topup');
      const { data, error: e } = await supabase.functions.invoke('topup', {
        body: loggedIn ? { code, amount, returnUrl } : { name: name.trim(), email: guestEmail, amount, returnUrl },
      });
      if (e) { setError(await topupError(e)); return; }
      await WebBrowser.openAuthSessionAsync(data.checkoutUrl, returnUrl, { preferEphemeralSession: true });
      // Paid, backed out, or closed the sheet — the server asks Stripe which.
      const { data: res, error: se } = await supabase.functions.invoke('topup', {
        body: { action: 'settle', topupId: data.topupId, sessionId: data.sessionId },
      });
      if (se || res?.status === 'processing') { setError('We couldn’t confirm your payment yet. If it went through, your balance updates in a minute and a receipt is on the way.'); return; }
      if (res.status !== 'paid') { setError('Checkout closed — you weren’t charged. Tap below to try again.'); return; }
      if (loggedIn) await refresh();
      setDone({ added: data.amount + data.bonus, email: guestEmail });
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
          <View style={{ alignItems: 'center' }}><Text style={u.topTitle}>ADD MONEY</Text><Text style={u.topSub}>Prepaid balance</Text></View>
          <Image source={require('../../assets/bld-logo.png')} style={u.logo} resizeMode="contain" />
        </View>
        <Text style={u.eyebrow}>YOUR BALANCE</Text>
        <Text style={u.title}>LOAD UP.{'\n'}SPEND LATER.</Text>
        <Text style={u.intro}>Your balance pays first at checkout, before any card.{loggedIn ? ` You have $${profile!.wallet} on it now.` : ''}</Text>

        {done ? (
          <View style={[u.sheet, s.doneSheet]}>
            <Text style={s.doneAmount}>+${done.added}</Text>
            <Text style={u.fieldHeading}>ADDED TO YOUR BALANCE.</Text>
            {loggedIn
              ? <Text style={u.hint}>Your balance is now ${profile!.wallet}. It pays first on your next detail.</Text>
              : <Text style={u.hint}>We emailed your login code to {done.email}. Enter it to see your balance and spend it at checkout.</Text>}
            <Pressable accessibilityRole="button" style={[u.button, s.doneButton]}
              onPress={() => (loggedIn ? navigation.goBack() : navigation.replace('MemberCode'))}>
              <Text style={u.buttonText}>{loggedIn ? 'BACK TO MY ACCOUNT' : 'LOG IN WITH YOUR CODE'}</Text>
            </Pressable>
          </View>
        ) : <>
          <View style={u.sectionHead}><Text style={u.sectionNum}>01</Text><Text style={u.sectionTitle}>HOW MUCH?</Text></View>
          <View style={u.sheet}>
            <View style={s.presets}>
              {PRESETS.map((p) => {
                const on = !other && preset === p;
                return (
                  <Pressable key={p} accessibilityRole="button" accessibilityState={{ selected: on }}
                    onPress={() => { setPreset(p); setOther(''); }} style={[u.chip, on && u.chipOn]}>
                    <Text style={[u.chipText, on && u.chipTextOn]}>${p}</Text>
                  </Pressable>
                );
              })}
            </View>
            <Text style={u.fieldLabel}>OR ANY AMOUNT</Text>
            <TextInput accessibilityLabel="Other amount in dollars" style={u.input} value={other} placeholder={`$${min} – $${max}`}
              placeholderTextColor={t.faint} keyboardType="number-pad" maxLength={4}
              onChangeText={(v) => setOther(v.replace(/\D/g, ''))} />
            <Text style={u.hint}>Whole dollars, ${min} to ${max}.</Text>
          </View>

          {!loggedIn && <>
            <View style={u.sectionHead}><Text style={u.sectionNum}>02</Text><Text style={u.sectionTitle}>WHOSE BALANCE?</Text></View>
            <View style={u.sheet}>
              <TextInput accessibilityLabel="Your name" style={u.input} value={name} onChangeText={setName}
                placeholder="Your name" placeholderTextColor={t.faint} autoComplete="name" maxLength={60} />
              <TextInput accessibilityLabel="Your email" style={u.input} value={email} onChangeText={setEmail}
                placeholder="Email" placeholderTextColor={t.faint} keyboardType="email-address" autoCapitalize="none"
                autoComplete="email" autoCorrect={false} maxLength={254} />
              <Text style={u.hint}>The money goes on the account for this email, and the code to spend it is emailed there. Members: log in first to get your top-up bonus.</Text>
            </View>
          </>}

          <LinearGradient colors={brandGradient} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={u.summary}>
            <Text style={u.summaryOverline}>YOUR TOP-UP</Text>
            <View style={u.rowBetween}><Text style={u.summaryLabel}>You pay</Text><Text style={u.summaryValue}>{valid ? `$${amount}` : '—'}</Text></View>
            {bonus > 0 && <View style={[u.rowBetween, s.summaryGap]}>
              <Text style={u.summaryLabel}>{tier!.toUpperCase()} bonus +{plan!.topupBonusPercent}%</Text><Text style={u.summaryValue}>+${bonus}</Text>
            </View>}
            <View style={u.summaryRule} />
            <View style={u.rowBetween}><Text style={u.summaryLabel}>Added to your balance</Text><Text style={u.summaryBig}>{valid ? `$${amount + bonus}` : '—'}</Text></View>
            {!plan?.topupBonusPercent && bestBonus > 0 && <Text style={u.summaryNote}>Members get up to +{bestBonus}% on every top-up.</Text>}
          </LinearGradient>
          <Text style={u.finePrint}>Paid securely through Stripe.</Text>
        </>}
      </ScrollView>

      {!done && (
        <SafeAreaView edges={['bottom']} style={u.footer}>
          <View><Text style={u.footerLabel}>YOU PAY</Text><Text style={u.footerAmount}>{valid ? `$${amount}` : '—'}</Text></View>
          <Pressable accessibilityRole="button" disabled={busy} onPress={pay} style={[u.button, busy && { opacity: 0.6 }]}>
            {busy ? <ActivityIndicator color="#FFFFFF" /> : <Text style={u.buttonText}>CONTINUE TO PAYMENT</Text>}
          </Pressable>
          {!!error && <Text style={[u.error, s.footerError]}>{error}</Text>}
        </SafeAreaView>
      )}
    </SafeAreaView>
  );
}

const make = (t: Theme) => StyleSheet.create({
  presets: { flexDirection: 'row', gap: 8 },
  summaryGap: { marginTop: 8 },
  doneSheet: { marginTop: 22, alignItems: 'flex-start' },
  doneAmount: { color: t.success, fontFamily: fonts.headingBlack, fontSize: 44, marginBottom: 4 },
  doneButton: { alignSelf: 'stretch', marginTop: 18 },
  footerError: { width: '100%', textAlign: 'center' },
});
const styles = { light: make(themes.light), dark: make(themes.dark) };
