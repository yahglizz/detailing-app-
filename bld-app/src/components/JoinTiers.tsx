import React, { useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { TIERS, VEHICLES, type MemberTier, type VehicleType } from '../../../supabase/functions/_shared/detail_pricing';
import { supabase } from '../api';
import { TIER_COLORS, useMember } from '../state/member';
import { useCatalog } from '../state/catalog';
import { fonts, themes, type Mode, type Theme } from '../theme';
import { ui } from '../ui';

// The Bronze/Silver/Gold plan cards, same numbers as the website (detail config). Joining is by
// hand: "Ask about <plan>" leaves a lead in quote_leads (the dashboard's Leads, same columns the
// website writes) and the owner sets the membership up. Renders nothing until the config loads.
export default function JoinTiers({ mode, num, title, heading, hint }: {
  mode: Mode; num: string; title: string; heading: string; hint: string;
}) {
  const { membership, pricing } = useCatalog();
  const { profile } = useMember();
  const [vehicle, setVehicle] = useState<VehicleType>('sedan');
  const [asking, setAsking] = useState<MemberTier | null>(null);
  const [name, setName] = useState(profile?.member.name ?? '');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState(profile?.member.email ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [sent, setSent] = useState<MemberTier | null>(null);
  if (!membership || !pricing) return null;
  const t = themes[mode];
  const u = ui[mode];
  const s = styles[mode];

  const send = async () => {
    if (!asking) return;
    if (!name.trim() || (!phone.trim() && !email.trim())) { setError('Add your name and a phone or email so we can reach you.'); return; }
    const plan = membership[asking];
    const p = plan.prices[vehicle];
    setBusy(true); setError('');
    const { error: e } = await supabase.from('quote_leads').insert({
      name: name.trim(), phone: phone.trim() || null, email: email.trim().toLowerCase() || null,
      vehicle: pricing.vehicleTypes[vehicle], size: vehicle, service: 'membership', quoted_price: p.price,
      message: `Ask about ${plan.name} (${pricing.vehicleTypes[vehicle]}, $${p.price}/mo) from the app`, accepted: false,
    });
    setBusy(false);
    if (e) { setError('Couldn’t send. Check your signal and try again.'); return; }
    setSent(asking); setAsking(null);
  };

  return <>
    <View style={u.sectionHead}><Text style={u.sectionNum}>{num}</Text><Text style={u.sectionTitle}>{title}</Text></View>
    <View style={u.sheet}>
      <Text style={u.fieldHeading}>{heading}</Text>
      <Text style={[u.hint, s.hintGap]}>{hint}</Text>
      <View style={s.row}>{VEHICLES.map((v) => {
        const on = vehicle === v;
        return <Pressable key={v} accessibilityRole="button" accessibilityState={{ selected: on }} onPress={() => setVehicle(v)} style={[u.chip, on && u.chipOn]}><Text style={[u.chipText, on && u.chipTextOn]}>{pricing.vehicleTypes[v].toUpperCase()}</Text></Pressable>;
      })}</View>
      {TIERS.map((k) => {
        const plan = membership[k];
        const p = plan.prices[vehicle];
        return (
          <View key={k} style={s.tier}>
            <View style={[s.stripe, { backgroundColor: TIER_COLORS[k] }]} />
            <View style={u.rowBetween}>
              <Text style={s.name}>{plan.name.toUpperCase()}</Text>
              <Text style={s.price}>${p.price}<Text style={s.month}> /MO</Text></Text>
            </View>
            <Text style={s.tagline}>{plan.tagline}</Text>
            {p.save > 0 && <Text style={s.save}>Worth ${p.worth} booked one at a time. You save ${p.save} a month.</Text>}
            <Text style={s.label}>EVERY MONTH</Text>
            {plan.includes.map((x) => <Text key={x} style={s.item}>✓  {x}</Text>)}
            <Text style={s.label}>MEMBER PERKS</Text>
            {plan.perks.map((x) => <Text key={x} style={s.item}>✓  {x}</Text>)}
            {sent === k
              ? <Text style={s.thanks}>Thanks! We got your request for {plan.name} and will reach out to set it up.</Text>
              : <Pressable accessibilityRole="button" onPress={() => { setAsking(k); setError(''); }} style={[s.ask, asking === k && s.askOn]}><Text style={s.askText}>ASK ABOUT {plan.name.toUpperCase()}</Text></Pressable>}
            {asking === k && <View style={s.form}>
              <TextInput accessibilityLabel="Your name" style={u.input} value={name} onChangeText={setName} placeholder="Your name" placeholderTextColor={t.faint} keyboardAppearance={mode} autoComplete="name" maxLength={60} />
              <TextInput accessibilityLabel="Phone number" style={u.input} value={phone} onChangeText={setPhone} placeholder="Phone" placeholderTextColor={t.faint} keyboardAppearance={mode} keyboardType="phone-pad" autoComplete="tel" maxLength={30} />
              <TextInput accessibilityLabel="Email" style={u.input} value={email} onChangeText={setEmail} placeholder="Email" placeholderTextColor={t.faint} keyboardAppearance={mode} keyboardType="email-address" autoCapitalize="none" autoCorrect={false} autoComplete="email" maxLength={254} />
              <Pressable accessibilityRole="button" disabled={busy} onPress={send} style={[u.button, busy && { opacity: 0.65 }]}>
                {busy ? <ActivityIndicator color="#FFFFFF" /> : <Text style={u.buttonText}>SEND</Text>}
              </Pressable>
              {!!error && <Text style={u.error}>{error}</Text>}
            </View>}
          </View>
        );
      })}
    </View>
  </>;
}

const make = (t: Theme) => StyleSheet.create({
  hintGap: { marginTop: 4, marginBottom: 14 },
  row: { flexDirection: 'row', gap: 8, marginBottom: 6 },
  tier: { borderRadius: 19, backgroundColor: t.chip, padding: 14, marginTop: 10 },
  stripe: { width: 28, height: 4, borderRadius: 2, marginBottom: 12 },
  name: { color: t.text, fontFamily: fonts.heading, fontSize: 18 },
  price: { color: t.text, fontFamily: fonts.headingBlack, fontSize: 24 },
  month: { fontFamily: fonts.heading, fontSize: 11, letterSpacing: 1 },
  tagline: { color: t.muted, fontSize: 13, marginTop: 4 },
  save: { color: t.accent, fontSize: 12, lineHeight: 17, marginTop: 6 },
  label: { color: t.muted, fontSize: 10, fontWeight: '700', letterSpacing: 1.2, marginTop: 14, marginBottom: 6 },
  item: { color: t.text, fontSize: 13, lineHeight: 19 },
  ask: { minHeight: 46, borderRadius: 14, borderWidth: 1.5, borderColor: t.primary, alignItems: 'center', justifyContent: 'center', marginTop: 14 },
  askOn: { backgroundColor: t.soft },
  askText: { color: t.accent, fontFamily: fonts.heading, fontSize: 13, letterSpacing: 0.4 },
  form: { marginTop: 12 },
  thanks: { color: t.success, fontSize: 13, lineHeight: 18, marginTop: 14 },
});
const styles = { light: make(themes.light), dark: make(themes.dark) };
