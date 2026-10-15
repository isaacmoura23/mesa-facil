/**
 * CORS por restaurante. Regras (contrato Etapa 2.5):
 * - origem EXATA (esquema + host + porta), https, sem curingas, sem credentials;
 * - em desenvolvimento, também http(s)://localhost[:porta] e 127.0.0.1[:porta];
 * - requisição sem `Origin` (servidor a servidor, curl) passa sem cabeçalhos CORS;
 * - `Origin` presente e não permitida => negada (a rota responde 403, sem dados).
 */

export const PREFLIGHT_MAX_AGE_SECONDS = 600;
export const ALLOWED_REQUEST_HEADERS = "Content-Type, Accept";

const HOST_PATTERN = /^[a-z0-9]+(?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9]+(?:[a-z0-9-]*[a-z0-9])?)*$/;

/**
 * Forma canônica de uma origem ("https://exemplo.com" ou com porta), ou null.
 * Exige que o texto JÁ esteja canônico (sem barra final, caminho, query,
 * credenciais, curingas ou espaços), então "https://a.com/" é inválido.
 */
export function canonicalOrigin(raw: string | null | undefined): string | null {
  if (!raw || raw.length > 255 || raw !== raw.trim() || raw.includes("*")) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (url.username || url.password || url.search || url.hash) return null;
  if (url.pathname !== "/") return null;
  const origin = url.origin; // minúsculo, sem porta padrão
  if (origin !== raw.toLowerCase()) return null;
  return origin;
}

/** Origem de lista permitida: só https, hostname válido (sem IP de loopback, sem curinga). */
export function normalizeAllowedOrigin(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const origin = canonicalOrigin(raw);
  if (!origin || !origin.startsWith("https://")) return null;
  const host = new URL(origin).hostname;
  return HOST_PATTERN.test(host) ? origin : null;
}

/** http(s)://localhost[:porta] ou 127.0.0.1[:porta] (somente fora de produção). */
export function isDevOrigin(origin: string): boolean {
  const canonical = canonicalOrigin(origin);
  if (!canonical) return false;
  const { hostname } = new URL(canonical);
  return hostname === "localhost" || hostname === "127.0.0.1";
}

export type CorsDecision =
  | { type: "none" }
  | { type: "allowed"; origin: string }
  | { type: "denied" };

/**
 * Decide o CORS de uma requisição. `originHeader === null` => sem Origin.
 * `allowed` é a lista do restaurante (já normalizada ou não: é revalidada).
 */
export function decideCors(
  originHeader: string | null,
  allowed: readonly string[],
  opts: { dev: boolean },
): CorsDecision {
  if (originHeader === null) return { type: "none" };
  const origin = canonicalOrigin(originHeader);
  if (!origin) return { type: "denied" };
  if (opts.dev && isDevOrigin(origin)) return { type: "allowed", origin };
  for (const entry of allowed) {
    if (normalizeAllowedOrigin(entry) === origin) return { type: "allowed", origin };
  }
  return { type: "denied" };
}

/** Cabeçalhos para uma resposta (não preflight) a uma origem permitida. */
export function corsResponseHeaders(origin: string): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": origin,
    // Permite ao navegador ler Retry-After nos 429.
    "Access-Control-Expose-Headers": "Retry-After",
  };
}

/** Cabeçalhos do preflight (204) a uma origem permitida. */
export function preflightHeaders(origin: string, methods: readonly string[]): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": methods.join(", "),
    "Access-Control-Allow-Headers": ALLOWED_REQUEST_HEADERS,
    "Access-Control-Max-Age": String(PREFLIGHT_MAX_AGE_SECONDS),
  };
}

// ---------------------------------------------------------------------------
// Cache em memória (por instância) da lista de origens por slug
// ---------------------------------------------------------------------------

export type OriginsCacheOptions = {
  fetchOrigins: (slug: string) => Promise<string[]>;
  ttlMs?: number;
  maxEntries?: number;
  now?: () => number;
};

export type OriginsCache = {
  get(slug: string): Promise<string[]>;
  size(): number;
};

/**
 * Cache TTL (padrão 60 s) com coalescência de buscas simultâneas. Se a busca
 * falhar e houver valor antigo, serve o antigo (fail-stale); sem valor, repassa
 * o erro (a rota responde 500: nunca libera origem por falha).
 */
export function createOriginsCache(options: OriginsCacheOptions): OriginsCache {
  const ttlMs = options.ttlMs ?? 60_000;
  const maxEntries = options.maxEntries ?? 500;
  const now = options.now ?? Date.now;
  const entries = new Map<string, { origins: string[]; expiresAt: number }>();
  const inflight = new Map<string, Promise<string[]>>();

  const store = (slug: string, origins: string[]) => {
    entries.delete(slug);
    entries.set(slug, { origins, expiresAt: now() + ttlMs });
    while (entries.size > maxEntries) {
      const oldest = entries.keys().next().value;
      if (oldest === undefined) break;
      entries.delete(oldest);
    }
  };

  return {
    size: () => entries.size,
    async get(slug) {
      const hit = entries.get(slug);
      if (hit && hit.expiresAt > now()) return hit.origins;

      const pending = inflight.get(slug);
      if (pending) return pending;

      const promise = (async () => {
        try {
          const origins = (await options.fetchOrigins(slug))
            .map(normalizeAllowedOrigin)
            .filter((o): o is string => o !== null);
          store(slug, origins);
          return origins;
        } catch (error) {
          if (hit) return hit.origins;
          throw error;
        } finally {
          inflight.delete(slug);
        }
      })();
      inflight.set(slug, promise);
      return promise;
    },
  };
}
