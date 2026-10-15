/**
 * globalSetup dos testes de integração:
 *  1. verifica que o Supabase LOCAL está de pé (e que é local);
 *  2. roda o seed idempotente (estado base conhecido);
 *  3. faz signInWithPassword real de cada conta de teste (com cache em node_modules/.cache para
 *     não estourar o rate limit de sign-in do Auth local: 30 / 5 min / IP);
 *  4. expõe `world` e `sessions` aos testes via `inject()`.
 */
import { createClient } from "@supabase/supabase-js";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { assertLocalUrl, loadEnv, projectRoot } from "../../scripts/lib/env";
import { seedDev } from "../../scripts/seed-dev";
import { ACCOUNTS, ACCOUNT_KEYS, TEST_PASSWORD, type AccountKey } from "../fixtures/accounts";
import type { SessionMap, SessionTokens, World } from "../fixtures/world";
import "../helpers/provided";

interface ProvideApi {
  provide: (key: "world" | "sessions", value: unknown) => void;
}

const CACHE_FILE = path.join(projectRoot(), "node_modules", ".cache", "mesa-facil-tests", "sessions.json");

function readCache(): { url: string; sessions: Partial<SessionMap> } {
  try {
    if (existsSync(CACHE_FILE)) return JSON.parse(readFileSync(CACHE_FILE, "utf8"));
  } catch {
    /* cache corrompido: ignora */
  }
  return { url: "", sessions: {} };
}

function writeCache(url: string, sessions: SessionMap) {
  try {
    mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
    writeFileSync(CACHE_FILE, JSON.stringify({ url, sessions }));
  } catch {
    /* cache é só otimização */
  }
}

async function assertSupabaseUp(url: string, anonKey: string) {
  const probes = [`${url}/auth/v1/health`, `${url}/rest/v1/`];
  for (const probe of probes) {
    try {
      const res = await fetch(probe, { headers: { apikey: anonKey }, signal: AbortSignal.timeout(8000) });
      if (res.status >= 500) throw new Error(`HTTP ${res.status}`);
    } catch (e) {
      throw new Error(
        `Supabase local não está respondendo em ${probe} (${e instanceof Error ? e.message : e}).\n` +
          "Suba o banco com `npm run db:start` (Docker precisa estar rodando) e rode `npm test` de novo.",
      );
    }
  }
}

async function tokenStillValid(url: string, anonKey: string, t: SessionTokens): Promise<boolean> {
  if (t.expiresAt - Date.now() / 1000 < 900) return false; // menos de 15 min de vida
  try {
    const res = await fetch(`${url}/auth/v1/user`, {
      headers: { apikey: anonKey, Authorization: `Bearer ${t.accessToken}` },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return false;
    const body = (await res.json()) as { id?: string };
    return body.id === t.userId;
  } catch {
    return false;
  }
}

async function signInAll(world: World): Promise<SessionMap> {
  const env = loadEnv();
  const cached = readCache();
  const useCache = cached.url === env.url;
  const out = {} as SessionMap;
  let fresh = 0;

  for (const key of ACCOUNT_KEYS as AccountKey[]) {
    const prior = useCache ? cached.sessions[key] : undefined;
    if (prior && prior.userId === world.users[key].id && (await tokenStillValid(env.url, env.anonKey, prior))) {
      out[key] = prior;
      continue;
    }
    const client = createClient(env.url, env.anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
    const { data, error } = await client.auth.signInWithPassword({ email: ACCOUNTS[key].email, password: TEST_PASSWORD });
    if (error || !data.session) {
      throw new Error(`signInWithPassword falhou para ${ACCOUNTS[key].email}: ${error?.message}`);
    }
    out[key] = {
      accessToken: data.session.access_token,
      refreshToken: data.session.refresh_token,
      expiresAt: data.session.expires_at ?? Math.floor(Date.now() / 1000) + 3000,
      userId: data.user.id,
    };
    fresh++;
  }
  if (fresh) writeCache(env.url, out);
  return out;
}

export default async function setup({ provide }: ProvideApi) {
  const env = loadEnv();
  assertLocalUrl(env.url);
  await assertSupabaseUp(env.url, env.anonKey);
  const world = await seedDev({ quiet: true });
  const sessions = await signInAll(world);
  provide("world", world);
  provide("sessions", sessions);
}
