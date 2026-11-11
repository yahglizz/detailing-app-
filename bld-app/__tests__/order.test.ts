import { orderReducer, initialOrder, MAX_CARS } from '../src/state/order';

test('initial order has one blank full-detail sedan', () => {
  expect(initialOrder.cars).toEqual([{ year: '', make: '', vehicleType: 'sedan', service: 'full', condition: '', petHair: null }]);
  expect(initialOrder.photos).toEqual([]);
});

test('ADD_CAR caps at 6', () => {
  let s = initialOrder;
  for (let i = 0; i < 10; i++) s = orderReducer(s, { type: 'ADD_CAR' });
  expect(MAX_CARS).toBe(6);
  expect(s.cars).toHaveLength(6);
});

test('REMOVE_CAR keeps at least 1', () => {
  let s = orderReducer(initialOrder, { type: 'ADD_CAR' });
  s = orderReducer(s, { type: 'SET_CAR_FIELD', index: 1, field: 'make', value: 'Honda' });
  s = orderReducer(s, { type: 'REMOVE_CAR', index: 0 });
  expect(s.cars).toHaveLength(1);
  expect(s.cars[0].make).toBe('Honda');
  s = orderReducer(s, { type: 'REMOVE_CAR', index: 0 });
  expect(s.cars).toHaveLength(1);
  expect(s.cars[0].make).toBe('Honda');
});

test('SET_CAR_FIELD updates one car', () => {
  let s = orderReducer(initialOrder, { type: 'ADD_CAR' });
  s = orderReducer(s, { type: 'SET_CAR_FIELD', index: 1, field: 'service', value: 'premium' });
  s = orderReducer(s, { type: 'SET_CAR_FIELD', index: 1, field: 'petHair', value: true });
  expect(s.cars[0]).toEqual(initialOrder.cars[0]);
  expect(s.cars[1].service).toBe('premium');
  expect(s.cars[1].petHair).toBe(true);
});

test('prefill from saved car sets vehicleType/year/make', () => {
  let s = orderReducer(initialOrder, { type: 'PREFILL_CAR', index: 0, car: { name: 'Black Tahoe', size: 'large', year: '2019', make: 'Chevrolet' } });
  expect(s.cars[0]).toMatchObject({ vehicleType: 'large', year: '2019', make: 'Chevrolet', label: 'Black Tahoe', service: 'full' });
  // an old saved 'truck' reads as suv; missing year/make leave the fields as they were
  s = orderReducer(s, { type: 'PREFILL_CAR', index: 0, car: { name: 'Work truck', size: 'truck' as never } });
  expect(s.cars[0]).toMatchObject({ vehicleType: 'suv', year: '2019', make: 'Chevrolet', label: 'Work truck' });
  // editing the car by hand makes it a plain car again
  s = orderReducer(s, { type: 'SET_CAR_FIELD', index: 0, field: 'vehicleType', value: 'sedan' });
  expect(s.cars[0]).not.toHaveProperty('label');
});

test('SET_FIELD, photos and RESET', () => {
  let s = orderReducer(initialOrder, { type: 'SET_FIELD', field: 'street', value: '2841 S 12th St' });
  s = orderReducer(s, { type: 'SET_PHOTOS', photos: [{ uri: 'file:///a.jpg', ext: 'jpg' }] });
  expect(s.street).toBe('2841 S 12th St');
  expect(s.photos).toHaveLength(1);
  expect(orderReducer(s, { type: 'RESET' })).toEqual(initialOrder);
});
