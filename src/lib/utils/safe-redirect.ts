const FAKE_ORIGIN = "http://internal.invalid";

/**
 * Aceita apenas caminhos internos (começam com "/" e permanecem na mesma
 * origem). Retorna `null` para qualquer valor suspeito: URLs absolutas,
 * "//host", "/\host", caracteres de controle ou valores não-string.
 *
 * Use sempre antes de redirecionar com um parâmetro `next` vindo do usuário.
 */
export function sanitizeNext(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  if (value.length === 0 || value.length > 2048) return null;
  if (!value.startsWith("/")) return null;
  if (value.startsWith("//") || value.startsWith("/\\")) return null;
  if (/[\u0000-\u001f\u007f\\]/.test(value)) return null;

  try {
    const url = new URL(value, FAKE_ORIGIN);
    if (url.origin !== FAKE_ORIGIN) return null;
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return null;
  }
}

/** Versão com valor padrão. */
export function safeNextOr(raw: unknown, fallback: string): string {
  return sanitizeNext(raw) ?? fallback;
}
