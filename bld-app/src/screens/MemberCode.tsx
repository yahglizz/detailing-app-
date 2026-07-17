import React, { useState } from 'react';
import { ActivityIndicator, Linking, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../../App';
import { useMember, TIER_COLORS } from '../state/member';
import { useCatalog } from '../state/catalog';
import { colors, fonts, radius, spacing } from '../theme';

const TIERS = ['bronze', 'silver', 'gold'] as const;

type Props = NativeStackScreenProps<RootStackParamList, 'MemberCode'>;

export default function MemberCode({ navigation }: Props) {
  const { enter } = useMember();
  const catalog = useCatalog() as unknown as {
    plans?: Record<string, { price: number; credits: number; service: string }>;
    stripe?: { links?: Record<string, string> };
  };
  const links = catalog.stripe?.links;
  const plans = catalog.plans;
  const [code, setCode] = useState('BLD-');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const join = (t: string) => { const url = links?.[t]; if (url) Linking.openURL(url); };

  const go = async () => {
    setBusy(true); setError('');
    const err = await enter(code);
    setBusy(false);
    if (err === 'invalid_code') return setError("That code doesn't match. Check the letters — no O's or 0's.");
    if (err === 'inactive') return setError('This membership is paused. Text us to reactivate.');
    if (err) return setError('Network problem. Check your signal and try again.');
    navigation.reset({ index: 0, routes: [{ name: 'MemberDashboard' }] });
  };

  return (
    <View style={s.root}>
      <Text style={s.title}>ENTER YOUR{'\n'}MEMBER CODE</Text>
      <Text style={s.hint}>It's on your welcome email — you only do this once.</Text>
      <TextInput
        style={s.input} value={code} onChangeText={(v) => setCode(v.toUpperCase())}
        autoCapitalize="characters" autoCorrect={false} maxLength={10} placeholder="BLD-XXXXXX"
        placeholderTextColor={colors.textMuted}
      />
      <Pressable accessibilityRole="button" style={[s.btn, busy && { opacity: 0.7 }]} onPress={go} disabled={busy}>
        {busy ? <ActivityIndicator color="#fff" /> : <Text style={s.btnText}>UNLOCK MEMBER MODE</Text>}
      </Pressable>
      {!!error && <Text style={s.error}>{error}</Text>}

      {links && TIERS.some((t) => links[t]) && (
        <View style={s.joinWrap}>
          <Text style={s.joinTitle}>NEW TO THE BROTHERHOOD?</Text>
          <Text style={s.joinHint}>Join below — your member code arrives by email right after you pay.</Text>
          {TIERS.map((t) => links[t] ? (
            <Pressable
              key={t} accessibilityRole="button" style={[s.joinBtn, { borderColor: TIER_COLORS[t] }]}
              onPress={() => join(t)}
            >
              <Text style={[s.joinBtnText, { color: TIER_COLORS[t] }]}>
                JOIN {t.toUpperCase()}{plans?.[t] ? ` · $${plans[t].price}/mo` : ''}
              </Text>
            </Pressable>
          ) : null)}
        </View>
      )}
    </View>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg, padding: spacing(6), justifyContent: 'center' },
  title: { fontFamily: fonts.headingBlack, fontSize: 30, color: colors.text, textAlign: 'center', lineHeight: 34 },
  hint: { color: colors.textMuted, textAlign: 'center', marginTop: spacing(3), marginBottom: spacing(6) },
  input: {
    backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, borderRadius: radius.button,
    color: colors.text, padding: spacing(4), fontSize: 24, textAlign: 'center', letterSpacing: 4,
    fontFamily: fonts.heading,
  },
  btn: { backgroundColor: colors.primary, borderRadius: radius.button, minHeight: 52, alignItems: 'center', justifyContent: 'center', marginTop: spacing(4) },
  btnText: { fontFamily: fonts.heading, color: colors.text, fontSize: 16, letterSpacing: 1 },
  error: { color: colors.danger, marginTop: spacing(4), textAlign: 'center' },
  joinWrap: { marginTop: spacing(7), borderTopWidth: 1, borderTopColor: colors.border, paddingTop: spacing(5) },
  joinTitle: { fontFamily: fonts.heading, color: colors.text, fontSize: 14, letterSpacing: 1, textAlign: 'center' },
  joinHint: { color: colors.textMuted, textAlign: 'center', fontSize: 13, marginTop: spacing(2), marginBottom: spacing(4) },
  joinBtn: { borderWidth: 1, borderRadius: radius.button, minHeight: 48, alignItems: 'center', justifyContent: 'center', marginTop: spacing(2) },
  joinBtnText: { fontFamily: fonts.heading, fontSize: 14, letterSpacing: 1 },
});
