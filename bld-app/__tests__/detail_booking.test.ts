import { validateReserve } from '../../supabase/functions/_shared/detail_booking';
import { DEFAULT_DETAIL_PRICING as CFG } from '../../supabase/functions/_shared/detail_pricing';

const TODAY = '2026-11-11';
const good = () => ({
  name: '  Jordan Lee ',
  phone: '(302) 555-0148',
  email: 'Jordan@Example.com ',
  vehicle: { year: '2021', make: 'Cadillac' },
  vehicleType: 'large',
  service: 'full',
  condition: 'moderate',
  petHair: true,
  day: '2026-11-14',
  slot: '10:00',
  street: '12 Market St',
  zip: '19801',
  notes: 'Gate code 4411',
  photoExts: ['jpg', 'png'],
});

test('a valid body passes and is trimmed / normalised', () => {
  const r = validateReserve(good(), CFG, TODAY);
  expect(r.ok).toBe(true);
  if (!r.ok) return;
  expect(r.value.name).toBe('Jordan Lee');
  expect(r.value.email).toBe('jordan@example.com');
  expect(r.value.cars).toEqual([{ year: '2021', make: 'Cadillac', vehicleType: 'large', service: 'full', condition: 'moderate', petHair: true }]);
});

test.each(['name', 'phone', 'email', 'vehicle', 'street', 'zip', 'day', 'slot'])('missing %s', (k) => {
  const b: any = good();
  delete b[k];
  const r = validateReserve(b, CFG, TODAY);
  expect(r.ok).toBe(false);
});

test('error codes', () => {
  const code = (over: object) => {
    const r = validateReserve({ ...good(), ...over }, CFG, TODAY);
    return r.ok ? 'ok' : r.error;
  };
  expect(code({ email: 'a@b' })).toBe('bad_email');
  expect(code({ phone: '12' })).toBe('bad_phone');
  expect(code({ service: '__proto__' })).toBe('bad_service');
  expect(code({ service: 'outside' })).toBe('bad_service');
  expect(code({ vehicleType: 'truck' })).toBe('bad_vehicle_type');
  expect(code({ condition: 'filthy' })).toBe('bad_condition');
  expect(code({ day: '2026-11-10' })).toBe('bad_day'); // yesterday
});

test('window: today+14 is allowed, today+15 is not; today itself is allowed', () => {
  const r = (day: string) => validateReserve({ ...good(), day }, CFG, TODAY).ok;
  expect(r('2026-11-11')).toBe(true);
  expect(r('2026-11-25')).toBe(true);
  expect(r('2026-11-26')).toBe(false);
  expect(r('2026-13-40')).toBe(false);
  expect(r('not-a-date')).toBe(false);
});

test('slot, zip and photos', () => {
  const code = (over: object) => {
    const r = validateReserve({ ...good(), ...over }, CFG, TODAY);
    return r.ok ? 'ok' : r.error;
  };
  expect(code({ slot: '08:00' })).toBe('bad_slot');
  expect(code({ slot: '9:00' })).toBe('bad_slot');
  expect(code({ zip: '1234' })).toBe('bad_zip');
  expect(code({ zip: '1980a' })).toBe('bad_zip');
  expect(code({ photoExts: ['jpg', 'jpg', 'jpg', 'jpg', 'jpg'] })).toBe('bad_photos');
  expect(code({ photoExts: ['exe'] })).toBe('bad_photos');
  expect(code({ photoExts: [] })).toBe('ok');
});

test('today: a start time that has passed or is inside the lead time is refused', () => {
  const at = (slot: string) => validateReserve({ ...good(), day: TODAY, slot }, CFG, TODAY, { minSlot: '13:00' });
  expect(at('12:00').ok).toBe(false);
  expect((at('12:00') as any).error).toBe('bad_slot');
  expect(at('13:00').ok).toBe(true);
  expect(at('17:00').ok).toBe(true);
  // other days ignore the minimum, and no minimum means no restriction
  expect(validateReserve({ ...good(), day: '2026-11-14', slot: '09:00' }, CFG, TODAY, { minSlot: '24:00' }).ok).toBe(true);
  expect(validateReserve({ ...good(), day: TODAY, slot: '09:00' }, CFG, TODAY).ok).toBe(true);
  // nothing left today
  expect(validateReserve({ ...good(), day: TODAY, slot: '17:00' }, CFG, TODAY, { minSlot: '24:00' }).ok).toBe(false);
});

test('pet hair must be a real boolean, not a string', () => {
  const r = validateReserve({ ...good(), petHair: 'yes' }, CFG, TODAY);
  expect(r.ok).toBe(false);
});

