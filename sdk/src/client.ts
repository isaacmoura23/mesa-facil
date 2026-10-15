import type { Menu, Quote, QuoteInput, StorefrontErrorCode } from "./types.js";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export type StorefrontClientOptions = {
  /** Origem do SaaS, ex.: "https://app.mesafacil.com.br" (sem barra final). */
  baseUrl: string;
  /** Slug do restaurante, ex.: "la-pastelaria". */
  slug: string;
  /** `fetch` customizado (testes, `next: { revalidate }` no Next, polyfill). */
  fetch?: FetchLike;
  /** Tempo máximo por requisição. Padrão 10000 ms. */
  timeoutMs?: number;
};

export type RequestOptions = {
  /** Cancela a requisição (vira `StorefrontApiError` com code "aborted"). */
  signal?: AbortSignal;
};

/** Erro tipado de qualquer falha da API ou de rede. */
export class StorefrontApiError extends Error {
  readonly code: StorefrontErrorCode;
  /** Status HTTP; 0 para falhas locais (rede, timeout, cancelamento). */
  readonly status: number;
  /** Segundos sugeridos de espera (em 429). */
  readonly retryAfterSeconds: number | null;
  /** Detalhes de validação (400), quando houver. */
  readonly details: { path: string; message: string }[] | null;

  constructor(
    code: StorefrontErrorCode,
    status: number,
    message: string,
    extra: {
      retryAfterSeconds?: number | null;
      details?: { path: string; message: string }[] | null;
    } = {},
  ) {
    super(message);
    this.name = "StorefrontApiError";
    this.code = code;
    this.status = status;
    this.retryAfterSeconds = extra.retryAfterSeconds ?? null;
    this.details = extra.details ?? null;
  }
}

export type StorefrontClient = {
  getMenu(options?: RequestOptions): Promise<Menu>;
  quoteCart(input: QuoteInput, options?: RequestOptions): Promise<Quote>;
};

const DEFAULT_TIMEOUT_MS = 10_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseDetails(value: unknown): { path: string; message: string }[] | null {
  if (!Array.isArray(value)) return null;
  const out: { path: string; message: string }[] = [];
  for (const item of value) {
    if (isRecord(item) && typeof item.path === "string" && typeof item.message === "string") {
      out.push({ path: item.path, message: item.message });
    }
  }
  return out.length > 0 ? out : null;
}

export function createStorefrontClient(options: StorefrontClientOptions): StorefrontClient {
  const baseUrl = options.baseUrl.trim().replace(/\/+$/, "");
  const slug = options.slug.trim();
  if (!baseUrl) throw new Error("createStorefrontClient: baseUrl é obrigatório.");
  if (!slug) throw new Error("createStorefrontClient: slug é obrigatório.");
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const root = `${baseUrl}/api/public/v1/restaurants/${encodeURIComponent(slug)}`;

  const doFetch: FetchLike = (input, init) => {
    if (options.fetch) return options.fetch(input, init);
    return globalThis.fetch(input, init);
  };

  async function request<T>(
    path: string,
    init: { method: "GET" | "POST"; body?: unknown },
    callOptions: RequestOptions | undefined,
  ): Promise<T> {
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    const external = callOptions?.signal;
    const onExternalAbort = () => controller.abort();
    if (external) {
      if (external.aborted) controller.abort();
      else external.addEventListener("abort", onExternalAbort, { once: true });
    }

    try {
      let response: Response;
      try {
        response = await doFetch(`${root}${path}`, {
          method: init.method,
          // GET "simples" (só Accept): o menu não dispara preflight CORS.
          headers:
            init.body === undefined
              ? { Accept: "application/json" }
              : { Accept: "application/json", "Content-Type": "application/json" },
          body: init.body === undefined ? undefined : JSON.stringify(init.body),
          signal: controller.signal,
        });
      } catch (cause) {
        if (timedOut) {
          throw new StorefrontApiError("timeout", 0, "A requisição excedeu o tempo limite.");
        }
        if (external?.aborted || (cause instanceof Error && cause.name === "AbortError")) {
          throw new StorefrontApiError("aborted", 0, "A requisição foi cancelada.");
        }
        throw new StorefrontApiError(
          "network_error",
          0,
          "Não foi possível conectar à API. Verifique a conexão e a origem permitida (CORS).",
        );
      }

      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        if (timedOut) {
          throw new StorefrontApiError("timeout", 0, "A requisição excedeu o tempo limite.");
        }
        throw new StorefrontApiError(
          response.ok ? "invalid_response" : "internal_error",
          response.status,
          "Resposta inesperada da API.",
        );
      }

      if (!response.ok) {
        const error = isRecord(payload) && isRecord(payload.error) ? payload.error : null;
        const retryHeader = Number(response.headers.get("retry-after"));
        throw new StorefrontApiError(
          typeof error?.code === "string" ? error.code : "internal_error",
          response.status,
          typeof error?.message === "string" ? error.message : "Erro na API.",
          {
            retryAfterSeconds: Number.isFinite(retryHeader) && retryHeader > 0 ? retryHeader : null,
            details: parseDetails(error?.details),
          },
        );
      }

      if (!isRecord(payload) || !("data" in payload)) {
        throw new StorefrontApiError("invalid_response", response.status, "Resposta inesperada da API.");
      }
      return payload.data as T;
    } finally {
      clearTimeout(timer);
      external?.removeEventListener("abort", onExternalAbort);
    }
  }

  return {
    getMenu: (callOptions) => request<Menu>("/menu", { method: "GET" }, callOptions),
    quoteCart: (input, callOptions) =>
      request<Quote>("/cart/quote", { method: "POST", body: input }, callOptions),
  };
}
