import React from 'react';
import { Text } from 'react-native';
import { render, waitFor } from '@testing-library/react-native';

jest.mock('../src/api', () => ({
  supabase: {
    functions: {
      invoke: jest.fn(async (_name: string, { body }: { body: { code: string } }) =>
        body.code === 'BLD-GOOD22'
          ? { data: { member: { name: 'T', email: 't@t.co', tier: 'gold', active: true, periodStart: '2026-07-01' }, credits: 2, stamps: 4, savings: 41, rewardMenu: [], issuedRewards: [], history: [] }, error: null }
          : { data: null, error: { context: { json: async () => ({ error: 'invalid_code' }) } } },
      ),
    },
  },
}));

import { MemberProvider, useMember, TIER_COLORS } from '../src/state/member';

function Probe() {
  const m = useMember();
  React.useEffect(() => { m.enter('BLD-GOOD22'); }, []);
  return <Text testID="tier">{m.profile?.member.tier ?? 'none'}</Text>;
}

test('enter(code) loads profile into context', async () => {
  const { getByTestId } = await render(<MemberProvider><Probe /></MemberProvider>);
  await waitFor(() => expect(getByTestId('tier').props.children).toBe('gold'));
});

test('tier colors defined', () => {
  expect(TIER_COLORS.gold).toBe('#F5B942');
  expect(TIER_COLORS.bronze).toBe('#CD7F32');
  expect(TIER_COLORS.silver).toBe('#C0C0C0');
});