test('only year and brand are asked: no model, water or power needed, and extras are dropped', () => {
  const r = validateReserve({ ...good(), vehicle: { year: '2021', make: 'Toyota', model: 'Camry' }, water: false, power: false }, CFG, TODAY);
  expect(r.ok).toBe(true);
  if (!r.ok) return;
  expect(r.value.cars[0]).toEqual({ year: '2021', make: 'Toyota', vehicleType: 'large', service: 'full', condition: 'moderate', petHair: true });
  expect('water' in r.value).toBe(false);
  expect('power' in r.value).toBe(false);
  expect((validateReserve({ ...good(), vehicle: { year: '2021' } }, CFG, TODAY) as any).error).toBe('missing_fields');
});

test('client-supplied money fields are dropped', () => {
  const r = validateReserve({ ...good(), price: 1, deposit: 1, total: 1, startingPrice: 1 }, CFG, TODAY);
  expect(r.ok).toBe(true);
  if (!r.ok) return;
  for (const k of ['price', 'deposit', 'total', 'startingPrice']) expect(k in r.value).toBe(false);
});

test('long text is capped', () => {
  const r = validateReserve({ ...good(), notes: 'x'.repeat(900), name: 'n'.repeat(200) }, CFG, TODAY);
  expect(r.ok).toBe(true);
  if (!r.ok) return;
  expect(r.value.notes).toHaveLength(500);
  expect(r.value.name).toHaveLength(60);
});

test('non-object body', () => {
  expect(validateReserve(null, CFG, TODAY).ok).toBe(false);
  expect(validateReserve('x', CFG, TODAY).ok).toBe(false);
});

const car = (over: object = {}) => ({ year: '2020', make: 'Honda', vehicleType: 'sedan', service: 'full', condition: 'light', petHair: false, ...over });
const multi = (cars: unknown[], over: object = {}) => {
  const { vehicle, vehicleType, service, condition, petHair, ...rest } = good() as any;
  return { ...rest, cars, ...over };
};
const err = (b: unknown) => { const r = validateReserve(b, CFG, TODAY); return r.ok ? 'ok' : r.error; };

test('accepts cars array of 2', () => {
  const r = validateReserve(multi([car(), car({ make: 'Ford', service: 'deep' })]), CFG, TODAY);
  expect(r.ok).toBe(true);
  if (!r.ok) return;
  expect(r.value.cars).toHaveLength(2);
  expect(r.value.cars[1].make).toBe('Ford');
});

test('legacy single-car body maps to cars[0]', () => {
  const r = validateReserve(good(), CFG, TODAY);
  expect(r.ok && r.value.cars.length).toBe(1);
});

test('rejects 7 cars and empty list with bad_cars', () => {
  expect(err(multi(Array.from({ length: 7 }, () => car())))).toBe('bad_cars');
  expect(err(multi([]))).toBe('bad_cars');
  expect(err(multi(Array.from({ length: 6 }, () => car())))).toBe('ok');
});

test('bad condition in car 2 -> bad_condition', () => {
  expect(err(multi([car(), car({ condition: 'filthy' })]))).toBe('bad_condition');
});

test('per-car errors keep their codes', () => {
  expect(err(multi([car({ service: 'x' })]))).toBe('bad_service');
  expect(err(multi([car({ vehicleType: 'truck' })]))).toBe('bad_vehicle_type');
  expect(err(multi([car({ year: '1850' })]))).toBe('bad_vehicle');
  expect(err(multi([car({ make: '' })]))).toBe('missing_fields');
  expect(err(multi([car({ petHair: 'yes' })]))).toBe('bad_answer');
});

test('memberCode uppercased, trimmed, capped, empty -> null', () => {
  const v = (memberCode: unknown) => { const r = validateReserve({ ...good(), memberCode }, CFG, TODAY); return r.ok ? r.value.memberCode : 'fail'; };
  expect(v('  bld-ab12 ')).toBe('BLD-AB12');
  expect(v('x'.repeat(30))).toBe('X'.repeat(20));
  expect(v('  ')).toBeNull();
  expect(v(undefined)).toBeNull();
});

test('useBalance defaults false, true only for literal true', () => {
  const u = (useBalance: unknown) => { const r = validateReserve({ ...good(), useBalance }, CFG, TODAY); return r.ok && r.value.useBalance; };
  expect(u(undefined)).toBe(false);
  expect(u('true')).toBe(false);
  expect(u(1)).toBe(false);
  expect(u(true)).toBe(true);
});

test('expectedTotal optional: non-negative integer or null', () => {
  const e = (expectedTotal: unknown) => { const r = validateReserve({ ...good(), expectedTotal }, CFG, TODAY); return r.ok ? r.value.expectedTotal : 'fail'; };
  expect(e(undefined)).toBeNull();
  expect(e(150)).toBe(150);
  expect(e(0)).toBe(0);
  expect(e(-1)).toBeNull();
  expect(e(10.5)).toBeNull();
  expect(e('150')).toBeNull();
});
