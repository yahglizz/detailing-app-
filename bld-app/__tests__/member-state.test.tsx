import React from 'react';
import { Text } from 'react-native';
import { render, waitFor } from '@testing-library/react-native';

jest.mock('../src/api', () => ({
  supabase: {
    functions: {
      invoke: jest.fn(async (_name: string, { body }: { body: { code: string } }) => {
        if (body.code === 'BLD-GOOD22') {
          return { data: { member: { name: 'T', email: 't@t.co', tier: 'gold', active: true, periodStart: '2026-07-01' }, credits: 2, stamps: 4, savings: 41, rewardMenu: [], issuedRewards: [], history: [] }, error: null };
        }
        // Real network failure: context is a raw fetch error with no .json().
        if (body.code === 'BLD-NET222') {
          return { data: null, error: { context: new Error('fetch failed') } };
        }
        return { data: null, error: { context: { json: async () => ({ error: 'invalid_code' }) } } };
      }),
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

function ErrorProbe({ code }: { code: string }) {
  const m = useMember();
  const [err, setErr] = React.useState('pending');
  React.useEffect(() => { m.enter(code).then((e) => setErr(e ?? 'ok')); }, []);
  return <Text testID="err">{err}</Text>;
}

test('a real network failure resolves to "network", never throws', async () => {
  const { getByTestId } = await render(<MemberProvider><ErrorProbe code="BLD-NET222" /></MemberProvider>);
  await waitFor(() => expect(getByTestId('err').props.children).toBe('network'));
});

test('an invalid code resolves to "invalid_code"', async () => {
  const { getByTestId } = await render(<MemberProvider><ErrorProbe code="BLD-BAD222" /></MemberProvider>);
  await waitFor(() => expect(getByTestId('err').props.children).toBe('invalid_code'));
});

test('tier colors defined', () => {
  expect(TIER_COLORS.gold).toBe('#F5B942');
  expect(TIER_COLORS.bronze).toBe('#CD7F32');
  expect(TIER_COLORS.silver).toBe('#C0C0C0');
});
