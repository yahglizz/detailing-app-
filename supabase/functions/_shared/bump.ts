// Priority bump decision matrix. Pure — jest-tested. Server is the only caller
// that ACTS on these decisions; the app may use them for display hints only.

export const ALL_SLOTS: string[] = Array.from({ length: 9 }, (_, i) => `${String(9 + i).padStart(2, '0')}:00`);

export interface SlotHolder { rank: number; anchored: boolean }

export type BumpDecision = 'open' | 'bump' | 'blocked' | 'escalate';

export function decideBump(bookerRank: number, holder: SlotHolder | null): BumpDecision {
  if (!holder) return 'open';
  if (holder.anchored) return 'blocked';
  if (bookerRank > holder.rank) return 'bump';
  if (bookerRank === holder.rank && bookerRank > 0) return 'escalate';
  return 'blocked';
}

export function nextOpenSlot(taken: string[], fromSlot: string): string | null {
  const t = new Set(taken);
  for (const s of ALL_SLOTS) {
    if (s > fromSlot && !t.has(s)) return s;
  }
  return null;
}
