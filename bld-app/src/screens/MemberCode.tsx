import React, { useState } from 'react';
import { ActivityIndicator, Image, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../../App';
import { useMember } from '../state/member';
import { useAppearance } from '../state/appearance';
import JoinTiers from '../components/JoinTiers';
import { fonts, themes } from '../theme';
import { ui } from '../ui';

type Props = NativeStackScreenProps<RootStackParamList, 'MemberCode'>;

export default function MemberCode({ navigation }: Props) {
  const { enter } = useMember();
  const { mode } = useAppearance();
  const t = themes[mode];
  const u = ui[mode];
  const [code, setCode] = useState('BLD-');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const go = async () => {
    setBusy(true); setError('');
    const err = await enter(code);
    setBusy(false);
    if (err === 'invalid_code') return setError("That code doesn't match. Check the letters — no O's or 0's.");
    if (err === 'rate_limited') return setError('Too many tries. Wait 15 minutes and try again.');
    if (err) return setError('Network problem. Check your signal and try again.');
    navigation.reset({ index: 0, routes: [{ name: 'MemberDashboard' }] });
  };

  return (
    <SafeAreaView style={u.root}>
      <StatusBar style={t.statusBar} />
      <LinearGradient colors={t.bg} style={StyleSheet.absoluteFill} />
      <ScrollView contentContainerStyle={u.content} keyboardShouldPersistTaps="handled">
        <View style={u.topbar}>
          <Pressable accessibilityRole="button" accessibilityLabel="Back" onPress={() => navigation.goBack()} style={u.topButton}><Text style={u.topButtonText}>‹</Text></Pressable>
          <View style={{ alignItems: 'center' }}><Text style={u.topTitle}>LOG IN</Text><Text style={u.topSub}>With your code</Text></View>
          <Image source={require('../../assets/bld-logo.png')} style={u.logo} resizeMode="contain" />
        </View>
        <Text style={u.eyebrow}>THE BROTHERHOOD</Text>
        <Text style={u.title}>A CLEANER RIDE{'\n'}STARTS HERE.</Text>
        <Text style={u.intro}>Your code unlocks your balance — and for members, your washes, rewards and priority booking.</Text>

        <View style={u.sectionHead}><Text style={u.sectionNum}>01</Text><Text style={u.sectionTitle}>SIGN IN</Text></View>
        <View style={u.sheet}>
          <Text style={u.fieldHeading}>ENTER YOUR CODE</Text>
          <Text style={[u.hint, s.hintGap]}>It's in your welcome or balance email. You only enter it once.</Text>
          <TextInput accessibilityLabel="Your BLD code" style={[u.input, s.code]} value={code}
            onChangeText={(v) => setCode(v.toUpperCase())} autoCapitalize="characters" autoCorrect={false}
            maxLength={10} placeholder="BLD-XXXXXX" placeholderTextColor={t.faint} keyboardAppearance={mode}
            returnKeyType="go" onSubmitEditing={go} />
          <Pressable accessibilityRole="button" style={[u.button, busy && { opacity: 0.65 }]} onPress={go} disabled={busy}>
            {busy ? <ActivityIndicator color="#FFFFFF" /> : <Text style={u.buttonText}>OPEN MY ACCOUNT</Text>}
          </Pressable>
          {!!error && <Text style={u.error}>{error}</Text>}
        </View>

        <JoinTiers mode={mode} num="02" title="JOIN A TIER" heading="NEW TO THE BROTHERHOOD?"
          hint="The higher the tier, the bigger every perk. Your member code arrives by email right after you pay." />
      </ScrollView>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  hintGap: { marginTop: 4, marginBottom: 14 },
  code: { minHeight: 56, fontFamily: fonts.heading, fontSize: 20, letterSpacing: 2 },
});
