import {
  EMPTY_CART,
  cartStorageKey,
  legacyCartStorageKey,
  sanitizeCart,
  type CartState,
} from "./cart";

/**
 * Store externo do carrinho (um por restaurante), para `useSyncExternalStore`.
 * Persiste em localStorage com try/catch em TODO acesso (modo privado, cota,
 * dados bloqueados). Se o storage falhar, o carrinho continua funcionando em
 * memória durante a sessão da aba.
 */

type Entry = { raw: string | null; state: CartState };

const cache = new Map<string, Entry>();
const memoryRaw = new Map<string, string | null>();
const listeners = new Map<string, Set<() => void>>();

/**
 * Migra o carrinho v1 (sem variantes) para a chave v2, uma única vez: lê a
 * chave antiga, grava a v2 já saneada e apaga a antiga. Retorna o texto v2 ou null.
 */
function migrateLegacy(slug: string): string | null {
  try {
    const legacyKey = legacyCartStorageKey(slug);
    const legacyRaw = window.localStorage.getItem(legacyKey);
    if (legacyRaw === null) return null;
    let migrated: string | null = null;
    try {
      const state = sanitizeCart(JSON.parse(legacyRaw));
      migrated = state.lines.length === 0 ? null : JSON.stringify(state);
    } catch {
      migrated = null;
    }
    if (migrated !== null) window.localStorage.setItem(cartStorageKey(slug), migrated);
    window.localStorage.removeItem(legacyKey);
    return migrated;
  } catch {
    return null;
  }
}

function readRaw(slug: string): string | null {
  try {
    const value = window.localStorage.getItem(cartStorageKey(slug));
    if (value !== null) return value;
    if (!memoryRaw.has(slug)) {
      const migrated = migrateLegacy(slug);
      if (migrated !== null) return migrated;
    }
  } catch {
    // storage indisponível: usa a memória
  }
  return memoryRaw.get(slug) ?? null;
}

function parse(raw: string | null): CartState {
  if (!raw) return EMPTY_CART;
  try {
    return sanitizeCart(JSON.parse(raw));
  } catch {
    return EMPTY_CART;
  }
}

export function getCartSnapshot(slug: string): CartState {
  const raw = readRaw(slug);
  const hit = cache.get(slug);
  if (hit && hit.raw === raw) return hit.state;
  const state = parse(raw);
  cache.set(slug, { raw, state });
  return state;
}

export function getServerCartSnapshot(): CartState {
  return EMPTY_CART;
}

function emit(slug: string) {
  listeners.get(slug)?.forEach((listener) => listener());
}

export function writeCart(slug: string, state: CartState): void {
  const raw = state.lines.length === 0 ? null : JSON.stringify(state);
  memoryRaw.set(slug, raw);
  try {
    if (raw === null) window.localStorage.removeItem(cartStorageKey(slug));
    else window.localStorage.setItem(cartStorageKey(slug), raw);
  } catch {
    // sem persistência: mantém só em memória
  }
  emit(slug);
}

export function subscribeCart(slug: string, listener: () => void): () => void {
  let set = listeners.get(slug);
  if (!set) {
    set = new Set();
    listeners.set(slug, set);
  }
  set.add(listener);

  // Outras abas: o evento `storage` só dispara em abas diferentes da que gravou.
  const onStorage = (event: StorageEvent) => {
    if (event.key === null || event.key === cartStorageKey(slug)) listener();
  };
  window.addEventListener("storage", onStorage);

  return () => {
    set.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}
