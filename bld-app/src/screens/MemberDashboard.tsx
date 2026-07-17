import React, { useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../../App';
import { TIER_COLORS, useMember } from '../state/member';
import { useCatalog } from '../state/catalog';
import { colors, fonts, radius, spacing } from '../theme';

type Props = NativeStackScreenProps<RootStackParamList, 'MemberDashboard'>;

const TIER_LABEL: Record<string, string> = { bronze: 'BRONZE', silver: 'SILVER', gold: 'GOLD' };
const NEXT_TIER: Record<string, string | null> = { bronze: 'silver', silver: 'gold', gold: null };

export default function MemberDashboard({ navigation }: Props) {
  const m = useMember();
  const catalog = useCatalog() as unknown as { plans?: Record<string, { price: number; credits: number; service: string }> };
  const [redeeming, setRedeeming] = useState('');
  if (!m.profile) return null;
  const p = m.profile;
  const tierColor = TIER_COLORS[p.member.tier];
  const plan = catalog.plans?.[p.member.tier];
  const next = NEXT_TIER[p.member.tier];

  const redeem = (key: string, label: string, cost: number) => {
    Alert.alert(`Redeem ${label}?`, `Uses ${cost} stamps. It applies to your next booking automatically.`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Redeem', onPress: async () => {
          setRedeeming(key);
          const err = await m.redeem(key);
          setRedeeming('');
          if (err) Alert.alert('Not yet', err === 'not_enough_stamps' ? 'Not enough stamps yet — keep washing!' : 'Network problem, try again.');
        },
      },
    ]);
  };

  const upgrade = () => {
    Alert.alert('Upgrade?', "We'll text you to set it up — takes one tap on our side.", [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Request upgrade', onPress: () => { m.requestUpgrade(); Alert.alert('Sent ✓', "You'll hear from us today."); } },
    ]);
  };

  return (
    <ScrollView style={{ backgroundColor: colors.bg }} contentContainerStyle={{ padding: spacing(4), paddingBottom: spacing(10) }}>
      {/* Tier card */}
      <View style={[s.card, { borderColor: tierColor }]}>
        <Text style={[s.tier, { color: tierColor }]}>{TIER_LABEL[p.member.tier]} MEMBER</Text>
        <Text style={s.name}>{p.member.name || p.member.email}</Text>
        <View style={s.bigRow}>
          <View style={s.bigCell}>
            <Text style={s.bigNum}>{p.credits}</Text>
            <Text style={s.bigLabel}>washes left</Text>
          </View>
          <View style={s.bigCell}>
            <Text style={[s.bigNum, { color: colors.success }]}>${p.savings}</Text>
            <Text style={s.bigLabel}>saved so far</Text>
          </View>
          <View style={s.bigCell}>
            <Text style={[s.bigNum, { color: tierColor }]}>{p.stamps}</Text>
            <Text style={s.bigLabel}>stamps</Text>
          </View>
        </View>
        {plan && <Text style={s.planLine}>{plan.credits} {plan.service} details / month · ${plan.price}/mo</Text>}
      </View>

      <Pressable accessibilityRole="button" style={s.bookBtn} onPress={() => navigation.navigate('Build')}>
        <Text style={s.bookText}>BOOK A WASH{p.credits > 0 ? ' — USE A CREDIT' : ''}</Text>
      </Pressable>
      {next && (
        <Pressable accessibilityRole="button" style={s.upgradeBtn} onPress={upgrade}>
          <Text style={s.upgradeText}>UPGRADE TO {TIER_LABEL[next]} →</Text>
        </Pressable>
      )}

      {/* Punch card */}
      <Text style={s.section}>Stamps</Text>
      <View style={s.punch}>
        {Array.from({ length: 10 }, (_, i) => (
          <View key={i} style={[s.stamp, i < Math.min(p.stamps, 10) && { backgroundColor: tierColor, borderColor: tierColor }]}>
            <Text style={s.stampText}>{i < Math.min(p.stamps, 10) ? '✓' : ''}</Text>
          </View>
        ))}
      </View>

      <Text style={s.section}>Redeem</Text>
      {p.rewardMenu.map((r) => (
        <Pressable key={r.key} accessibilityRole="button" disabled={p.stamps < r.cost || redeeming === r.key}
          onPress={() => redeem(r.key, r.label, r.cost)}
          style={[s.reward, p.stamps < r.cost && { opacity: 0.45 }]}>
          <Text style={s.rewardLabel}>{r.label}</Text>
          <Text style={[s.rewardCost, { color: tierColor }]}>{r.cost} stamps</Text>
        </Pressable>
      ))}
      {p.issuedRewards.length > 0 && (
        <View style={s.issued}>
          <Text style={{ color: colors.success, fontSize: 14 }}>
            🎁 Ready: {p.issuedRewards.map((r) => r.label).join(', ')} — applies to your next booking.
          </Text>
        </View>
      )}

      <Text style={s.section}>History</Text>
      {p.history.length === 0 && <Text style={{ color: colors.textMuted }}>No washes yet — book your first!</Text>}
      {p.history.map((h) => (
        <View key={h.id} style={s.hist}>
          <Text style={{ color: colors.text }}>{h.day}{h.slot ? ` · ${h.slot}` : ''}</Text>
          <Text style={{ color: h.paidWithCredit ? colors.success : colors.textSecondary }}>
            {h.paidWithCredit ? 'credit' : `$${h.total}`} · {h.status}
          </Text>
        </View>
      ))}

      <Pressable accessibilityRole="button" onPress={() => { m.leave(); navigation.reset({ index: 0, routes: [{ name: 'Home' }] }); }}>
        <Text style={s.leave}>Exit member mode</Text>
      </Pressable>
    </ScrollView>
  );
}

