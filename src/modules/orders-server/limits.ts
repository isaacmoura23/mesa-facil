import {
  createRateLimiter,
  type RateLimiter,
  type RateLimitResult,
} from "@/modules/public-api/rate-limit";

/**
 * Limites de pedidos por IP + slug, compartilhados pela Server Action da
 * vitrine e pela API pública (mesmo contador por processo). Mesma limitação do
 * restante da API: o estado vive na instância (ver rate-limit.ts).
 */

export const ORDER_LIMIT = 5;
export const ORDER_WINDOW_MS = 10 * 60_000;
/** Teto de TENTATIVAS (inclusive as recusadas), para frear abuso sem punir quem corrige o carrinho. */
export const ATTEMPT_LIMIT = 30;
export const TRACK_LIMIT = 60;
export const TRACK_WINDOW_MS = 60_000;

type Store = { attempts: RateLimiter; orders: RateLimiter; track: RateLimiter };
const globalStore = globalThis as typeof globalThis & { __mesafacilOrderLimitsV2?: Store };

export function getOrderLimiters(): Store {
  globalStore.__mesafacilOrderLimitsV2 ??= {
    attempts: createRateLimiter({ limit: ATTEMPT_LIMIT, windowMs: ORDER_WINDOW_MS }),
    orders: createRateLimiter({ limit: ORDER_LIMIT, windowMs: ORDER_WINDOW_MS }),
    track: createRateLimiter({ limit: TRACK_LIMIT, windowMs: TRACK_WINDOW_MS }),
  };
  return globalStore.__mesafacilOrderLimitsV2;
}

export type OrderAttempt =
  | { allowed: true; /** Chame ao terminar: só pedidos CRIADOS contam no limite de 5/10 min. */ finish(created: boolean): void }
  | { allowed: false; retryAfterSeconds: number };

/**
 * Abre uma tentativa de pedido. Limite estrito: 5 pedidos CRIADOS / 10 min por IP+slug (tentativas
 * recusadas por regra de negócio, dados inválidos ou repetidas por idempotência são devolvidas).
 * Limite de abuso: 30 tentativas / 10 min, sem devolução.
 */
export function beginOrderAttempt(ip: string, slug: string): OrderAttempt {
  const { attempts, orders } = getOrderLimiters();
  const key = `${ip}|${slug}`;
  const a = attempts.check(key);
  if (!a.allowed) return { allowed: false, retryAfterSeconds: a.retryAfterSeconds };
  const o: RateLimitResult = orders.check(key);
  if (!o.allowed) return { allowed: false, retryAfterSeconds: o.retryAfterSeconds };
  return { allowed: true, finish: (created) => (created ? undefined : orders.refund(key)) };
}

export function checkTrackRateLimit(ip: string, slug: string): RateLimitResult {
  return getOrderLimiters().track.check(`${ip}|${slug}`);
}
