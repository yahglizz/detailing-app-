import React, { useState } from 'react';
import { ActivityIndicator, Alert, Pressable, StyleSheet, Text, View } from 'react-native';
import { useMember } from '../state/member';
import { fonts, themes, type Mode, type Theme } from '../theme';
import { ui } from '../ui';

const VIEWS = [['none', 'NON-MEMBER'], ['bronze', 'BRONZE'], ['silver', 'SILVER'], ['gold', 'GOLD']] as const;

// Owner test accounts only: flip the account between every membership view and add
// play money, to review each screen. The server refuses both for real accounts.
export default function TestTierSwitch({ mode }: { mode: Mode }) {
  const m = useMember();
  const [busy, setBusy] = useState('');
  if (!m.profile?.isTest) return null;
  const t = themes[mode];
  const u = ui[mode];
  const s = styles[mode];
  const current = m.profile.member.tier ?? 'none';
  const run = async (key: string, action: () => Promise<string | null>) => {
    setBusy(key);
    const err = await action();
    setBusy('');
    if (err) Alert.alert('Test switch failed', err === 'network' ? 'Check your signal and try again.' : err);
  };

  return (
    <View style={s.box}>
      <Text style={s.label}>TEST ACCOUNT · SWITCH VIEW</Text>
      <View style={s.row}>
        {VIEWS.map(([key, label]) => {
          const on = current === key;
          return (
            <Pressable key={key} accessibilityRole="button" accessibilityState={{ selected: on }} disabled={!!busy}
              onPress={() => !on && run(key, () => m.testTier(key))} style={[u.chip, s.chip, on && u.chipOn]}>
              {busy === key ? <ActivityIndicator color={t.text} /> : <Text style={[u.chipText, s.chipText, on && u.chipTextOn]}>{label}</Text>}
            </Pressable>
          );
        })}
      </View>
      <Pressable accessibilityRole="button" disabled={!!busy} onPress={() => run('cash', m.testBalance)} style={s.cash}>
        {busy === 'cash' ? <ActivityIndicator color={t.text} /> : <Text style={s.cashText}>+$50 TEST BALANCE</Text>}
      </Pressable>
    </View>
  );
}

const make = (t: Theme) => StyleSheet.create({
  box: { borderWidth: 1.5, borderStyle: 'dashed', borderColor: t.accent, borderRadius: 20, padding: 12, marginTop: 16 },
  label: { color: t.accent, fontSize: 10, fontWeight: '700', letterSpacing: 1.2, marginBottom: 9 },
  row: { flexDirection: 'row', gap: 6 },
  chip: { minHeight: 38, borderRadius: 12 },
  chipText: { fontSize: 11 },
  cash: { minHeight: 38, borderRadius: 12, backgroundColor: t.chip, alignItems: 'center', justifyContent: 'center', marginTop: 8 },
  cashText: { color: t.text, fontFamily: fonts.heading, fontSize: 12, letterSpacing: 0.4 },
});
const styles = { light: make(themes.light), dark: make(themes.dark) };