const s = StyleSheet.create({
  card: { backgroundColor: colors.surface, borderWidth: 1.5, borderRadius: radius.card, padding: spacing(5) },
  tier: { fontFamily: fonts.heading, fontSize: 13, letterSpacing: 3 },
  name: { fontFamily: fonts.headingBlack, color: colors.text, fontSize: 24, marginTop: spacing(1) },
  bigRow: { flexDirection: 'row', marginTop: spacing(4) },
  bigCell: { flex: 1, alignItems: 'center' },
  bigNum: { fontFamily: fonts.headingBlack, color: colors.text, fontSize: 32 },
  bigLabel: { color: colors.textMuted, fontSize: 11, textTransform: 'uppercase', letterSpacing: 1, marginTop: 2 },
  planLine: { color: colors.textMuted, fontSize: 13, marginTop: spacing(4), textAlign: 'center' },
  bookBtn: { backgroundColor: colors.primary, borderRadius: radius.button, minHeight: 56, alignItems: 'center', justifyContent: 'center', marginTop: spacing(4) },
  bookText: { fontFamily: fonts.heading, color: colors.text, fontSize: 17, letterSpacing: 1 },
  upgradeBtn: { borderWidth: 1, borderColor: colors.primaryBright, borderRadius: radius.button, minHeight: 48, alignItems: 'center', justifyContent: 'center', marginTop: spacing(2) },
  upgradeText: { fontFamily: fonts.heading, color: colors.primaryBright, fontSize: 14, letterSpacing: 1 },
  section: { color: colors.textMuted, fontSize: 13, textTransform: 'uppercase', letterSpacing: 1, marginTop: spacing(6), marginBottom: spacing(2) },
  punch: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing(2) },
  stamp: { width: 44, height: 44, borderRadius: 22, borderWidth: 1.5, borderColor: colors.border, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.surface },
  stampText: { color: colors.bg, fontSize: 18, fontWeight: '700' },
  reward: { flexDirection: 'row', justifyContent: 'space-between', backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, borderRadius: radius.button, padding: spacing(4), marginBottom: spacing(2) },
  rewardLabel: { color: colors.text, fontSize: 15 },
  rewardCost: { fontFamily: fonts.heading, fontSize: 14 },
  issued: { backgroundColor: 'rgba(50,213,131,0.08)', borderWidth: 1, borderColor: colors.success, borderRadius: radius.button, padding: spacing(3), marginTop: spacing(2) },
  hist: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: spacing(2.5), borderBottomWidth: 1, borderBottomColor: colors.border },
  leave: { color: colors.textMuted, textAlign: 'center', marginTop: spacing(8), fontSize: 13, textDecorationLine: 'underline' },
});
