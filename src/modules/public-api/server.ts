import "server-only";
import { publicImageUrl } from "@/lib/storage";
import { createOriginsCache, type OriginsCache } from "./cors";
import { fetchMenuRaw, fetchQuoteRaw, fetchStorefrontOrigins } from "./data";
import { createPublicApi, type PublicApi } from "./handlers";
import { createRateLimiter, type RateLimiter } from "./rate-limit";

/** Limites por IP (janela deslizante de 1 minuto). */
export const RATE_LIMITS = {
  /** GET menu, por IP + slug. */
  menu: 120,
  /** POST quote, por IP + slug. */
  quote: 60,
  /** Todas as rotas/slugs juntos, por IP (freia varredura de slugs). */
  global: 600,
} as const;

type Singleton = {
  api: PublicApi;
  limiters: { menu: RateLimiter; quote: RateLimiter; global: RateLimiter };
  origins: OriginsCache;
};

/**
 * Um único conjunto de contadores/cache por processo (sobrevive ao HMR em dev e
 * é compartilhado entre as rotas menu e quote quando estão na mesma instância).
 */
const globalStore = globalThis as typeof globalThis & { __mesafacilPublicApi?: Singleton };

function build(): Singleton {
  const windowMs = 60_000;
  const limiters = {
    menu: createRateLimiter({ limit: RATE_LIMITS.menu, windowMs }),
    quote: createRateLimiter({ limit: RATE_LIMITS.quote, windowMs }),
    global: createRateLimiter({ limit: RATE_LIMITS.global, windowMs }),
  };
  const origins = createOriginsCache({ fetchOrigins: fetchStorefrontOrigins, ttlMs: 60_000 });
  const api = createPublicApi({
    loadMenu: fetchMenuRaw,
    loadQuote: fetchQuoteRaw,
    loadOrigins: (slug) => origins.get(slug),
    limiters,
    isDev: () => process.env.NODE_ENV !== "production",
    imageUrl: publicImageUrl,
  });
  return { api, limiters, origins };
}

export function getPublicApi(): PublicApi {
  globalStore.__mesafacilPublicApi ??= build();
  return globalStore.__mesafacilPublicApi.api;
}
