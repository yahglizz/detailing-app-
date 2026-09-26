import React from 'react';
import { Linking, Pressable, StyleSheet, Text, View } from 'react-native';
import type { MemberCatalog, Tier } from '../../../supabase/functions/_shared/membership';
import { TIER_COLORS } from '../state/member';
import { useCatalog } from '../state/catalog';
import { fonts, themes, type Mode, type Theme } from '../theme';
import { ui } from '../ui';

const TIERS: Tier[] = ['bronze', 'silver', 'gold'];
type JoinCatalog = Partial<MemberCatalog> & { stripe?: { links?: Record<string, string> } };

// The tiers' Stripe Payment Links, or null until the catalog has any.
export function joinLinks(catalog: unknown): Record<string, string> | null {
  const links = (catalog as JoinCatalog).stripe?.links;
  return links && TIERS.some((k) => links[k]) ? links : null;
}

// The membership tiers with their perks and price; each opens that tier's Stripe
// Payment Link. Renders nothing until the links are in the catalog.
export default function JoinTiers({ mode, num, title, heading, hint }: {
  mode: Mode; num: string; title: string; heading: string; hint: string;
}) {
  const catalog = useCatalog() as unknown as JoinCatalog;
  const links = joinLinks(catalog);
  if (!links) return null;
  const u = ui[mode];
  const s = styles[mode];

  return <>
    <View style={u.sectionHead}><Text style={u.sectionNum}>{num}</Text><Text style={u.sectionTitle}>{title}</Text></View>
    <View style={u.sheet}>
      <Text style={u.fieldHeading}>{heading}</Text>
      <Text style={[u.hint, s.hintGap]}>{hint}</Text>
      <View style={s.tierRow}>
        {TIERS.map((k) => {
          const url = links[k];
          const plan = catalog.plans?.[k];
          return url ? (
            <Pressable key={k} accessibilityRole="link" accessibilityLabel={`Join ${k}`} onPress={() => Linking.openURL(url)} style={s.tierTile}>
              <View style={[s.tierStripe, { backgroundColor: TIER_COLORS[k] }]} />
              <Text style={s.tierName}>{k.toUpperCase()}</Text>
              {plan && <Text style={s.tierDetail}>{plan.credits} {plan.service} details a month</Text>}
              {!!plan?.discountPercent && <Text style={s.tierPerk}>{plan.discountPercent}% off everything</Text>}
              {!!plan?.topupBonusPercent && <Text style={s.tierPerk}>+{plan.topupBonusPercent}% balance bonus</Text>}
              {!!plan?.stampsPerCar && <Text style={s.tierPerk}>{plan.stampsPerCar > 1 ? `${plan.stampsPerCar}× reward stamps` : 'Reward stamps'}</Text>}
              {plan && <Text style={s.tierPrice}>${plan.price}/MO</Text>}
            </Pressable>
          ) : null;
        })}
      </View>
    </View>
  </>;
}

const make = (t: Theme) => StyleSheet.create({
  hintGap: { marginTop: 4, marginBottom: 14 },
  tierRow: { flexDirection: 'row', gap: 8 },
  tierTile: { flex: 1, minHeight: 132, borderRadius: 19, backgroundColor: t.chip, padding: 12 },
  tierStripe: { width: 28, height: 4, borderRadius: 2, marginBottom: 12 },
  tierName: { color: t.text, fontFamily: fonts.heading, fontSize: 15 },
  tierDetail: { color: t.muted, fontSize: 11, lineHeight: 14, marginTop: 4 },
  tierPerk: { color: t.accent, fontSize: 11, lineHeight: 14, marginTop: 4 },
  tierPrice: { color: t.text, fontFamily: fonts.heading, fontSize: 13, marginTop: 'auto', paddingTop: 8 },
});
const styles = { light: make(themes.light), dark: make(themes.dark) };
