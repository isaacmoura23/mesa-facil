import { isIP } from "node:net";

/**
 * Limitador de requisições por janela deslizante (log de timestamps) em memória.
 *
 * LIMITAÇÃO: o estado vive na instância do processo. Em serverless (Vercel) cada
 * instância tem o seu contador, então o limite efetivo é "por instância" e some
 * em cold start. Serve como freio contra abuso casual; para um limite global
 * troque por Upstash Redis / Vercel KV mantendo esta mesma interface.
 */

export type RateLimitResult = {
  allowed: boolean;
  limit: number;
  remaining: number;
  /** Segundos até liberar (>= 1 quando negado; 0 quando permitido). */
  retryAfterSeconds: number;
};

export type RateLimiter = {
  check(key: string): RateLimitResult;
  /** Devolve a ÚLTIMA tentativa registrada da chave (ex.: o pedido acabou não sendo criado). */
  refund(key: string): void;
  size(): number;
};

export type RateLimiterOptions = {
  limit: number;
  windowMs: number;
  /** Teto de chaves rastreadas (descarta as mais antigas). */
  maxKeys?: number;
  now?: () => number;
};

export function createRateLimiter(options: RateLimiterOptions): RateLimiter {
  const { limit, windowMs } = options;
  const maxKeys = options.maxKeys ?? 10_000;
  const now = options.now ?? Date.now;
  const hitsByKey = new Map<string, number[]>();

  const sweep = (ts: number) => {
    for (const [key, hits] of hitsByKey) {
      if (hits.length === 0 || hits[hits.length - 1] <= ts - windowMs) hitsByKey.delete(key);
    }
    // Ainda acima do teto: descarta as chaves usadas há mais tempo.
    while (hitsByKey.size > maxKeys) {
      const oldest = hitsByKey.keys().next().value;
      if (oldest === undefined) break;
      hitsByKey.delete(oldest);
    }
  };

  return {
    size: () => hitsByKey.size,
    refund(key) {
      const hits = hitsByKey.get(key);
      if (!hits) return;
      hits.pop();
      if (hits.length === 0) hitsByKey.delete(key);
    },
    check(key) {
      const ts = now();
      const cutoff = ts - windowMs;
      const previous = hitsByKey.get(key) ?? [];
      let start = 0;
      while (start < previous.length && previous[start] <= cutoff) start += 1;
      const hits = start > 0 ? previous.slice(start) : previous;

      if (hits.length >= limit) {
        // Tentativas negadas não entram no log (não prolongam o bloqueio).
        hitsByKey.delete(key);
        hitsByKey.set(key, hits);
        return {
          allowed: false,
          limit,
          remaining: 0,
          retryAfterSeconds: Math.max(1, Math.ceil((hits[0] + windowMs - ts) / 1000)),
        };
      }

      hits.push(ts);
      hitsByKey.delete(key);
      hitsByKey.set(key, hits); // reinserir mantém a ordem "mais recente por último"
      if (hitsByKey.size > maxKeys) sweep(ts);
      return { allowed: true, limit, remaining: limit - hits.length, retryAfterSeconds: 0 };
    },
  };
}

// ---------------------------------------------------------------------------
// IP do cliente
// ---------------------------------------------------------------------------

const V4_MAPPED = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i;

/** Agrupa IPv6 pelo prefixo /64 (um cliente controla um /64 inteiro). */
function ipv6Prefix64(ip: string): string {
  const [head, tail] = ip.toLowerCase().split("::");
  const headGroups = head ? head.split(":") : [];
  const tailGroups = tail !== undefined && tail ? tail.split(":") : [];
  const missing = tail === undefined ? 0 : 8 - headGroups.length - tailGroups.length;
  const groups = [...headGroups, ...Array<string>(Math.max(0, missing)).fill("0"), ...tailGroups];
  return `${groups
    .slice(0, 4)
    .map((g) => g.replace(/^0+(?=.)/, ""))
    .join(":")}::/64`;
}

function normalizeIp(raw: string | undefined | null): string | null {
  const value = raw?.trim();
  if (!value || value.length > 64) return null;
  const mapped = V4_MAPPED.exec(value);
  const candidate = mapped ? mapped[1] : value;
  const version = isIP(candidate);
  if (version === 4) return candidate;
  if (version === 6) return ipv6Prefix64(candidate);
  return null;
}

/**
 * IP do cliente para o limitador: PRIMEIRO valor de `x-forwarded-for` (o proxy
 * da plataforma, ex. Vercel, define/sobrescreve esse cabeçalho), depois
 * `x-real-ip`. Valores que não sejam IP válido são ignorados. Fora de uma
 * plataforma confiável o cabeçalho pode ser forjado: coloque um proxy na frente.
 */
export function clientIp(headers: Headers): string {
  const forwarded = normalizeIp(headers.get("x-forwarded-for")?.split(",")[0]);
  if (forwarded) return forwarded;
  const real = normalizeIp(headers.get("x-real-ip"));
  return real ?? "unknown";
}
