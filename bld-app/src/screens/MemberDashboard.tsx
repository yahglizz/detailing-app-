import React, { useState } from 'react';
import { Alert, ImageBackground, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../../App';
import type { MemberCatalog, Tier } from '../../../supabase/functions/_shared/membership';
import { TIER_COLORS, useMember } from '../state/member';
import { useCatalog } from '../state/catalog';
import { useAppearance } from '../state/appearance';
import JoinTiers, { joinLinks } from '../components/JoinTiers';
import TestTierSwitch from '../components/TestTierSwitch';
import { brandGradient, fonts, themes, type Theme } from '../theme';
import { ui } from '../ui';

type Props = NativeStackScreenProps<RootStackParamList, 'MemberDashboard'>;
const NEXT: Record<Tier, Tier | null> = { bronze: 'silver', silver: 'gold', gold: null };
const PRIORITY: Record<Tier, string> = {
  bronze: 'Priority over eligible guest slots',
  silver: 'Priority over eligible guest and Bronze slots',
  gold: 'Highest priority on eligible slots',
};
const INTRO: Record<string, string> = {
  outside: 'A fresh exterior, on your schedule.',
  inside: 'A clean cabin changes everything.',
  full: 'The whole car. The full treatment.',
};

// The account screen for anyone with a code. Everyone sees their prepaid balance;
// members also see their washes, rewards and plan, and everyone else sees what
// joining gets them. One screen, so a test account's tier switch just re-renders it.
export default function MemberDashboard({ navigation }: Props) {
  const m = useMember();
  const { mode, toggle } = useAppearance();
  const catalog = useCatalog() as unknown as Partial<MemberCatalog>;
  const [redeeming, setRedeeming] = useState('');
  const p = m.profile;
  if (!p) return null;

  const t = themes[mode];
  const u = ui[mode];
  const s = styles[mode];
  const tier = p.member.tier;
  const plan = tier ? catalog.plans?.[tier] : undefined;
  const tone = tier ? TIER_COLORS[tier] : t.accent;
  const name = p.member.name?.split(' ')[0] || 'friend';
  const freeCost = p.rewardMenu.find((r) => r.key === 'freeWash')?.cost ?? 10;
  const next = tier ? NEXT[tier] : null;
  const nextPlan = next ? catalog.plans?.[next] : undefined;
  const washes = p.credits === 1 ? 'WASH LEFT' : 'WASHES LEFT';
  const perCar = plan?.stampsPerCar ?? 1;
  let section = 0;
  const num = () => String(++section).padStart(2, '0');

  const book = () => navigation.navigate('Build');
  const redeem = (key: string, label: string, cost: number) => {
    Alert.alert(`Redeem ${label}?`, `Uses ${cost} stamps. It applies to your next booking automatically.`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Redeem', onPress: async () => {
        setRedeeming(key);
        const err = await m.redeem(key);
        setRedeeming('');
        if (err) Alert.alert('Not yet', err === 'not_enough_stamps' ? 'Not enough stamps yet — keep washing!' : 'Network problem, try again.');
      } },
    ]);
  };
  const upgrade = () => {
    Alert.alert('Request an upgrade?', 'We’ll reach out to set it up.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Request upgrade', onPress: async () => {
        await m.requestUpgrade();
        Alert.alert('Request sent', 'We’ll be in touch soon.');
      } },
    ]);
  };

  return (
    <SafeAreaView style={u.root} edges={['top', 'left', 'right']}>
      <StatusBar style={t.statusBar} />
      <LinearGradient colors={t.bg} style={StyleSheet.absoluteFill} />
      <ScrollView contentContainerStyle={u.content}>
        <View style={u.topbar}>
          <View style={s.side}>
            <Pressable accessibilityRole="button" accessibilityLabel={mode === 'light' ? 'Switch to dark mode' : 'Switch to light mode'} onPress={toggle} style={u.topButton}>
              <Text style={s.modeIcon}>{mode === 'light' ? '☾' : '☼'}</Text>
            </Pressable>
          </View>
          <View style={s.center}><Text style={u.topTitle}>{tier ? 'THE BROTHERHOOD' : 'YOUR ACCOUNT'}</Text><Text style={u.topSub} numberOfLines={1}>Welcome back, {name}</Text></View>
          <View style={[s.side, { alignItems: 'flex-end' }]}>
            <Pressable accessibilityRole="button" onPress={() => navigation.navigate('MemberSettings')} style={[u.topButton, s.settings]}><Text style={s.settingsText}>SETTINGS</Text></Pressable>
          </View>
        </View>
        <Text style={u.eyebrow}>{tier ? `${tier.toUpperCase()} MEMBERSHIP` : 'YOUR BALANCE'}</Text>
        <Text style={u.title}>{tier ? 'YOUR CLEAN,\nON REPEAT.' : 'READY WHEN\nYOU ARE.'}</Text>
        <Text style={u.intro}>{tier ? INTRO[plan?.service ?? ''] ?? 'Clean cars, on your schedule.' : 'Your balance pays first at checkout. Members get their own price on every detail.'}</Text>
        <TestTierSwitch mode={mode} />

        {tier && <>
          <View style={u.sectionHead}><Text style={u.sectionNum}>{num()}</Text><Text style={u.sectionTitle}>YOUR WASHES</Text></View>
          <View style={u.sheet}>
            <ImageBackground source={require('../../assets/member-car.png')} style={s.hero} imageStyle={s.heroImage}>
              <LinearGradient colors={['rgba(12,9,17,0.96)', 'rgba(12,9,17,0.5)', 'rgba(12,9,17,0.08)']} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} style={StyleSheet.absoluteFill} />
              <Text style={[s.heroOverline, { color: tone }]}>{tier.toUpperCase()} MEMBER</Text>
              <Text style={s.heroNumber}>{p.credits}</Text>
              <Text style={s.heroLabel}>{washes}</Text>
              {plan && <Text style={s.heroHint}>+{plan.credits} every month</Text>}
            </ImageBackground>
            <View style={s.statRow}>
              <View style={s.stat}><Text style={s.statLabel}>SAVED SO FAR</Text><Text style={s.statNumber}>${p.savings}</Text><Text style={s.statHint}>Since joining</Text></View>
              <View style={s.stat}><Text style={s.statLabel}>YOUR STAMPS</Text><Text style={s.statNumber}>{p.stamps}</Text><Text style={s.statHint}>{perCar} per car detailed</Text></View>
            </View>
          </View>
        </>}

        <View style={u.sectionHead}><Text style={u.sectionNum}>{num()}</Text><Text style={u.sectionTitle}>YOUR BALANCE</Text></View>
        <View style={u.sheet}>
          <View style={u.rowBetween}>
            <View>
              <Text style={s.statLabel}>READY TO SPEND</Text>
              <Text style={s.balance}>${p.wallet}</Text>
            </View>
            <Pressable accessibilityRole="button" onPress={() => navigation.navigate('TopUp')} style={u.button}><Text style={u.buttonText}>ADD MONEY</Text></Pressable>
          </View>
          <Text style={u.hint}>{plan?.topupBonusPercent
            ? `As a ${tier!.toUpperCase()} member you get +${plan.topupBonusPercent}% on every top-up. Your balance pays first at checkout.`
            : 'Your balance pays first at checkout. Members get a bonus on every top-up.'}</Text>
        </View>

        {tier ? <>
          <View style={u.sectionHead}><Text style={u.sectionNum}>{num()}</Text><Text style={u.sectionTitle}>YOUR REWARDS</Text></View>
          <View style={u.sheet}>
            <Text style={u.fieldHeading}>GOOD THINGS ADD UP.</Text>
            <Text style={u.hint}>Earn {perCar === 1 ? 'a stamp' : `${perCar} stamps`} for every car we detail. Redeem them for more care.</Text>
            <View style={s.stamps}>
              {Array.from({ length: 10 }, (_, i) => (
                <View key={i} style={s.stampCell}>
                  <View style={[s.stamp, i < p.stamps && { backgroundColor: tone, borderColor: tone }]}>
                    <Text style={[s.stampText, i < p.stamps && { color: '#161119' }]}>{i + 1}</Text>
                  </View>
                </View>
              ))}
            </View>
            <Text style={u.hint}>{Math.min(p.stamps, freeCost)} of {freeCost} stamps toward a free wash</Text>
            <Text style={u.fieldLabel}>THE REWARD MENU</Text>
            {p.rewardMenu.map((r) => {
              const short = p.stamps < r.cost;
              return (
                <Pressable key={r.key} accessibilityRole="button" disabled={short || redeeming === r.key}
                  onPress={() => redeem(r.key, r.label, r.cost)} style={[s.reward, short && { opacity: 0.5 }]}>
                  <View style={[s.rewardToken, { borderColor: tone }]}><Text style={s.rewardTokenText}>{r.cost}</Text></View>
                  <View style={{ flex: 1 }}>
                    <Text style={s.rewardName}>{r.label}</Text>
                    <Text style={s.rewardSub}>{short ? `${r.cost - p.stamps} more stamps` : 'Tap to redeem'}</Text>
                  </View>
                  <Text style={s.chevron}>›</Text>
                </Pressable>
              );
            })}
            {p.issuedRewards.length > 0 && <Text style={s.issued}>Ready for your next booking: {p.issuedRewards.map((r) => r.label).join(', ')}</Text>}
          </View>

          <View style={u.sectionHead}><Text style={u.sectionNum}>{num()}</Text><Text style={u.sectionTitle}>YOUR PLAN</Text></View>
          <LinearGradient colors={brandGradient} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={[u.summary, s.planCard]}>
            <Text style={u.summaryOverline}>{tier.toUpperCase()} MEMBER</Text>
            {plan && <View style={u.rowBetween}>
              <Text style={s.planTitle}>{plan.service.toUpperCase()} DETAIL</Text>
              <Text style={u.summaryBig}>${plan.price}<Text style={s.planMonth}> /MO</Text></Text>
            </View>}
            <View style={u.summaryRule} />
            {plan && <Text style={s.perk}>✓  {plan.credits} {plan.service} details every month</Text>}
            {!!plan?.discountPercent && <Text style={s.perk}>✓  {plan.discountPercent}% off everything else</Text>}
            {!!plan?.topupBonusPercent && <Text style={s.perk}>✓  +{plan.topupBonusPercent}% on every balance top-up</Text>}
            <Text style={s.perk}>✓  {perCar === 1 ? 'A reward stamp' : `${perCar} reward stamps`} for every car we detail</Text>
            <Text style={s.perk}>✓  Book up to 30 days ahead</Text>
            <Text style={s.perk}>✓  {PRIORITY[tier]}</Text>
          </LinearGradient>
          {next ? <>
            {nextPlan && <Text style={s.nextPerks}>{next.toUpperCase()}: {[
              nextPlan.discountPercent ? `${nextPlan.discountPercent}% off` : '',
              nextPlan.topupBonusPercent ? `+${nextPlan.topupBonusPercent}% top-ups` : '',
              nextPlan.stampsPerCar ? `${nextPlan.stampsPerCar} stamps per car` : '',
            ].filter(Boolean).join(' · ') || `${nextPlan.credits} ${nextPlan.service} details a month`}</Text>}
            <Pressable accessibilityRole="button" onPress={upgrade} style={s.upgrade}><Text style={s.upgradeText}>REQUEST {next.toUpperCase()} UPGRADE</Text></Pressable>
          </> : <Text style={s.topTier}>YOU'RE AT THE TOP OF THE BROTHERHOOD</Text>}
        </> : joinLinks(catalog) && (
          <JoinTiers mode={mode} num={num()} title="JOIN THE BROTHERHOOD" heading="YOUR OWN PRICE ON EVERY DETAIL."
            hint="Details every month, a member price on everything else, and bonus money on every top-up. The higher the tier, the better it gets." />
        )}

        <View style={u.sectionHead}><Text style={u.sectionNum}>{num()}</Text><Text style={u.sectionTitle}>RECENT DETAILS</Text></View>
        <View style={u.sheet}>
          {!p.history.length && <Text style={s.empty}>Your first detail will show up here.</Text>}
          {p.history.map((h, i) => (
            <View key={h.id} style={[s.history, i > 0 && s.historyRule]}>
              <Text style={s.historyDay}>{h.day}{h.slot ? ` · ${h.slot}` : ''}</Text>
              <Text style={s.historyMeta}>{h.status} · {h.paidWithCredit ? 'credit' : `$${h.total}`}</Text>
            </View>
          ))}
        </View>
        {tier && <Text style={u.finePrint}>Unused washes roll over to next month.</Text>}
      </ScrollView>

      <SafeAreaView edges={['bottom']} style={u.footer}>
        {tier
          ? <View><Text style={u.footerLabel}>{washes}</Text><Text style={u.footerAmount}>{p.credits}</Text></View>
          : <View><Text style={u.footerLabel}>BALANCE</Text><Text style={u.footerAmount}>${p.wallet}</Text></View>}
        <Pressable accessibilityRole="button" onPress={book} style={u.button}><Text style={u.buttonText}>{tier ? 'BOOK YOUR WASH' : 'BOOK A DETAIL'}</Text></Pressable>
      </SafeAreaView>
    </SafeAreaView>
  );
}

