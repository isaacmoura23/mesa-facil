"use client";

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import {
  EMPTY_CART,
  cartCount,
  clampQuantity,
  estimatedSubtotalCents,
  withAddedLine,
  type CartLine,
  type CartLineInput,
  type CartState,
} from "./cart";
import {
  getCartSnapshot,
  getServerCartSnapshot,
  subscribeCart,
  writeCart,
} from "./cart-store";

type CartContextValue = {
  slug: string;
  /** false até o carrinho persistido ser lido no navegador. */
  ready: boolean;
  lines: CartLine[];
  count: number;
  /** Soma ESTIMADA a partir dos snapshots (não é preço oficial). */
  estimatedSubtotalCents: number;
  addLine: (input: CartLineInput) => void;
  setQuantity: (lineId: string, quantity: number) => void;
  removeLine: (lineId: string) => void;
  clear: () => void;
  drawerOpen: boolean;
  openDrawer: () => void;
  closeDrawer: () => void;
};

const CartContext = createContext<CartContextValue | null>(null);

const subscribeNever = () => () => {};

export function CartProvider({ slug, children }: { slug: string; children: ReactNode }) {
  const subscribe = useCallback(
    (listener: () => void) => subscribeCart(slug, listener),
    [slug],
  );
  const getSnapshot = useCallback(() => getCartSnapshot(slug), [slug]);
  const state = useSyncExternalStore(subscribe, getSnapshot, getServerCartSnapshot);
  const ready = useSyncExternalStore(
    subscribeNever,
    () => true,
    () => false,
  );
  const [drawerOpen, setDrawerOpen] = useState(false);

  const commit = useCallback(
    (update: (current: CartState) => CartState) => {
      writeCart(slug, update(getCartSnapshot(slug)));
    },
    [slug],
  );

  const value = useMemo<CartContextValue>(
    () => ({
      slug,
      ready,
      lines: state.lines,
      count: cartCount(state.lines),
      estimatedSubtotalCents: estimatedSubtotalCents(state.lines),
      addLine: (input) => commit((current) => withAddedLine(current, input)),
      setQuantity: (lineId, quantity) =>
        commit((current) => ({
          ...current,
          lines: current.lines.map((l) =>
            l.id === lineId ? { ...l, quantity: clampQuantity(quantity) } : l,
          ),
        })),
      removeLine: (lineId) =>
        commit((current) => {
          const lines = current.lines.filter((l) => l.id !== lineId);
          return lines.length === 0 ? EMPTY_CART : { ...current, lines };
        }),
      clear: () => commit(() => EMPTY_CART),
      drawerOpen,
      openDrawer: () => setDrawerOpen(true),
      closeDrawer: () => setDrawerOpen(false),
    }),
    [slug, ready, state, commit, drawerOpen],
  );

  return <CartContext value={value}>{children}</CartContext>;
}

export function useCart(): CartContextValue {
  const context = useContext(CartContext);
  if (!context) throw new Error("useCart precisa estar dentro de <CartProvider>.");
  return context;
}
