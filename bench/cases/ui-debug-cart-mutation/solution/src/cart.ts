export interface CartItem {
  sku: string;
  name: string;
  unitPrice: number;
  qty: number;
}

export interface CartState {
  items: CartItem[];
  couponCode: string | null;
}

export type CartAction =
  | { type: "ADD_ITEM"; item: Omit<CartItem, "qty">; qty: number }
  | { type: "SET_QTY"; sku: string; qty: number }
  | { type: "REMOVE_ITEM"; sku: string }
  | { type: "APPLY_COUPON"; code: string }
  | { type: "CLEAR" };

export const initialCart: CartState = { items: [], couponCode: null };

/** 순수 리듀서. 기존 state 객체를 바꾸지 않고 새 객체를 반환한다. */
export function cartReducer(state: CartState, action: CartAction): CartState {
  switch (action.type) {
    case "ADD_ITEM": {
      const idx = state.items.findIndex((i) => i.sku === action.item.sku);
      if (idx === -1) {
        return { ...state, items: [...state.items, { ...action.item, qty: action.qty }] };
      }
      const items = state.items.map((i, n) => (n === idx ? { ...i, qty: i.qty + action.qty } : i));
      return { ...state, items };
    }
    case "SET_QTY": {
      if (action.qty <= 0) return cartReducer(state, { type: "REMOVE_ITEM", sku: action.sku });
      return { ...state, items: state.items.map((i) => (i.sku === action.sku ? { ...i, qty: action.qty } : i)) };
    }
    case "REMOVE_ITEM": {
      const items = state.items.filter((i) => i.sku !== action.sku);
      const couponCode = items.length === 0 ? null : state.couponCode;
      return { ...state, items, couponCode };
    }
    case "APPLY_COUPON":
      return { ...state, couponCode: action.code.trim().toUpperCase() };
    case "CLEAR":
      return initialCart;
  }
}

export function cartTotal(state: CartState): number {
  return state.items.reduce((sum, i) => sum + i.unitPrice * i.qty, 0);
}
