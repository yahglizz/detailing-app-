import { ALL_SLOTS, decideBump, nextOpenSlot } from '../../supabase/functions/_shared/bump';

test('ALL_SLOTS is 09:00..17:00 hourly', () => {
  expect(ALL_SLOTS).toHaveLength(9);
  expect(ALL_SLOTS[0]).toBe('09:00');
  expect(ALL_SLOTS[8]).toBe('17:00');
});

test('empty slot is open for anyone', () => {
  expect(decideBump(0, null)).toBe('open');
  expect(decideBump(3, null)).toBe('open');
});

test('anchored is blocked for every rank', () => {
  expect(decideBump(3, { rank: 0, anchored: true })).toBe('blocked');
  expect(decideBump(1, { rank: 0, anchored: true })).toBe('blocked');
});

test('higher rank bumps lower', () => {
  expect(decideBump(3, { rank: 0, anchored: false })).toBe('bump');
  expect(decideBump(3, { rank: 2, anchored: false })).toBe('bump');
  expect(decideBump(1, { rank: 0, anchored: false })).toBe('bump');
});

test('equal member ranks escalate to owner', () => {
  expect(decideBump(3, { rank: 3, anchored: false })).toBe('escalate');
  expect(decideBump(1, { rank: 1, anchored: false })).toBe('escalate');
});

test('equal non-member rank is plain blocked (slot_taken)', () => {
  expect(decideBump(0, { rank: 0, anchored: false })).toBe('blocked');
});

test('lower rank cannot bump higher', () => {
  expect(decideBump(1, { rank: 3, anchored: false })).toBe('blocked');
  expect(decideBump(0, { rank: 1, anchored: false })).toBe('blocked');
});

test('nextOpenSlot finds first free slot after, or null', () => {
  expect(nextOpenSlot(['10:00'], '10:00')).toBe('11:00');
  expect(nextOpenSlot(['10:00', '11:00'], '10:00')).toBe('12:00');
  expect(nextOpenSlot(ALL_SLOTS, '10:00')).toBeNull();
  expect(nextOpenSlot([], '17:00')).toBeNull();
});
