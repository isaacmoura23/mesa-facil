import { isIP } from "node:net";
import { upstashConfig, upstashDecr, upstashIncr, warnIfMemoryOnly } from "./upstash";

/**
 * Limitador de requisições por janela deslizante (log de timestamps) em memória.
 *
 * `check`/`refund` (síncronos) usam SÓ a memória da instância. `checkAsync`/`refundAsync` usam o Upstash Redis
 * (contador atômico compartilhado, via REST) quando UPSTASH_REDIS_REST_URL/TOKEN existem e o limitador tem `name`;
 * sem chaves, ou se o Redis falhar, caem na memória. O app (rotas, Server Actions) usa `checkLimit`/`refundLimit`.
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
  /** Como `check`, mas compartilhado entre instâncias quando o Upstash está configurado. */
  checkAsync?(key: string): Promise<RateLimitResult>;
  /** Devolve a ÚLTIMA tentativa registrada da chave (ex.: o pedido acabou não sendo criado). */
  refund(key: string): void;
  refundAsync?(key: string): Promise<void>;
  size(): number;
};

/** Usa a versão assíncrona (Upstash) quando existir; dublês de teste só têm `check`. */
export async function checkLimit(limiter: RateLimiter, key: string): Promise<RateLimitResult> {
  return limiter.checkAsync ? limiter.checkAsync(key) : limiter.check(key);
}

export async function refundLimit(limiter: RateLimiter, key: string): Promise<void> {
  if (limiter.refundAsync) await limiter.refundAsync(key);
  else limiter.refund(key);
}

export type RateLimiterOptions = {
  limit: number;
  windowMs: number;
  /** Teto de chaves rastreadas (descarta as mais antigas). */
  maxKeys?: number;
  now?: () => number;
  /** Nome estável do balde no Redis (ex.: "api-menu"). Sem nome, o limitador nunca usa o Upstash. */
  name?: string;
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

  const redisKey = (key: string) => `rl:${options.name}:${key}`;

  const limiter: RateLimiter = {
    size: () => hitsByKey.size,
    async checkAsync(key) {
      if (!options.name || !upstashConfig()) return limiter.check(key);
      const counted = await upstashIncr(redisKey(key), windowMs);
      if (!counted) return limiter.check(key); // Redis fora do ar: degrada para a memória
      if (counted.count > limit) {
        // Tentativa negada não conta (não prolonga o bloqueio).
        void upstashDecr(redisKey(key));
        return { allowed: false, limit, remaining: 0, retryAfterSeconds: Math.max(1, Math.ceil(counted.ttlMs / 1000)) };
      }
      return { allowed: true, limit, remaining: Math.max(0, limit - counted.count), retryAfterSeconds: 0 };
    },
    async refundAsync(key) {
      if (options.name && upstashConfig()) await upstashDecr(redisKey(key));
      limiter.refund(key);
    },
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
  warnIfMemoryOnly();
  return limiter;
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
 * IP do cliente para o limitador. NUNCA confia num valor livre do cliente como identidade única:
 *
 * 1. Na Vercel (`VERCEL=1`) a plataforma sobrescreve `x-real-ip` e `x-vercel-forwarded-for`: usa-os
 *    (e ignora `x-forwarded-for`, cujo início o cliente pode preencher).
 * 2. Fora dela, só atrás de um proxy confiável declarado em `TRUSTED_PROXY_HOPS` (nº de proxies SEUS na frente
 *    do app): usa o valor de `x-forwarded-for` contado a partir da DIREITA (o que o seu primeiro proxy viu).
 *    Com `TRUSTED_PROXY_HOPS=1` é o último valor da lista.
 * 3. Sem nenhuma das duas: em produção os cabeçalhos são ignorados (balde único "unknown": mais restritivo,
 *    porém seguro) e em desenvolvimento/teste vale o comportamento antigo (1º `x-forwarded-for`, depois
 *    `x-real-ip`), já que não há proxy nem atacante.
 */
export function clientIp(headers: Headers, env: Record<string, string | undefined> = process.env): string {
  if (env.VERCEL === "1" || env.VERCEL === "true") {
    return (
      normalizeIp(headers.get("x-real-ip")) ??
      normalizeIp(headers.get("x-vercel-forwarded-for")?.split(",")[0]) ??
      "unknown"
    );
  }

  const hops = Number.parseInt(env.TRUSTED_PROXY_HOPS ?? "", 10);
  if (Number.isInteger(hops) && hops >= 1 && hops <= 10) {
    const list = (headers.get("x-forwarded-for") ?? "").split(",").map((part) => part.trim());
    return normalizeIp(list[list.length - hops]) ?? "unknown";
  }

  if (env.NODE_ENV === "production") return "unknown";

  const forwarded = normalizeIp(headers.get("x-forwarded-for")?.split(",")[0]);
  if (forwarded) return forwarded;
  return normalizeIp(headers.get("x-real-ip")) ?? "unknown";
}
