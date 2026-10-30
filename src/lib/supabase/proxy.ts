import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { getPublicEnvStatus } from "@/lib/env";
import { sanitizeNext } from "@/lib/utils/safe-redirect";

/** Prefixos que exigem sessão. A autorização fina é feita nos guards do servidor. */
const PROTECTED_PREFIXES = ["/operacao", "/app", "/platform", "/entrar", "/conta"] as const;
const AUTH_PAGES = ["/login", "/cadastro"] as const;

function matchesPrefix(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

/**
 * Atualiza a sessão do Supabase (refresh de token via cookies) e aplica o
 * redirecionamento otimista de usuários não autenticados. Isto NÃO substitui
 * os guards de servidor (`src/lib/auth/guards.ts`), que continuam obrigatórios.
 */
export async function updateSession(request: NextRequest): Promise<NextResponse> {
  const status = getPublicEnvStatus();
  if (!status.ok) {
    // Sem Supabase configurado: as páginas exibem a tela de configuração.
    return NextResponse.next({ request });
  }

  let response = NextResponse.next({ request });
  let cacheHeaders: Record<string, string> = {};

  const supabase = createServerClient(
    status.env.supabaseUrl,
    status.env.supabaseAnonKey,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet, headers) {
          for (const { name, value } of cookiesToSet) {
            request.cookies.set(name, value);
          }
          response = NextResponse.next({ request });
          cacheHeaders = { ...cacheHeaders, ...headers };
          for (const { name, value, options } of cookiesToSet) {
            response.cookies.set(name, value, options);
          }
          for (const [key, value] of Object.entries(cacheHeaders)) {
            response.headers.set(key, value);
          }
        },
      },
    },
  );

  // getClaims valida a assinatura do JWT (não confia apenas no cookie).
  // Não coloque lógica entre createServerClient e getClaims.
  const { data } = await supabase.auth.getClaims();
  const isAuthenticated = Boolean(data?.claims?.sub);
  const { pathname, search } = request.nextUrl;

  const redirectTo = (target: URL): NextResponse => {
    const redirect = NextResponse.redirect(target);
    // Preserva cookies de sessão renovados e os headers anti-cache.
    for (const cookie of response.cookies.getAll()) {
      redirect.cookies.set(cookie);
    }
    for (const [key, value] of Object.entries(cacheHeaders)) {
      redirect.headers.set(key, value);
    }
    return redirect;
  };

  if (
    !isAuthenticated &&
    PROTECTED_PREFIXES.some((prefix) => matchesPrefix(pathname, prefix))
  ) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    url.search = "";
    const next = sanitizeNext(`${pathname}${search}`);
    if (next && pathname !== "/entrar") url.searchParams.set("next", next);
    return redirectTo(url);
  }

  if (isAuthenticated && AUTH_PAGES.some((page) => pathname === page)) {
    const url = request.nextUrl.clone();
    const next = sanitizeNext(request.nextUrl.searchParams.get("next"));
    const target = new URL(next ?? "/entrar", request.nextUrl.origin);
    url.pathname = target.pathname;
    url.search = target.search;
    return redirectTo(url);
  }

  return response;
}
