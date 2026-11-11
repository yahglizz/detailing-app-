import React, { createContext, useContext, useReducer } from 'react';
import type { DetailService, VehicleType } from '../../../supabase/functions/_shared/detail_pricing';
import type { SavedCar } from '../../../supabase/functions/_shared/membership';

export const MAX_CARS = 6;
export type Condition = 'light' | 'moderate' | 'heavy';

// One car in the booking. condition '' and petHair null = not answered yet (the website asks too).
// label = the member's saved car this was filled from.
export interface Car {
  year: string;
  make: string;
  vehicleType: VehicleType;
  service: DetailService;
  condition: Condition | '';
  petHair: boolean | null;
  label?: string;
}
export interface Photo { uri: string; ext: string }

export interface OrderState {
  cars: Car[];
  street: string;
  zip: string;
  day: string; // YYYY-MM-DD
  slot: string; // 24h "HH:00", '' until picked
  notes: string;
  name: string;
  phone: string;
  email: string;
  photos: Photo[];
}

type CarField = keyof Omit<Car, 'label'>;
type Field = 'street' | 'zip' | 'day' | 'slot' | 'notes' | 'name' | 'phone' | 'email';

export type OrderAction =
  | { type: 'ADD_CAR' }
  | { type: 'REMOVE_CAR'; index: number }
  | { type: 'SET_CAR_FIELD'; index: number; field: CarField; value: Car[CarField] }
  | { type: 'PREFILL_CAR'; index: number; car: SavedCar }
  | { type: 'SET_FIELD'; field: Field; value: string }
  | { type: 'SET_PHOTOS'; photos: Photo[] }
  | { type: 'RESET' };

const newCar = (): Car => ({ year: '', make: '', vehicleType: 'sedan', service: 'full', condition: '', petHair: null });

export const initialOrder: OrderState = {
  cars: [newCar()],
  street: '', zip: '', day: '', slot: '', notes: '', name: '', phone: '', email: '',
  photos: [],
};

const editCar = (s: OrderState, index: number, fn: (c: Car) => Car): OrderState =>
  ({ ...s, cars: s.cars.map((c, i) => (i === index ? fn(c) : c)) });

export function orderReducer(state: OrderState, action: OrderAction): OrderState {
  switch (action.type) {
    case 'ADD_CAR':
      return state.cars.length >= MAX_CARS ? state : { ...state, cars: [...state.cars, newCar()] };
    case 'REMOVE_CAR':
      return state.cars.length <= 1 ? state : { ...state, cars: state.cars.filter((_, i) => i !== action.index) };
    case 'SET_CAR_FIELD':
      return editCar(state, action.index, (c) => {
        const next = { ...c, [action.field]: action.value };
        // hand-editing what the saved car filled in makes it a plain car again
        if (action.field === 'vehicleType' || action.field === 'year' || action.field === 'make') delete next.label;
        return next;
      });
    case 'PREFILL_CAR': {
      const saved = action.car;
      // old saved cars may still say 'truck': that's SUV / Truck now
      const vehicleType: VehicleType = (saved.size as string) === 'truck' ? 'suv' : saved.size;
      return editCar(state, action.index, (c) => ({
        ...c, vehicleType, label: saved.name,
        year: saved.year ?? c.year, make: saved.make ?? c.make,
      }));
    }
    case 'SET_FIELD':
      return { ...state, [action.field]: action.value };
    case 'SET_PHOTOS':
      return { ...state, photos: action.photos };
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
