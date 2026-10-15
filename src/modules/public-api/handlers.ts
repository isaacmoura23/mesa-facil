import {
  corsResponseHeaders,
  decideCors,
  isDevOrigin,
  canonicalOrigin,
  preflightHeaders,
  type CorsDecision,
} from "./cors";
import {
  BodyTooLargeError,
  errorResponse,
  InvalidBodyError,
  isJsonContentType,
  jsonResponse,
  MAX_BODY_BYTES,
  MENU_CACHE_CONTROL,
  noContentResponse,
  parseSlug,
  readLimitedText,
} from "./http";
import { clientIp, type RateLimiter } from "./rate-limit";
import {
  normalizeMenu,
  normalizeQuote,
  quoteRequestSchema,
  toRpcItems,
  type NormalizeMenuOptions,
} from "./schemas";
import type { Fulfillment } from "./types";

/**
 * Orquestração dos handlers da API pública v1, sem dependência de Next nem de
 * Supabase: tudo que toca fora entra por `PublicApiDeps` (a fiação real está em
 * `server.ts`; os testes injetam dublês).
 */

export type QuoteRpcArgs = {
  fulfillment: Fulfillment;
  items: ReturnType<typeof toRpcItems>;
  zoneId: string | null;
};

export type PublicApiDeps = {
  /** JSON bruto de `public_menu`, ou null se o restaurante não existe/está inativo. */
  loadMenu(slug: string): Promise<unknown>;
  /** JSON bruto de `validate_cart`. */
  loadQuote(slug: string, args: QuoteRpcArgs): Promise<unknown>;
  /** Origens permitidas do restaurante (com cache). Lança em falha sem valor antigo. */
  loadOrigins(slug: string): Promise<string[]>;
  limiters: { menu: RateLimiter; quote: RateLimiter; global: RateLimiter };
  isDev(): boolean;
  imageUrl: NormalizeMenuOptions["imageUrl"];
  logError?(scope: string, error: unknown): void;
};

type Guarded =
  | { response: Response }
  | { response?: undefined; slug: string; corsHeaders: Record<string, string> };

const MENU_METHODS = ["GET", "OPTIONS"] as const;
const QUOTE_METHODS = ["POST", "OPTIONS"] as const;

