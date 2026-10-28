import "server-only";
import { headers } from "next/headers";
import { checkLimit, clientIp, createRateLimiter, type RateLimiter } from "@/modules/public-api/rate-limit";

/**
 * Limites das ações PÚBLICAS de autenticação (cadastro, recuperação de senha) e do convite de equipe.
 * Contador compartilhado no Upstash quando configurado; senão memória da instância.
 */

const HOUR = 60 * 60_000;

type Kind = "signup" | "forgot-ip" | "forgot-email" | "invite";

const LIMITS: Record<Kind, { limit: number; windowMs: number }> = {
  signup: { limit: 8, windowMs: HOUR },
  "forgot-ip": { limit: 6, windowMs: HOUR },
  "forgot-email": { limit: 3, windowMs: HOUR },
  invite: { limit: 30, windowMs: HOUR },
};

const store = globalThis as typeof globalThis & { __mesafacilAuthLimits?: Record<Kind, RateLimiter> };

function limiter(kind: Kind): RateLimiter {
  store.__mesafacilAuthLimits ??= {
    signup: createRateLimiter({ ...LIMITS.signup, name: "auth-signup" }),
    "forgot-ip": createRateLimiter({ ...LIMITS["forgot-ip"], name: "auth-forgot-ip" }),
    "forgot-email": createRateLimiter({ ...LIMITS["forgot-email"], name: "auth-forgot-email" }),
    invite: createRateLimiter({ ...LIMITS.invite, name: "team-invite" }),
  };
  return store.__mesafacilAuthLimits[kind];
}

/** `true` = pode seguir. */
export async function allowAuthAction(kind: Kind, key: string): Promise<boolean> {
  return (await checkLimit(limiter(kind), key)).allowed;
}

/** IP confiável da requisição atual (ver `clientIp`). */
export async function currentClientIp(): Promise<string> {
  return clientIp(await headers());
}
