import "server-only";
import { createClient } from "@supabase/supabase-js";
import { requirePublicEnv } from "@/lib/env";
import { getServiceRoleKey } from "@/lib/env.server";
import type { AppSupabaseClient } from "./types";

/**
 * Cliente com service role: IGNORA RLS. Uso restrito a rotinas de servidor
 * que já verificaram a autorização do chamador (ex.: `requirePlatformAdmin`).
 * Nesta fase nenhuma rota o utiliza.
 */
export function createAdminClient(): AppSupabaseClient {
  const env = requirePublicEnv();
  return createClient(env.supabaseUrl, getServiceRoleKey(), {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });
}