export function createPublicApi(deps: PublicApiDeps) {
  const logError = deps.logError ?? ((scope, error) => console.error(`[public-api] ${scope}:`, error));

  const notFound = (headers?: Record<string, string>) =>
    errorResponse("restaurant_not_found", 404, { headers });
  const internalError = (headers?: Record<string, string>) =>
    errorResponse("internal_error", 500, { headers });

  /** Resolve o CORS sem consultar o banco quando não é necessário. */
  async function resolveCors(slug: string, originHeader: string | null): Promise<CorsDecision> {
    if (originHeader === null) return { type: "none" };
    const dev = deps.isDev();
    const canonical = canonicalOrigin(originHeader);
    if (canonical && dev && isDevOrigin(canonical)) return { type: "allowed", origin: canonical };
    if (!canonical) return { type: "denied" };
    const allowed = await deps.loadOrigins(slug);
    return decideCors(originHeader, allowed, { dev });
  }

  /** Slug -> limites -> CORS. Devolve a resposta de erro pronta ou o contexto. */
  async function guard(
    request: Request,
    rawSlug: string,
    bucket: "menu" | "quote",
  ): Promise<Guarded> {
    const slug = parseSlug(rawSlug);
    if (!slug) return { response: notFound() };

    const ip = clientIp(request.headers);
    const bySlug = deps.limiters[bucket].check(`${ip}|${slug}`);
    const global = deps.limiters.global.check(ip);
    const limited = !bySlug.allowed ? bySlug : !global.allowed ? global : null;

    let decision: CorsDecision;
    try {
      decision = await resolveCors(slug, request.headers.get("origin"));
    } catch (error) {
      logError("origins", error);
      return { response: internalError() };
    }
    if (decision.type === "denied") {
      return { response: errorResponse("origin_not_allowed", 403) };
    }
    const corsHeaders = decision.type === "allowed" ? corsResponseHeaders(decision.origin) : {};

    if (limited) {
      return {
        response: errorResponse("rate_limited", 429, {
          headers: { ...corsHeaders, "Retry-After": String(limited.retryAfterSeconds) },
        }),
      };
    }
    return { slug, corsHeaders };
  }

  async function menu(request: Request, rawSlug: string): Promise<Response> {
    const guarded = await guard(request, rawSlug, "menu");
    if (guarded.response) return guarded.response;
    const { slug, corsHeaders } = guarded;

    try {
      const raw = await deps.loadMenu(slug);
      if (raw === null || raw === undefined) return notFound(corsHeaders);
      if (typeof raw === "object" && Object.keys(raw as object).length === 0) {
        return notFound(corsHeaders);
      }
      const data = normalizeMenu(Array.isArray(raw) ? raw[0] : raw, { imageUrl: deps.imageUrl });
      if (!data) {
        logError("menu", new Error("public_menu devolveu um formato inesperado."));
        return internalError(corsHeaders);
      }
      return jsonResponse({ data }, { headers: { "Cache-Control": MENU_CACHE_CONTROL, ...corsHeaders } });
    } catch (error) {
      logError("menu", error);
      return internalError(corsHeaders);
    }
  }

  async function quote(request: Request, rawSlug: string): Promise<Response> {
    const guarded = await guard(request, rawSlug, "quote");
    if (guarded.response) return guarded.response;
    const { slug, corsHeaders } = guarded;

    if (!isJsonContentType(request.headers.get("content-type"))) {
      return errorResponse("invalid_request", 400, {
        message: "Envie o corpo em JSON com Content-Type: application/json.",
        headers: corsHeaders,
      });
    }

    let payload: unknown;
    try {
      payload = JSON.parse(await readLimitedText(request, MAX_BODY_BYTES));
    } catch (error) {
      if (error instanceof BodyTooLargeError) {
        return errorResponse("payload_too_large", 413, { headers: corsHeaders });
      }
      if (error instanceof InvalidBodyError || error instanceof SyntaxError) {
        return errorResponse("invalid_request", 400, {
          message: "O corpo não é um JSON válido.",
          headers: corsHeaders,
        });
      }
      logError("quote:body", error);
      return internalError(corsHeaders);
    }

    const parsed = quoteRequestSchema.safeParse(payload);
    if (!parsed.success) {
      return errorResponse("invalid_request", 400, {
        headers: corsHeaders,
        details: parsed.error.issues.slice(0, 10).map((issue) => ({
          path: issue.path.join("."),
          message: issue.message.slice(0, 200),
        })),
      });
    }
    const body = parsed.data;

    try {
      const raw = await deps.loadQuote(slug, {
        fulfillment: body.fulfillmentType,
        items: toRpcItems(body.items),
        zoneId: body.fulfillmentType === "DELIVERY" ? (body.deliveryZoneId ?? null) : null,
      });
      const data = normalizeQuote(Array.isArray(raw) ? raw[0] : raw);
      if (!data) {
        logError("quote", new Error("validate_cart devolveu um formato inesperado."));
        return internalError(corsHeaders);
      }
      return jsonResponse({ data }, { headers: { "Cache-Control": "no-store", ...corsHeaders } });
    } catch (error) {
      logError("quote", error);
      return internalError(corsHeaders);
    }
  }

  /** Preflight (OPTIONS) das duas rotas. */
  async function preflight(
    request: Request,
    rawSlug: string,
    methods: readonly string[],
  ): Promise<Response> {
    const slug = parseSlug(rawSlug);
    if (!slug) return notFound();

    const limit = deps.limiters.global.check(clientIp(request.headers));
    if (!limit.allowed) {
      return errorResponse("rate_limited", 429, {
        headers: { "Retry-After": String(limit.retryAfterSeconds) },
      });
    }

    let decision: CorsDecision;
    try {
      decision = await resolveCors(slug, request.headers.get("origin"));
    } catch (error) {
      logError("origins", error);
      return internalError();
    }
    if (decision.type === "denied") return errorResponse("origin_not_allowed", 403);
    if (decision.type === "none") return noContentResponse({ Allow: methods.join(", ") });
    return noContentResponse({
      Allow: methods.join(", "),
      ...preflightHeaders(decision.origin, methods),
    });
  }

  return {
    menu,
    quote,
    menuPreflight: (request: Request, slug: string) => preflight(request, slug, MENU_METHODS),
    quotePreflight: (request: Request, slug: string) => preflight(request, slug, QUOTE_METHODS),
  };
}

export type PublicApi = ReturnType<typeof createPublicApi>;
