import React, { createContext, useContext, useReducer } from 'react';
import type { CarItem, Extra, Service, Size } from '../../../supabase/functions/_shared/pricing';

export interface OrderState {
  items: CarItem[];
  address: string;
  preferredDay: string; // YYYY-MM-DD
  timeSlot: string; // 24h "HH:MM", e.g. '09:00' — '' until picked
  window: 'morning' | 'afternoon' | 'either';
  notes: string;
  remainderMethod: 'cash' | 'card';
  name: string;
}

export type OrderAction =
  | { type: 'SET_CAR_COUNT'; count: number }
  | { type: 'SET_SIZE'; index: number; size: Size }
  | { type: 'SET_SERVICE'; index: number; service: Service }
  | { type: 'TOGGLE_EXTRA'; index: number; extra: Extra }
  | { type: 'SET_FIELD'; field: 'address' | 'preferredDay' | 'timeSlot' | 'window' | 'notes' | 'remainderMethod' | 'name'; value: string }
  | { type: 'RESET' };

const newCar = (): CarItem => ({ size: 'sedan', service: 'full', extras: [] });

export const initialOrder: OrderState = {
  items: [newCar()],
  address: '',
  preferredDay: '',
  timeSlot: '',
  window: 'either',
  notes: '',
  remainderMethod: 'cash',
  name: '',
};

export function orderReducer(state: OrderState, action: OrderAction): OrderState {
  switch (action.type) {
    case 'SET_CAR_COUNT': {
      const count = Math.max(1, Math.min(6, action.count));
      const items = state.items.slice(0, count);
      while (items.length < count) items.push(newCar());
      return { ...state, items };
    }
    case 'SET_SIZE':
      return { ...state, items: state.items.map((c, i) => (i === action.index ? { ...c, size: action.size } : c)) };
    case 'SET_SERVICE':
      return { ...state, items: state.items.map((c, i) => (i === action.index ? { ...c, service: action.service } : c)) };
    case 'TOGGLE_EXTRA':
      return {
        ...state,
        items: state.items.map((c, i) =>
          i !== action.index ? c : {
            ...c,
            extras: c.extras.includes(action.extra) ? c.extras.filter((e) => e !== action.extra) : [...c.extras, action.extra],
          },
        ),
      };
    case 'SET_FIELD':
      return { ...state, [action.field]: action.value };
    case 'RESET':
      return initialOrder;
  }
}

const Ctx = createContext<{ state: OrderState; dispatch: React.Dispatch<OrderAction> } | null>(null);

export function OrderProvider({ children }: { children: React.ReactNode }) {
  const [state, dispatch] = useReducer(orderReducer, initialOrder);
  return <Ctx.Provider value={{ state, dispatch }}>{children}</Ctx.Provider>;
}

export function useOrder() {
  const v = useContext(Ctx);
  if (!v) throw new Error('useOrder outside OrderProvider');
  return v;
}
