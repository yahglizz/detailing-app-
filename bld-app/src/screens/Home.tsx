import React from 'react';
import { Image, Pressable, StyleSheet, Text, View } from 'react-native';
import { useVideoPlayer, VideoView } from 'expo-video';
import { LinearGradient } from 'expo-linear-gradient';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../../App';
import { useMember } from '../state/member';
import { colors, fonts, radius, spacing } from '../theme';

type Props = NativeStackScreenProps<RootStackParamList, 'Home'>;

const HERO = require('../../assets/hero-video.mp4');

export default function Home({ navigation }: Props) {
  const player = useVideoPlayer(HERO, (p) => {
    p.loop = true;
    p.muted = true;
    p.play();
  });

  const { profile, loading } = useMember();
  React.useEffect(() => {
    if (!loading && profile) navigation.reset({ index: 0, routes: [{ name: 'MemberDashboard' }] });
  }, [loading, profile]);

  return (
    <View style={s.root}>
      {/* Looping hero video — cover-fit full bleed, same as website hero */}
      <VideoView
        player={player}
        style={StyleSheet.absoluteFill}
        contentFit="cover"
        nativeControls={false}
        allowsPictureInPicture={false}
      />
      {/* Dark gradient wash for legibility, matching the website hero overlay */}
      <LinearGradient
        colors={['rgba(14,13,17,0.35)', 'rgba(14,13,17,0.55)', 'rgba(14,13,17,0.96)']}
        locations={[0, 0.45, 1]}
        style={StyleSheet.absoluteFill}
      />

      <View style={s.content}>
        <Image source={require('../../assets/bld-logo.png')} style={s.logo} resizeMode="contain" />
        <Text style={s.title}>BROTHERLY LOVE{'\n'}DETAILING</Text>
        <Text style={s.tagline}>Philly's mobile detail ministry. We come to you.</Text>
        <Pressable
          accessibilityRole="button"
          style={({ pressed }) => [s.cta, pressed && { transform: [{ scale: 0.98 }] }]}
          onPress={() => navigation.navigate('Build')}
        >
          <Text style={s.ctaText}>GET MY DETAIL</Text>
        </Pressable>
        <Pressable accessibilityRole="button" onPress={() => navigation.navigate('MemberCode')}>
          <Text style={s.member}>Brotherhood member? Enter your code →</Text>
        </Pressable>
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  content: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing(8) },
  logo: { width: 140, height: 140, marginBottom: spacing(6) },
  title: { fontFamily: fonts.headingBlack, fontSize: 34, color: colors.text, textAlign: 'center', lineHeight: 38 },
  tagline: { color: colors.textSecondary, fontSize: 16, marginTop: spacing(3), textAlign: 'center' },
  cta: {
    marginTop: spacing(12), backgroundColor: colors.primary, borderRadius: radius.button,
    paddingVertical: spacing(5), paddingHorizontal: spacing(12), minHeight: 56, justifyContent: 'center',
    shadowColor: colors.primary, shadowOpacity: 0.5, shadowRadius: 16, shadowOffset: { width: 0, height: 8 }, elevation: 8,
  },
  ctaText: { fontFamily: fonts.heading, color: colors.text, fontSize: 22, letterSpacing: 1 },
  member: { color: colors.textMuted, fontSize: 13, marginTop: spacing(8) },
});
