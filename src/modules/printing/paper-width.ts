import { DEFAULT_PAPER_WIDTH, PAPER_WIDTHS, type PaperWidth } from "./types";

/** Preferência de largura do papel (80/58 mm), salva neste aparelho. */
const STORAGE_KEY = "ops:print-paper-width:v1";

const listeners = new Set<() => void>();
let cached: PaperWidth | null = null;

function isPaperWidth(value: unknown): value is PaperWidth {
  return typeof value === "string" && (PAPER_WIDTHS as readonly string[]).includes(value);
}

function read(): PaperWidth {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return isPaperWidth(raw) ? raw : DEFAULT_PAPER_WIDTH;
  } catch {
    return DEFAULT_PAPER_WIDTH;
  }
}

export function getPaperWidthSnapshot(): PaperWidth {
  if (cached === null) cached = read();
  return cached;
}

export function getPaperWidthServerSnapshot(): PaperWidth {
  return DEFAULT_PAPER_WIDTH;
}

export function subscribePaperWidth(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function setPaperWidth(width: PaperWidth): void {
  cached = width;
  try {
    window.localStorage.setItem(STORAGE_KEY, width);
  } catch {
    // Sem armazenamento (modo privado): a escolha vale só nesta sessão.
  }
  for (const listener of listeners) listener();
}
