import React from 'react';
import { render, screen } from '@testing-library/react-native';
import { OrderProvider } from '../src/state/order';
import PriceBar from '../src/components/PriceBar';

jest.mock('../src/api', () => ({ supabase: { from: () => ({ select: () => ({ eq: () => ({ single: () => Promise.resolve({ data: null }) }) }) }) } }));
import { CatalogProvider } from '../src/state/catalog';

test('shows default single sedan full detail price and deposit', async () => {
  await render(
    <CatalogProvider><OrderProvider>
      <PriceBar onNext={() => {}} label="Continue" />
    </OrderProvider></CatalogProvider>,
  );
  expect(screen.getByText('$120')).toBeTruthy();
  expect(screen.getByText(/\$30 deposit/)).toBeTruthy(); // 25% of 120
});