const make = (t: Theme) => StyleSheet.create({
  side: { width: 84 },
  center: { flex: 1, alignItems: 'center' },
  modeIcon: { color: t.text, fontSize: 19 },
  settings: { width: 'auto', paddingHorizontal: 12 },
  settingsText: { color: t.text, fontFamily: fonts.heading, fontSize: 11, letterSpacing: 1 },
  hero: { height: 190, borderRadius: 20, overflow: 'hidden', backgroundColor: '#100D15', padding: 18 },
  heroImage: { borderRadius: 20 },
  heroOverline: { fontFamily: fonts.heading, fontSize: 12, letterSpacing: 1.5 },
  heroNumber: { color: '#FFFFFF', fontFamily: fonts.headingBlack, fontSize: 64, lineHeight: 66, marginTop: 8 },
  heroLabel: { color: '#E9E4EC', fontFamily: fonts.heading, fontSize: 14, letterSpacing: 1.2 },
  heroHint: { color: '#BEB4C2', fontSize: 12, marginTop: 3 },
  statRow: { flexDirection: 'row', gap: 8, marginTop: 10 },
  stat: { flex: 1, backgroundColor: t.chip, borderRadius: 19, padding: 14 },
  statLabel: { color: t.muted, fontSize: 10, fontWeight: '700', letterSpacing: 1.2 },
  statNumber: { color: t.text, fontFamily: fonts.headingBlack, fontSize: 28, marginTop: 6 },
  statHint: { color: t.faint, fontSize: 11 },
  balance: { color: t.text, fontFamily: fonts.headingBlack, fontSize: 40, marginTop: 4 },
  stamps: { flexDirection: 'row', flexWrap: 'wrap', rowGap: 12, marginTop: 16 },
  stampCell: { width: '20%', alignItems: 'center' },
  stamp: { width: 50, height: 50, borderRadius: 25, borderWidth: 1.5, borderColor: t.line, alignItems: 'center', justifyContent: 'center' },
  stampText: { color: t.faint, fontFamily: fonts.heading, fontSize: 15 },
  reward: { flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: t.chip, borderRadius: 17, padding: 12, marginBottom: 8 },
  rewardToken: { width: 42, height: 42, borderWidth: 1.5, borderRadius: 21, alignItems: 'center', justifyContent: 'center' },
  rewardTokenText: { color: t.text, fontFamily: fonts.heading, fontSize: 17 },
  rewardName: { color: t.text, fontSize: 15, fontWeight: '600' },
  rewardSub: { color: t.faint, fontSize: 12, marginTop: 2 },
  chevron: { color: t.muted, fontSize: 26, lineHeight: 28 },
  issued: { color: t.success, fontSize: 13, marginTop: 6 },
  planCard: { marginTop: 0 },
  planTitle: { color: '#FFFFFF', fontFamily: fonts.headingBlack, fontSize: 22 },
  planMonth: { fontFamily: fonts.heading, fontSize: 12, letterSpacing: 1 },
  perk: { color: '#FFFFFF', fontSize: 14, lineHeight: 20, marginBottom: 8 },
  nextPerks: { color: t.muted, fontSize: 12, textAlign: 'center', marginTop: 14 },
  upgrade: { minHeight: 52, borderRadius: 16, borderWidth: 1.5, borderColor: t.primary, alignItems: 'center', justifyContent: 'center', marginTop: 10 },
  upgradeText: { color: t.accent, fontFamily: fonts.heading, fontSize: 14, letterSpacing: 0.4 },
  topTier: { color: t.muted, fontFamily: fonts.heading, fontSize: 12, letterSpacing: 1, textAlign: 'center', marginTop: 14 },
  history: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 12 },
  historyRule: { borderTopWidth: 1, borderTopColor: t.line },
  historyDay: { color: t.text, fontSize: 13 },
  historyMeta: { color: t.muted, fontSize: 12 },
  empty: { color: t.muted, fontSize: 13 },
});
const styles = { light: make(themes.light), dark: make(themes.dark) };
