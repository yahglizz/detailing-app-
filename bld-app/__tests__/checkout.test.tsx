import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react-native';
import Build from '../src/screens/Build';
import { OrderProvider } from '../src/state/order';

jest.mock('../src/api', () => ({ supabase: { rpc: jest.fn(), functions: { invoke: jest.fn() } } }));
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
