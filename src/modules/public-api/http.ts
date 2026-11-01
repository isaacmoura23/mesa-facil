import { SLUG_PATTERN } from "@/lib/validation/auth";
import type { ApiErrorBody, ApiErrorCode } from "./types";

export const MAX_BODY_BYTES = 64 * 1024;

export const MENU_CACHE_CONTROL = "public, s-maxage=30, stale-while-revalidate=60";

/** Cabeçalhos presentes em TODA resposta da API (sucesso e erro). */
const BASE_HEADERS: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  // Respostas variam por origem (CORS): caches/CDN não podem misturá-las.
  Vary: "Origin",
};

export function jsonResponse(
  body: unknown,
  init: { status?: number; headers?: Record<string, string> } = {},
): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: {
      ...BASE_HEADERS,
      "Content-Type": "application/json; charset=utf-8",
      ...init.headers,
    },
  });
}

const DEFAULT_MESSAGES: Record<ApiErrorCode, string> = {
  invalid_request: "Requisição inválida.",
  restaurant_not_found: "Restaurante não encontrado.",
  order_not_found: "Pedido não encontrado.",
  order_rejected: "O pedido não pôde ser aceito.",
  idempotency_conflict: "Esta chave de idempotência já foi usada com outro conteúdo.",
  origin_not_allowed: "Origem não autorizada para este restaurante.",
  payload_too_large: "Corpo da requisição grande demais (máximo 64 KB).",
  rate_limited: "Muitas requisições. Tente novamente em instantes.",
  captcha_failed: "Verificação anti-robô ausente ou inválida (campo captchaToken).",
  internal_error: "Erro interno. Tente novamente em instantes.",
};

/** Resposta de erro `{error:{code,message}}`; nunca cacheável. */
export function errorResponse(
  code: ApiErrorCode,
  status: number,
  options: {
    message?: string;
    headers?: Record<string, string>;
    details?: ApiErrorBody["error"]["details"];
    errors?: ApiErrorBody["error"]["errors"];
  } = {},
): Response {
  const body: ApiErrorBody = {
    error: {
      code,
      message: options.message ?? DEFAULT_MESSAGES[code],
      ...(options.details && options.details.length > 0 ? { details: options.details } : {}),
      ...(options.errors && options.errors.length > 0 ? { errors: options.errors } : {}),
    },
  };
  return jsonResponse(body, {
    status,
    headers: { "Cache-Control": "no-store", ...options.headers },
  });
}

/** Resposta ao preflight: 204 sem corpo. */
export function noContentResponse(headers: Record<string, string>): Response {
  return new Response(null, {
    status: 204,
    headers: { ...BASE_HEADERS, "Cache-Control": "no-store", ...headers },
  });
}

/** Slug da URL normalizado, ou null se não puder ser um slug válido (sem tocar no banco). */
export function parseSlug(raw: string): string | null {
  let value: string;
  try {
    value = decodeURIComponent(raw).trim().toLowerCase();
  } catch {
    return null;
  }
  return value.length >= 1 && value.length <= 63 && SLUG_PATTERN.test(value) ? value : null;
}

export class BodyTooLargeError extends Error {
  constructor() {
    super("body_too_large");
    this.name = "BodyTooLargeError";
  }
}

export class InvalidBodyError extends Error {
  constructor() {
    super("invalid_body");
    this.name = "InvalidBodyError";
  }
}

/**
 * Lê o corpo como texto UTF-8 respeitando o limite, inclusive sem
 * `Content-Length` (chunked): corta a leitura assim que passar de `maxBytes`.
 */
export async function readLimitedText(request: Request, maxBytes: number): Promise<string> {
  const declared = request.headers.get("content-length");
  if (declared !== null) {
    const n = Number(declared);
    if (Number.isFinite(n) && n > maxBytes) throw new BodyTooLargeError();
  }
  if (!request.body) return "";

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new BodyTooLargeError();
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new InvalidBodyError();
  }
}

export function isJsonContentType(header: string | null): boolean {
  if (!header) return false;
  const mime = header.split(";")[0].trim().toLowerCase();
  return mime === "application/json";
}
