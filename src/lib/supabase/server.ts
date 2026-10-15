import "server-only";
import { cookies } from "next/headers";
import { connection } from "next/server";
import { createServerClient } from "@supabase/ssr";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { requirePublicEnv } from "@/lib/env";
import type { AppSupabaseClient } from "./types";

/**
 * Cliente por requisição, com a sessão do usuário (cookies). Crie um novo a
 * cada uso: nunca compartilhe entre requisições.
 *
 * `cookies()` é assíncrono no Next 16 e só pode ser lido em runtime, então
 * qualquer componente que chame isto precisa estar dentro de <Suspense>
 * (Cache Components).
 */
export async function createClient(): Promise<AppSupabaseClient> {
  // Ler os cookies primeiro: durante o prerender isto marca a rota como
  // dinâmica (adia a renderização) em vez de falhar por falta de variáveis.
  const cookieStore = await cookies();
  // O cliente de auth compara a expiração do JWT com Date.now(): garante que
  // isso só rode em tempo de requisição, nunca durante o prerender.
  await connection();
  const env = requirePublicEnv();

  return createServerClient(env.supabaseUrl, env.supabaseAnonKey, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          for (const { name, value, options } of cookiesToSet) {
            cookieStore.set(name, value, options);
          }
        } catch {
          // Chamado a partir de um Server Component: não é possível gravar
          // cookies aqui. O refresh da sessão é feito em src/proxy.ts.
        }
      },
    },
  });
}

/**
 * Cliente anônimo, sem cookies e sem sessão. Para dados públicos (ex.: cardápio
 * público via RPC `resolve_restaurant_by_slug`). Ainda sujeito a RLS/GRANTs.
 */
export function createPublicClient(): AppSupabaseClient {
  const env = requirePublicEnv();
  return createSupabaseClient(env.supabaseUrl, env.supabaseAnonKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });
}
