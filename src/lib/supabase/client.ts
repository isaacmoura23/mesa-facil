import { createBrowserClient } from "@supabase/ssr";
import { requirePublicEnv } from "@/lib/env";
import type { AppSupabaseClient } from "./types";

/**
 * Cliente do navegador (usa apenas a chave anon, protegida por RLS).
 * Nunca importe `admin.ts` ou `env.server.ts` em código do cliente.
 */
export function createClient(): AppSupabaseClient {
  const env = requirePublicEnv();
  return createBrowserClient(env.supabaseUrl, env.supabaseAnonKey);
}
