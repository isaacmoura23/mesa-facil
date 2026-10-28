/**
 * Texto livre vindo do cliente: NUL e demais caracteres de controle (exceto tab, quebra de linha e
 * retorno de carro) são recusados. O NUL em especial derruba o jsonb do Postgres (22P05) e viraria 500 (F-29/F-30).
 */
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

export function hasControlChars(value: string): boolean {
  return CONTROL.test(value);
}

export const CONTROL_CHARS_MESSAGE = "Texto com caracteres inválidos.";

/** Procura, em qualquer profundidade, a primeira string com caractere de controle; devolve o caminho. */
export function findControlCharPath(value: unknown, path: (string | number)[] = [], depth = 0): (string | number)[] | null {
  if (typeof value === "string") return hasControlChars(value) ? path : null;
  if (depth > 8 || value === null || typeof value !== "object") return null;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const found = findControlCharPath(value[i], [...path, i], depth + 1);
      if (found) return found;
    }
    return null;
  }
  for (const [key, child] of Object.entries(value)) {
    if (hasControlChars(key)) return [...path, key];
    const found = findControlCharPath(child, [...path, key], depth + 1);
    if (found) return found;
  }
  return null;
}
