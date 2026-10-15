/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Clientes supabase-js usados pelos testes.
 *
 *  - admin()      : service role. SÓ para fixtures e para verificar o estado real do banco.
 *  - anon()       : navegador sem login (chave anon).
 *  - as(account)  : navegador logado. O JWT vem de um signInWithPassword real (feito uma vez no
 *                   globalSetup, com cache para respeitar o rate limit do Auth local) e é enviado
 *                   no header Authorization — exatamente o que um browser faz contra PostgREST/RPC/
 *                   Storage/Realtime.
 *  - signInAs()   : faz um signInWithPassword real agora (usuários criados dentro de um teste).
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { inject } from "vitest";
import { loadEnv } from "../../scripts/lib/env";
import { createAdminClient } from "../../scripts/seed-dev";
import type { AccountKey } from "../fixtures/accounts";
import type { World } from "../fixtures/world";
import "./provided";

const clientOptions = { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } };

let adminSingleton: SupabaseClient | undefined;
export function admin(): SupabaseClient {
  return (adminSingleton ??= createAdminClient());
}

export function anon(): SupabaseClient {
  const env = loadEnv();
  return createClient(env.url, env.anonKey, clientOptions);
}

/** Cliente "navegador" com um JWT de usuário já emitido pelo Auth. */
export function withToken(accessToken: string): SupabaseClient {
  const env = loadEnv();
  return createClient(env.url, env.anonKey, {
    ...clientOptions,
    accessToken: async () => accessToken,
  });
}

/**
 * Cliente para Realtime: o canal precisa receber o JWT via realtime.setAuth (a opção `accessToken`
 * do supabase-js não é repassada ao WebSocket nesta versão). Os demais caminhos usam `as()`.
 */
export function realtimeAs(key: AccountKey | "anon"): SupabaseClient {
  const env = loadEnv();
  const c = createClient(env.url, env.anonKey, clientOptions);
  if (key !== "anon") c.realtime.setAuth(tokenOf(key));
  return c;
}

export function world(): World {
  return inject("world");
}

export function tokenOf(key: AccountKey): string {
  return inject("sessions")[key].accessToken;
}

const cache = new Map<AccountKey, SupabaseClient>();
export function as(key: AccountKey): SupabaseClient {
  let c = cache.get(key);
  if (!c) {
    c = withToken(tokenOf(key));
    cache.set(key, c);
  }
  return c;
}

export function userId(key: AccountKey): string {
  return world().users[key].id;
}

/** signInWithPassword real contra o Auth local; devolve cliente + token. */
export async function signInAs(email: string, password: string) {
  const env = loadEnv();
  const plain = createClient(env.url, env.anonKey, clientOptions);
  const { data, error } = await plain.auth.signInWithPassword({ email, password });
  if (error || !data.session) throw new Error(`signIn ${email}: ${error?.message}`);
  return { client: withToken(data.session.access_token), token: data.session.access_token, userId: data.user.id };
}

/** Chamada REST crua (sem supabase-js), como um atacante com curl. */
export async function rawRest(
  pathAndQuery: string,
  init: { method?: string; token?: string | null; apikey?: string; body?: unknown; headers?: Record<string, string> } = {},
) {
  const env = loadEnv();
  const headers: Record<string, string> = {
    apikey: init.apikey ?? env.anonKey,
    "Content-Type": "application/json",
    ...(init.headers ?? {}),
  };
  if (init.token !== null) headers.Authorization = `Bearer ${init.token ?? env.anonKey}`;
  const res = await fetch(`${env.url}${pathAndQuery}`, {
    method: init.method ?? "GET",
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }
  return { status: res.status, body: json };
}

export type { World };
