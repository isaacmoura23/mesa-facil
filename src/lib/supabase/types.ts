import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * PONTO DE INTEGRAÇÃO com os tipos gerados do banco.
 *
 * Quando `supabase gen types typescript --local > src/lib/supabase/database.types.ts`
 * for executado, troque a definição abaixo por:
 *
 *   import type { Database } from "./database.types";
 *   export type AppSupabaseClient = SupabaseClient<Database>;
 *
 * e passe `<Database>` nos `createClient`/`createServerClient`/`createBrowserClient`.
 * Enquanto isso, as respostas das RPCs são validadas com zod em
 * `src/lib/auth/rpc.ts` (tipos manuais em `src/lib/auth/types.ts`).
 */
export type AppSupabaseClient = SupabaseClient;
