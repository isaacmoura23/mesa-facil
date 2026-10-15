/** Preferência de tamanho da fonte da cozinha (zoom da área dos cartões), salva neste aparelho. */
const STORAGE_KEY = "ops:kitchen-zoom:v1";

export const KITCHEN_ZOOMS = [0.85, 1, 1.2, 1.4, 1.7] as const;
export const DEFAULT_ZOOM_INDEX = 1;

const listeners = new Set<() => void>();
let cached: number | null = null;

function read(): number {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === null) return DEFAULT_ZOOM_INDEX;
    const value = Number(raw);
    return Number.isInteger(value) && value >= 0 && value < KITCHEN_ZOOMS.length ? value : DEFAULT_ZOOM_INDEX;
  } catch {
    return DEFAULT_ZOOM_INDEX;
  }
}

export function getZoomIndexSnapshot(): number {
  if (cached === null) cached = read();
  return cached;
}

export function getZoomIndexServerSnapshot(): number {
  return DEFAULT_ZOOM_INDEX;
}

export function subscribeZoom(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function setZoomIndex(index: number): void {
  const next = Math.min(KITCHEN_ZOOMS.length - 1, Math.max(0, index));
  cached = next;
  try {
    window.localStorage.setItem(STORAGE_KEY, String(next));
  } catch {
    // Sem armazenamento: vale só nesta sessão.
  }
  for (const listener of listeners) listener();
}
