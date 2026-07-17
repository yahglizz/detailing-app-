import { orderReducer, initialOrder } from '../src/state/order';

test('initial order has one full-service sedan', () => {
  expect(initialOrder.items).toEqual([{ size: 'sedan', service: 'full', extras: [] }]);
});

test('SET_CAR_COUNT grows preserving existing cars and shrinks from the end', () => {
  let s = orderReducer(initialOrder, { type: 'SET_SIZE', index: 0, size: 'truck' });
  s = orderReducer(s, { type: 'SET_CAR_COUNT', count: 3 });
  expect(s.items).toHaveLength(3);
  expect(s.items[0].size).toBe('truck');
  expect(s.items[2]).toEqual({ size: 'sedan', service: 'full', extras: [] });
  s = orderReducer(s, { type: 'SET_CAR_COUNT', count: 1 });
  expect(s.items).toEqual([{ size: 'truck', service: 'full', extras: [] }]);
});

test('TOGGLE_EXTRA adds then removes', () => {
  let s = orderReducer(initialOrder, { type: 'TOGGLE_EXTRA', index: 0, extra: 'ceramic' });
  expect(s.items[0].extras).toEqual(['ceramic']);
  s = orderReducer(s, { type: 'TOGGLE_EXTRA', index: 0, extra: 'ceramic' });
  expect(s.items[0].extras).toEqual([]);
});

test('SET_FIELD sets schedule fields; RESET restores initial', () => {
  let s = orderReducer(initialOrder, { type: 'SET_FIELD', field: 'address', value: '2841 S 12th St' });
  expect(s.address).toBe('2841 S 12th St');
  expect(orderReducer(s, { type: 'RESET' })).toEqual(initialOrder);
});

test('anchor toggles and resets', () => {
  let st = orderReducer(initialOrder, { type: 'SET_ANCHOR', anchor: true });
  expect(st.anchor).toBe(true);
  st = orderReducer(st, { type: 'RESET' });
  expect(st.anchor).toBe(false);
});
