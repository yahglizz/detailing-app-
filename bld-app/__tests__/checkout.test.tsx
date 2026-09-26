import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react-native';
import Build from '../src/screens/Build';
import { OrderProvider } from '../src/state/order';

// day_states: every day in the asked range is open with room (tests override it per case).
const openDays = (_fn: string, a: { from_day?: string; to_day?: string }) => {
  const rows = [];
  if (a?.from_day) for (let d = new Date(`${a.from_day}T00:00:00`); d <= new Date(`${a.to_day}T00:00:00`); d.setDate(d.getDate() + 1)) {
    rows.push({ day: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`, capacity: 9, booked: 0, closed: false });
  }
  return Promise.resolve({ data: rows });
};
jest.mock('../src/api', () => ({ supabase: { rpc: jest.fn(), functions: { invoke: jest.fn() } } }));
const { supabase } = jest.requireMock('../src/api');
beforeEach(() => supabase.rpc.mockImplementation(openDays));
jest.mock('../src/state/member', () => ({ useMember: () => ({ profile: null, code: null, refresh: jest.fn() }) }));
jest.mock('expo-web-browser', () => ({ openAuthSessionAsync: jest.fn() }));
jest.mock('expo-linking', () => ({ createURL: () => 'exp://127.0.0.1:8081/--/checkout' }));

test('checkout keeps service selection and deposit on the same page', async () => {
  await render(<OrderProvider><Build navigation={{ goBack: jest.fn(), reset: jest.fn() } as any} route={{} as any} /></OrderProvider>);
  expect(screen.getByText('WHEN & WHERE')).toBeTruthy();
  expect(screen.getByText('CHECK OUT')).toBeTruthy();
  expect(screen.getAllByText('$120').length).toBeGreaterThan(0);
  await fireEvent.press(screen.getByText('INSIDE'));
  expect(screen.getAllByText('$60').length).toBeGreaterThan(0);
  expect(screen.getAllByText('$15').length).toBeGreaterThan(0);
});

test('customer picks deposit or pay in full; no card fields in the app', async () => {
  await render(<OrderProvider><Build navigation={{ goBack: jest.fn(), reset: jest.fn() } as any} route={{} as any} /></OrderProvider>);
  expect(screen.queryByLabelText('Card number')).toBeNull();
  expect(screen.getByText('CONTINUE TO PAYMENT')).toBeTruthy();
  expect(screen.getByText('PAY THE REST AT YOUR DETAIL')).toBeTruthy();
  await fireEvent.press(screen.getByText('IN FULL $120'));
  expect(screen.getAllByText('$120').length).toBeGreaterThan(2);
  expect(screen.getByText('Paid in full — nothing due at your detail')).toBeTruthy();
  expect(screen.queryByText('PAY THE REST AT YOUR DETAIL')).toBeNull();
  await fireEvent.press(screen.getByText('DEPOSIT $30'));
  expect(screen.getByText('$90 at your detail · cash')).toBeTruthy();
});

test('days the owner closed or that are full cannot be picked', async () => {
  supabase.rpc.mockImplementation(async (fn: string, a: { from_day?: string; to_day?: string }) => {
    const { data } = await openDays(fn, a);
    // alternate closed and fully booked: the whole visible month is unavailable
    return { data: data.map((d, i) => (i % 2 ? { ...d, closed: true, capacity: 0 } : { ...d, booked: 9 })) };
  });
  await render(<OrderProvider><Build navigation={{ goBack: jest.fn(), reset: jest.fn() } as any} route={{} as any} /></OrderProvider>);
  expect(supabase.rpc).toHaveBeenCalledWith('day_states', expect.objectContaining({ from_day: expect.any(String) }));
  const days = screen.getAllByLabelText(/^[A-Z][a-z]+ \d+$/);
  expect(days.length).toBeGreaterThan(27);
  for (const d of days) expect(d.props.accessibilityState.disabled).toBe(true);
});
