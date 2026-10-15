import type { NextRequest } from "next/server";
import { updateSession } from "@/lib/supabase/proxy";

/**
 * Next.js 16: o antigo `middleware.ts` agora se chama `proxy.ts` (runtime
 * Node.js). Roda antes das rotas para renovar a sessão do Supabase e
 * redirecionar visitantes não autenticados.
 */
export async function proxy(request: NextRequest) {
  return updateSession(request);
}

export const config = {
  matcher: [
    // Ignora arquivos estáticos, otimização de imagens, metadados e a API pública
    // (sem sessão; evita latência extra de renovação de cookies nas vitrines).
    "/((?!api/public|_next/static|_next/image|favicon.ico|.*\.(?:svg|png|jpg|jpeg|gif|webp|ico|txt|xml|woff2?)$).*)",
  ],
};
